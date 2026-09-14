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

const ALLOW_FETCH = process.argv.includes('--fetch');
const spec = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));

const results = { pass: 0, fail: 0, skip: 0 };
const failures = [];

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

console.log(`評測集：${spec.cases.length} 題${ALLOW_FETCH ? '（允許連外抓取）' : '（純快取，不連外）'}\n`);

for (const c of spec.cases) {
	if (c.kind === 'alias')
		await run_alias(c);
	else if (c.kind === 'intersect' || c.kind === 'empty')
		await run_intersect(c);
	else
		skip(c, `未知題型 ${c.kind}`);
}

console.log(`\n通過 ${results.pass}　失敗 ${results.fail}　跳過 ${results.skip}`);

if (failures.length) {
	console.log('\n失敗細節：');
	for (const f of failures)
		console.log(`  ${f.id}\n    ${f.detail}\n    這題在測：${f.why ?? '（沒寫 why —— 補上，否則之後沒人知道它為什麼存在）'}`);
}
process.exit(results.fail ? 1 : 0);
