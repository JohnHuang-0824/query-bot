/**
 * data/ 過期偵測 —— 用臨時做的小卡表，不碰 db/、不連網路。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hidden_cards, report_hidden_cards } from '../ygo-datacheck.mjs';

const TOKEN = 0x4000;
const MONSTER = 0x1;

/** 做一個只有偵測用得到的欄位的卡表。cards：[id, name, { cid, alias, type }] */
function card_db(t, cards) {
	const dir = mkdtempSync(join(tmpdir(), 'cdb-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, 'query.cdb');
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE datas (id INTEGER PRIMARY KEY, alias INTEGER, type INTEGER);
		CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT);
		CREATE TABLE extension (id INTEGER PRIMARY KEY, cid INTEGER);
	`);
	for (const [id, name, { cid, alias = 0, type = MONSTER } = {}] of cards) {
		db.prepare('INSERT INTO datas VALUES (?, ?, ?)').run(id, alias, type);
		db.prepare('INSERT INTO texts VALUES (?, ?)').run(id, name);
		if (cid)
			db.prepare('INSERT INTO extension VALUES (?, ?)').run(id, cid);
	}
	db.close();
	return path;
}

const NORMAL = [
	[10000000, '有編號的卡', { cid: 1 }],
	[10000001, '異畫', { alias: 10000000 }],
	[10000002, '衍生物', { type: MONSTER | TOKEN }],
	[100000001, '先行卡'],
];

const run = path => {
	const out = [];
	report_hidden_cards(path, m => out.push(m));
	return out;
};

test('hidden_cards：只算沒有編號的正式卡號', t => {
	const path = card_db(t, [...NORMAL, [20000000, '剛發售的卡'], [99999999, '邊界卡號']]);
	assert.deepEqual(hidden_cards(path).map(c => c.name), ['剛發售的卡', '邊界卡號']);
});

test('沒有查不到的卡就不出聲', t => {
	assert.deepEqual(run(card_db(t, NORMAL)), []);
});

test('有查不到的卡：一行警告，帶張數與卡名', t => {
	const out = run(card_db(t, [...NORMAL, [20000000, '剛發售的卡']]));
	assert.equal(out.length, 1);
	assert.match(out[0], /^\[資料\] 1 張卡/);
	assert.match(out[0], /（剛發售的卡）/);
	assert.match(out[0], /README_部署\.md/);
});

test('卡名只列前五張', t => {
	const many = Array.from({ length: 7 }, (_, i) => [20000000 + i, `新卡${i}`]);
	const [message] = run(card_db(t, many));
	assert.match(message, /7 張卡/);
	assert.match(message, /新卡4…/);
	assert.doesNotMatch(message, /新卡5/);
});

test('卡表開不了時只警告，不丟例外', () => {
	const out = run(join(tmpdir(), '不存在的目錄', 'query.cdb'));
	assert.equal(out.length, 1);
	assert.match(out[0], /無法檢查/);
});
