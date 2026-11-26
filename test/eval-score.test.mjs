/**
 * 回答評分與離線重算 —— 不連模型，也不載入卡表。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score_answer } from '../eval/score.mjs';

const answered = (answer, more = {}) => ({ answer, refused: false, ...more });
const refused = (answer, reason = 'model') => ({ answer, refused: true, reason });

test('作答題拒答只報拒答，不再比對必要內容與結論', () => {
	const c = { expect: { must_contain: ['可以'], must_not_conclude: ['可以'] } };
	const bad = score_answer(c, refused('查無依據：是否可以發動不明。'));
	assert.equal(bad.length, 1);
	assert.match(bad[0], /不該拒答卻拒答了（原因：模型自己拒答）/);
});

test('拒答題給了結論算失敗；沒有必要內容的題目可以拒答', () => {
	assert.deepEqual(score_answer({ expect: { must_refuse: true } }, answered('可以')), ['預期拒答，實際給了結論']);
	assert.deepEqual(score_answer({ expect: { must_refuse: true } }, refused('查無')), []);
	assert.deepEqual(score_answer({ expect: { must_not_conclude: ['^可以'] } }, refused('查無')), []);
});

test('字串、長度、引用章節與編造引用', () => {
	const c = { expect: { must_contain: ['不能'], must_contain_any: [['cost', '代價']], must_not_contain: ['推測'], max_chars: 20, cites: ['卡的发动'] } };
	assert.deepEqual(score_answer(c, answered('不能，付不出代價。'), ['文本 › 卡的发动']), []);
	const bad = score_answer(c, answered('推測可以，這個回答故意寫得比長度上限的二十個字還要長。', { dropped: ['rule:999'] }), ['连锁规则']);
	for (const want of ['推測', '缺少必要內容「不能」', '以下任一', '超過上限', '沒引用到「卡的发动」', '編造了引用'])
		assert.ok(bad.some(b => b.includes(want)), `少了：${want}｜${bad.join('；')}`);
});

test('重算：後面的檔案蓋掉前面的，題目改過的跳過', () => {
	const { cases } = JSON.parse(readFileSync(new URL('../eval/rules-cases.json', import.meta.url), 'utf8'));
	const { id, question } = cases.find(c => c.id === 'rules-001');
	const dir = mkdtempSync(join(tmpdir(), 'rescore-'));
	const write = (name, results) => {
		const file = join(dir, name);
		writeFileSync(file, JSON.stringify({ settings: { relevance_check: false }, results }));
		return file;
	};
	const rescore = (...files) => spawnSync(process.execPath,
		[fileURLToPath(new URL('../eval/rescore.mjs', import.meta.url)), ...files], { encoding: 'utf8' });
	const base = { id, question, rule_paths: [], dropped: [] };
	try {
		const wrong = write('a.json', [{ ...base, ...answered('可以發動。') }]);
		const right = write('b.json', [{ ...base, ...answered('不能發動。大宇宙適用中無法送去墓地，cost 付不出來。') }]);
		const old = write('c.json', [{ ...base, question: '舊的題目', ...answered('可以發動。') }]);

		assert.equal(rescore(wrong).status, 1);
		const latest = rescore(wrong, right);
		assert.equal(latest.status, 0, latest.stdout + latest.stderr);
		assert.match(latest.stdout, /✓ rules-001/);
		assert.match(latest.stdout, /通過 1\u3000失敗 0/);
		assert.match(rescore(old).stdout, /rules-001 跳過：題目改過了/);
	}
	finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
