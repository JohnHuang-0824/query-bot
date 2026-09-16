/**
 * 評測集跑測器。
 *
 *   docker compose -f docker-compose.dev.yml exec -T bot node eval/run.mjs
 *   docker compose -f docker-compose.dev.yml exec -T bot node eval/run.mjs --fetch
 *
 * ⚠️ **預設完全不連外。** 沒快取的題目直接跳過並說明原因 ——
 *    評測會反覆跑，每跑一次就打一輪官方站正好是「大量自動化存取」。
 *    第一次用 --fetch 把資料抓進快取，之後就不必了。
 *
 * ⚠️ 這裡測的是**檢索層**，不是 Discord 層。指令的呈現另外用眼睛看。
 */

import { readFileSync } from 'node:fs';
import { suggest, resolve_id, display_name } from '../ygo-alias.mjs';
import { get_card } from '../ygo-query.mjs';
import { cache_state, fetch_rulings, get_common_rulings } from '../ygo-ruling.mjs';
import { answer_question } from '../ygo-answer.mjs';
import { get_section } from '../ygo-rules.mjs';

const ALLOW_FETCH = process.argv.includes('--fetch');

// ⚠️ 呼叫模型要明確開啟。一輪 15 題就是 30 次 Gemini 呼叫，加上節流至少
//    四五分鐘，還吃免費層配額。預設只跑不花錢的結構檢查，這樣「改完跑一下」
//    才會真的變成習慣 —— 要錢又要等的檢查，人就不會跑。
const ALLOW_LLM = process.argv.includes('--llm');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const answers = [];
const spec = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const rules_spec = JSON.parse(readFileSync(new URL('./rules-cases.json', import.meta.url), 'utf8'));
const all_cases = [...spec.cases, ...rules_spec.cases];

const results = { pass: 0, fail: 0, skip: 0, draft: 0, manual: 0 };
// 一旦撞到每日配額就記下來，後面的題目直接跳過，不再送請求。
let quota_dead = '';
const failures = [];
const manual_review = [];

function name_of(id) {
	return display_name(id);
}

function check(c, ok, detail) {
	if (ok) {
		results.pass++;
		console.log(`  ✓ ${c.id}`);
	}
	else {
		results.fail++;
		failures.push({ id: c.id, detail, why: c.why });
		console.log(`  ✗ ${c.id} —— ${detail}`);
	}
}

function skip(c, reason) {
	results.skip++;
	console.log(`  – ${c.id} 跳過：${reason}`);
}

async function run_alias(c) {
	const id = resolve_id(c.input);
	const cands = suggest(c.input);

	if (c.expect.none)
		return check(c, id === null && cands.length === 0, `預期完全不命中，實際 id=${id} 候選=${cands.length}`);

	if (c.expect.ambiguous) {
		const names = cands.map(x => x.name);
		const has = (c.expect.candidates_include ?? []).every(n => names.some(x => x.includes(n)));
		const enough = cands.length >= (c.expect.min_candidates ?? 2);
		return check(c, id === null && has && enough,
			`預期歧義（resolve=null、候選含 ${c.expect.candidates_include}），實際 id=${id} 候選${cands.length}筆 ${names.slice(0, 4)}`);
	}

	if (id === null)
		return check(c, false, `解析不到，候選=${cands.slice(0, 3).map(x => x.name)}`);
	const actual = name_of(id);
	return check(c, actual === c.expect.name, `預期「${c.expect.name}」，實際「${actual}」`);
}

async function run_intersect(c) {
	const ids = c.cards.map(n => resolve_id(n));
	if (ids.some(x => x === null))
		return skip(c, `卡名解析不到：${c.cards.filter((_, i) => ids[i] === null)}`);

	const cards = ids.map(get_card);
	if (cards.some(x => !x?.cid))
		return skip(c, '卡片沒有官方資料庫編號');

	for (const card of cards) {
		if (!cache_state(card.cid).fetched) {
			if (!ALLOW_FETCH)
				return skip(c, `「${display_name(card.id)}」未快取，加 --fetch 抓一次`);
			await fetch_rulings(card.cid);
		}
	}

	const common = get_common_rulings(cards[0].cid, cards[1].cid);
	const fids = common.map(r => r.fid);

	if (c.expect.empty)
		return check(c, fids.length === 0, `預期查無，實際 ${fids.length} 條 ${fids.slice(0, 5)}`);

	if (c.expect.max_results !== undefined && fids.length > c.expect.max_results)
		return check(c, false, `結果過多：${fids.length} 條（上限 ${c.expect.max_results}）—— 關聯可能被污染了`);

	const need = c.expect.fids ?? [];
	const missing = need.filter(f => !fids.includes(f));
	return check(c, missing.length === 0, `缺少 fid ${missing}，實際 ${fids.slice(0, 8)}`);
}

/**
 * 該拒答的有沒有拒答。
 *
 * ⚠️ 這一類**現在就跑得動**，而且是全套裡最重要的 —— 查無裁定時模型
 *    最想幫忙，也最容易把推論講成事實。
 */
async function run_refuse(c) {
	// 拒答題有兩種形狀：
	//   cards  兩張卡 —— 檢查檢索層是否回空，現在就跑得動
	//   question 一個問題 —— 要檢查真正的回覆文字，第 4 階段才跑得動
	//
	// ⚠️ question 形狀才是真正在測的東西（使用者看到的行為），cards
	//    形狀只是它的代理指標。所以第 4 階段一定要把 question 那條路做完，
	//    不要因為 cards 那條有在跑就以為測到了。
	if (!c.cards)
		return c.question ? run_rules(c) : skip(c, '既沒有 cards 也沒有 question');

	const ids = c.cards.map(n => resolve_id(n));
	if (ids.some(x => x === null))
		return skip(c, `卡名解析不到：${c.cards.filter((_, i) => ids[i] === null)}`);
	const cards = ids.map(get_card);
	if (cards.some(x => !x?.cid))
		return skip(c, '卡片沒有官方資料庫編號');

	for (const card of cards) {
		if (!cache_state(card.cid).fetched) {
			if (!ALLOW_FETCH)
				return skip(c, `「${display_name(card.id)}」未快取，加 --fetch 抓一次`);
			await fetch_rulings(card.cid);
		}
	}
	const common = get_common_rulings(cards[0].cid, cards[1].cid);
	// 檢索層該回空，指令層才會走拒答路徑。第 4 階段接上 LLM 之後，
	// must_not_contain 要改成檢查真正的回覆文字。
	return check(c, common.length === 0,
		`預期查無共同裁定（才會觸發拒答），實際 ${common.length} 條 ${common.slice(0, 3).map(r => r.fid)}`);
}

/**
 * 流程／時點題。
 *
 * ⚠️ 要第 4 階段接上規則語料與 Gemini 才跑得動 —— 在那之前一律跳過，
 *    **不要假裝通過**。一個永遠綠燈的測試比沒有測試更危險。
 */
async function run_rules(c) {
	if (!ALLOW_LLM)
		return skip(c, '需要 --llm（會呼叫 Gemini）');
	// ⚠️ 配額用完之後就不要再打了。第一版會把剩下的題目一題一題送進去
	//    撞 429，於是報表上十幾個「作答失敗」看起來像模型壞掉，實際上
	//    是同一件事發生了十幾次 —— 而且每一次都真的送了請求出去。
	if (quota_dead)
		return skip(c, `今日配額已用完，未呼叫（${quota_dead}）`);

	const r = await answer_question(c.question, { allow_fetch: ALLOW_FETCH, wait_for_slot: true });
	if (r.error) {
		if (/429|每日上限/.test(r.error))
			quota_dead = r.error;
		return skip(c, `作答失敗：${r.error}`);
	}

	answers.push({ id: c.id, question: c.question, gold: c.gold, r });

	const e = c.expect ?? {};
	const bad = [];

	if (e.must_refuse === true && !r.refused)
		bad.push('預期拒答，實際給了結論');
	if (e.must_refuse === false && r.refused)
		bad.push('不該拒答卻拒答了');

	for (const w of e.must_not_contain ?? []) {
		if (r.answer.includes(w))
			bad.push(`出現禁用字眼「${w}」`);
	}
	for (const w of e.must_contain ?? []) {
		if (!r.answer.includes(w))
			bad.push(`缺少必要內容「${w}」`);
	}
	if (e.max_chars && r.answer.length > e.max_chars)
		bad.push(`回答 ${r.answer.length} 字，超過上限 ${e.max_chars}`);

	// 期望引用到的章節：比對實際引用章節的路徑
	const paths = r.rule_ids.map(id => get_section(id)?.path ?? '').join(' | ');
	for (const want of e.cites ?? []) {
		if (!paths.includes(want))
			bad.push(`沒引用到「${want}」，實際引用：${paths || '無'}`);
	}

	// ⚠️ 模型編造引用是重大缺陷，不是小瑕疵 —— 管線雖然已經把它丟掉了，
	//    但它發生過這件事本身就要讓這題紅燈。
	if (r.dropped?.length)
		bad.push(`模型編造了引用：${r.dropped.join(' ')}`);

	return check(c, bad.length === 0, bad.join('；'));
}

console.log(`評測集：${all_cases.length} 題${ALLOW_FETCH ? '（允許連外抓取）' : '（純快取，不連外）'}\n`);

for (const c of all_cases) {
	if (ONLY && !c.id.includes(ONLY))
		continue;
	if (c.draft) {
		results.draft++;
		continue;
	}
	if (c.manual) {
		results.manual++;
		manual_review.push(c);
		continue;
	}
	try {
		if (c.kind === 'alias')
			await run_alias(c);
		else if (c.kind === 'intersect' || c.kind === 'empty')
			await run_intersect(c);
		else if (c.kind === 'refuse')
			await run_refuse(c);
		else if (c.kind === 'rules')
			await run_rules(c);
		else
			skip(c, `未知題型 ${c.kind}`);
	}
	catch (err) {
		// 跑測器不該因為一題寫壞就整輪停掉 —— 那樣後面的題目全部看不到。
		results.fail++;
		failures.push({ id: c.id, detail: `跑測時丟出例外：${err.message}`, why: c.why });
		console.log(`  ✗ ${c.id} —— 例外：${err.message}`);
	}
}

console.log(`
通過 ${results.pass}　失敗 ${results.fail}　跳過 ${results.skip}　草稿 ${results.draft}　待人工 ${results.manual}`);

if (quota_dead) {
	console.log(`
⚠️ 這一輪沒跑完：${quota_dead}
   免費層是每天 20 次請求、一題兩次呼叫，所以一天最多跑十題。
   配額在**太平洋時間午夜**歸零（台灣時間下午 3 點或 4 點，看有沒有日光節約）。
   續跑用 --only=，例如：node eval/run.mjs --llm --fetch --only=rules-00`);
}

if (results.draft)
	console.log(`有 ${results.draft} 題還是草稿（draft: true）—— 那些不算數，填好內容後把那一行拿掉。`);

if (manual_review.length) {
	console.log('');
	console.log('待人工判讀（機器驗不了，要自己看）：');
	for (const c of manual_review) {
		console.log(`  ${c.id}`);
		if (c.question)
			console.log(`    問：${c.question}`);
		if (c.gold)
			console.log(`    標準答案：${c.gold}`);
	}
}

if (answers.length) {
	console.log('');
	console.log('=== 回答內容（跟 gold 對照，機器判不了這部分）===');
	for (const a of answers) {
		console.log(`--- ${a.id}`);
		console.log(`  問  ${a.question}`);
		console.log(`  答  ${a.r.answer.split(String.fromCharCode(10)).join(' ')}`);
		console.log(`  引用 規則[${a.r.rule_ids.join(',') || '無'}] 裁定[${a.r.ruling_fids.join(',') || '無'}] 拒答=${a.r.refused}`);
		if (a.gold)
			console.log(`  gold ${a.gold.split(String.fromCharCode(10)).join(' ')}`);
	}
}

if (failures.length) {
	console.log('\n失敗細節：');
	for (const f of failures)
		console.log(`  ${f.id}\n    ${f.detail}\n    這題在測：${f.why ?? '（沒寫 why —— 補上，否則之後沒人知道它為什麼存在）'}`);
}
process.exit(results.fail ? 1 : 0);
