/**
 * 用存下來的回答重算分數，不呼叫模型。改了 rules-cases.json 或 score.mjs 之後用。
 *
 *   node eval/rescore.mjs                     db/eval-runs/ 裡的全部
 *   node eval/rescore.mjs a.json b.json       指定檔案
 *
 * 同一題出現在多個檔案時用最後讀到的；不指定檔案時照檔名排序，檔名是時間，
 * 所以是新的蓋舊的。不載入卡表、不連外，bot 開著也能跑。
 *
 * ⚠️ 重算的只有評分。回答是當時的模型、依據和設定產生的，那些改了要重跑
 *    run.mjs --llm。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score_answer } from './score.mjs';

const RUN_DIR = fileURLToPath(new URL('../db/eval-runs/', import.meta.url));

const files = process.argv.length > 2
	? process.argv.slice(2)
	: existsSync(RUN_DIR)
		? readdirSync(RUN_DIR).filter(f => f.endsWith('.json')).sort().map(f => join(RUN_DIR, f))
		: [];
if (!files.length) {
	console.error('沒有可以重算的檔案。node eval/run.mjs --llm 跑過之後會存在 db/eval-runs/。');
	process.exit(2);
}

const load = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')).cases;
const cases = new Map([...load('./cases.json'), ...load('./rules-cases.json')].map(c => [c.id, c]));

/** id -> { saved, settings, file } */
const latest = new Map();
for (const file of files) {
	const run = JSON.parse(readFileSync(file, 'utf8'));
	for (const saved of run.results)
		latest.set(saved.id, { saved, settings: run.settings ?? {}, file: basename(file) });
}

const count = { pass: 0, fail: 0, known: 0, skip: 0 };
const used_settings = new Set();
for (const id of [...latest.keys()].sort()) {
	const { saved, settings, file } = latest.get(id);
	const c = cases.get(id);
	if (!c || c.question !== saved.question) {
		count.skip++;
		console.log(`  – ${id} 跳過：${c ? '題目改過了，這是舊題目的回答' : '評測集裡沒有這題了'}（${file}）`);
		continue;
	}
	used_settings.add(`相關性檢查${settings.relevance_check ? '開' : '關'}、模型 ${settings.gemini_model ?? '預設'}`);
	const bad = score_answer(c, saved, saved.rule_paths);
	if (!bad.length) {
		count.pass++;
		console.log(`  ✓ ${id}`);
	}
	else if (c.known_fail) {
		count.known++;
		console.log(`  △ ${id} —— 已知失敗（${c.known_fail}）：${bad.join('；')}`);
	}
	else {
		count.fail++;
		console.log(`  ✗ ${id} —— ${bad.join('；')}`);
	}
}

console.log(`\n通過 ${count.pass}\u3000失敗 ${count.fail}\u3000已知失敗 ${count.known}\u3000跳過 ${count.skip}（讀了 ${files.length} 個檔）`);
if (used_settings.size > 1)
	console.log(`⚠️ 這些回答的設定不一樣，不要混著比：${[...used_settings].join('／')}`);
process.exit(count.fail ? 1 : 0);
