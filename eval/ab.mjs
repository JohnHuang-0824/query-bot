/**
 * 同一題、同一批依據，比較兩個版本的作答（第二段）。在**開發機上**跑，會自己
 * 啟動開發容器：
 *
 *   node eval/ab.mjs --new=ask-card-type --case=rules-007 \
 *     --sections=21,95,98,111,158,160 --cards=エンディミオン皇国,サイクロン --dry
 *
 *   --new=      要比較的版本（分支或 commit）
 *   --old=      對照版本，預設 master
 *   --case=     rules-cases.json 的題號
 *   --sections= 固定送進第二段的規則章節編號（跳過第一段）
 *   --cards=    固定的卡名，逗號分隔
 *   --runs=     兩邊各跑幾次，預設 5
 *   --dry       用假模型走一遍，不花額度、不寫結果檔。花額度之前先跑這個。
 *               --dry=error、--dry=quota、--dry=overload 模擬一般失敗、每日額度
 *               用完、模型過載（後兩種會停整輪）。
 *
 * 第一段跳過，所以一次作答只呼叫一次模型，總共 runs × 2 次。兩邊交替跑，
 * 每輪還交換先後，免得時段因素全落在同一邊。同一份提示詞本來就有時過有時
 * 不過，所以要兩邊一起跑、看次數，單次結果不能下結論。
 *
 * ⚠️ 只能比 ygo-answer.mjs 的差異：兩個版本共用工作目錄裡的其他模組。分支改了
 *    別的檔案（測試除外）會直接拒絕。
 * ⚠️ 章節編號會隨規則語料重新匯入而移動，跑之前看一下印出的章節名稱。
 * ⚠️ 會載入卡表，不要跟 bot、測試、評測同時跑。
 *
 * 結果存在 db/eval-runs/ab/（不進版控；rescore.mjs 不會讀子目錄）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const AB_DIR = new URL('../db/eval-runs/ab/', import.meta.url);
const SIDES = ['old', 'new'];
const copy_of = side => new URL(`ygo-answer.${side}.mjs`, AB_DIR);

const args = Object.fromEntries(process.argv.slice(2).map(a => {
	const [key, ...value] = a.replace(/^--/, '').split('=');
	return [key, value.length ? value.join('=') : true];
}));
const list = name => String(args[name] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const runs = Number(args.runs ?? 5);

function stop(message) {
	console.error(message);
	process.exit(2);
}

/** 開發機這一側：取出兩個版本的 ygo-answer.mjs，再到容器裡跑。 */
function host() {
	if (typeof args.new !== 'string' || typeof args.case !== 'string' || !list('sections').length)
		stop('要給 --new=、--case=、--sections=（說明見檔頭）');
	const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
	const ref = { old: typeof args.old === 'string' ? args.old : 'master', new: args.new };
	const base = git('merge-base', ref.old, ref.new).trim();
	const changed = side => git('diff', '--name-only', base, ref[side]).split('\n').filter(Boolean);
	const others = changed('new').filter(f => f !== 'ygo-answer.mjs' && !f.startsWith('test/'));
	if (others.length)
		stop(`${ref.new} 還改了別的檔案，這個比較不出來：${others.join('、')}`);
	if (changed('old').includes('ygo-answer.mjs'))
		stop(`${ref.old} 在分岔之後也改過 ygo-answer.mjs，先把 ${ref.new} 接到它後面再比`);

	const hashes = SIDES.map(side => git('rev-parse', '--short', ref[side]).trim());
	if (hashes[0] === hashes[1])
		stop('兩邊是同一個版本');

	mkdirSync(AB_DIR, { recursive: true });
	let status;
	try {
		for (const side of SIDES) {
			// 副本放在 db/eval-runs/ab/，匯入路徑改指回根目錄的模組
			const source = git('show', `${ref[side]}:ygo-answer.mjs`).replace(/(from\s+)'\.\//g, "$1'../../../");
			// 丟例外而不是 stop()：要讓下面的 finally 清掉副本
			if (/from\s+'\.\//.test(source))
				throw new Error('匯入路徑沒改乾淨');
			writeFileSync(copy_of(side), source);
		}
		console.log(`old = ${ref.old}（${hashes[0]}）  new = ${ref.new}（${hashes[1]}）`);
		status = spawnSync('docker', ['compose', '-f', 'docker-compose.dev.yml', 'run', '--rm', '--no-deps', '-T',
			'-e', 'GEMINI_RPM=5', 'bot', 'node', 'eval/ab.mjs', ...process.argv.slice(2),
			'--inside', `--hashes=${hashes.join(',')}`], { cwd: ROOT, stdio: 'inherit' }).status ?? 1;
	}
	finally {
		for (const side of SIDES)
			rmSync(copy_of(side), { force: true });
	}
	process.exit(status);
}

/** 容器這一側。 */
async function inside() {
	if (process.env.ASK_RELEVANCE_CHECK === '1')
		stop('ASK_RELEVANCE_CHECK 開著會多一次呼叫、混進另一個變因，先關掉');
	const { cases } = JSON.parse(readFileSync(new URL('./rules-cases.json', import.meta.url), 'utf8'));
	const c = cases.find(x => x.id === args.case);
	if (!c)
		stop(`rules-cases.json 沒有 ${args.case}`);

	const version = {};
	for (const side of SIDES)
		version[side] = await import(copy_of(side).href);
	const { generate } = await import('../ygo-llm.mjs');
	const { get_section } = await import('../ygo-rules.mjs');
	const { score_answer } = await import('./score.mjs');
	const { halt_reason } = await import('./halt.mjs');

	const sections = list('sections').map(Number);
	const missing = sections.filter(id => !get_section(id));
	if (missing.length)
		stop(`沒有這些章節：${missing.join(',')}`);
	console.log(`${c.id}：${c.question}`);
	console.log(`固定章節：${sections.map(id => `${id} ${get_section(id).path}`).join('｜')}`);
	console.log(`固定卡名：${list('cards').join('、') || '無'}  各跑 ${runs} 次${args.dry ? '（假模型，不花額度）' : `（共 ${runs * 2} 次呼叫）`}\n`);

	// 假模型只用來確認流程走得通：兩邊都回同一份引用規則的答案
	const failure = { error: '模擬的呼叫失敗', quota: '節流：每日上限（模擬）', overload: 'HTTP 503：模擬' }[args.dry];
	const fake = failure
		? { error: failure }
		: { text: JSON.stringify({ refused: false, answer: '不能適用，尚未適用。', cites: [{ type: 'rule', id: sections[0], sents: [`R${sections[0]}-1`] }] }) };
	const settings = {
		case: c.id, sections, cards: list('cards'), hashes: list('hashes'),
		gemini_model: process.env.GEMINI_MODEL || null,
	};
	const file = new URL(`${c.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, AB_DIR);
	const results = [];
	// 每日配額用完或模型過載就停（見 halt.mjs）
	let halted = null;

	for (let run = 1; run <= runs && !halted; run++) {
		// 單數輪 old 先、雙數輪 new 先
		for (const side of run % 2 ? SIDES : [...SIDES].reverse()) {
			let has_kind = null;
			const r = await version[side].answer_question(c.question, {
				allow_fetch: false, wait_for_slot: true, force_sections: sections, force_cards: list('cards'),
				gen_fn: async (prompt, opts) => {
					has_kind = prompt.includes('卡片種類：');
					return args.dry ? fake : generate(prompt, opts);
				},
			});
			const record = { run, side, has_kind, rulings_sent: r.debug?.rulings, ...(r.error ? { error: r.error } : {}) };
			if (r.error) {
				record.outcome = '呼叫失敗';
				halted = halt_reason(r.error);
			}
			else {
				const rule_paths = r.rule_ids.map(id => get_section(id)?.path ?? '');
				const bad = score_answer(c, r, rule_paths);
				Object.assign(record, {
					outcome: !bad.length ? '通過' : r.refused ? '拒答' : '沒通過',
					bad, answer: r.answer, refused: r.refused, reason: r.reason,
					rule_ids: r.rule_ids, ruling_fids: r.ruling_fids, quotes: r.quotes, dropped: r.dropped,
					fabricated: r.fabricated, raw_answer: r.raw_answer,
				});
			}
			results.push(record);
			if (!args.dry)
				writeFileSync(file, JSON.stringify({ settings, results }, null, '\t'));
			console.log(`第 ${run} 輪 ${side}（${has_kind ? '有' : '無'}卡片種類）：${record.outcome}${r.error ? `  ${r.error}` : ''}`);
			if (!r.error) {
				console.log(`  ${r.answer.replace(/\s+/g, ' ')}`);
				if (r.raw_answer)
					console.log(`  被作廢的原始回答  ${r.raw_answer.replace(/\s+/g, ' ')}`);
				console.log(`  引用 規則[${r.rule_ids.join(',') || '無'}] 裁定[${r.ruling_fids.join(',') || '無'}]${record.outcome === '沒通過' ? `  ${record.bad.join('；')}` : ''}`);
			}
			if (halted)
				break;
		}
	}

	const evidence = new Set(results.map(x => x.rulings_sent?.join(',') || '無'));
	console.log(`\n送出的裁定：${[...evidence].join('／')}${evidence.size > 1 ? '  ⚠️ 兩次之間不一樣' : ''}`);
	for (const side of SIDES) {
		const mine = results.filter(x => x.side === side);
		const counts = ['通過', '拒答', '沒通過', '呼叫失敗'].map(o => `${o} ${mine.filter(x => x.outcome === o).length}`);
		console.log(`${side}：${counts.join('、')}`);
		// 副本拿錯版本的話整個比較就沒意義了，直接檢查送出去的提示詞
		if (mine.some(x => x.has_kind !== (side === 'new')))
			console.log(`⚠️ ${side} 送出的提示詞${side === 'new' ? '沒有' : '帶了'}卡片種類 —— 如果要比的不是這個差異可以忽略`);
	}
	if (halted)
		console.log(`⚠️ ${halted}，沒跑完。兩邊次數可能不一樣，比較時要看清楚。`);
	console.log(args.dry ? '假跑，沒有寫結果檔' : `存在 db/eval-runs/ab/${file.pathname.split('/').pop()}`);
	process.exit(0);
}

if (args.inside)
	await inside();
else
	host();
