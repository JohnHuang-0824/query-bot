/**
 * 三個模組共用 ruling.db 時的建表與遷移 —— 用臨時檔，不碰 db/、不連網路。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensure_alias_schema } from '../ygo-alias-schema.mjs';

const dir = mkdtempSync(join(tmpdir(), 'schema-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let serial = 0;
const fresh_path = () => join(dir, `${++serial}.db`);

/**
 * 依指定順序讓三個模組在同一個資料庫上建表。網址帶不同的參數，同一個行程裡
 * 也能重新載入模組、重跑它的建表。別名那邊直接呼叫函式（載入整個模組要卡表）。
 */
async function load(path, order) {
	process.env.YGO_RULES_DB = path;
	process.env.YGO_RULING_DB = path;
	for (const name of order) {
		if (name === 'alias') {
			const db = new DatabaseSync(path);
			ensure_alias_schema(db);
			db.close();
		}
		else
			await import(`../ygo-${name}.mjs?${serial}`);
	}
}

function columns(path, table) {
	const db = new DatabaseSync(path, { readOnly: true });
	const out = db.prepare('SELECT name, "notnull" AS required FROM pragma_table_info(?)').all(table);
	db.close();
	return new Map(out.map(c => [c.name, Boolean(c.required)]));
}

function assert_complete(path) {
	assert.ok(columns(path, 'card_alias').has('status'), 'card_alias');
	assert.equal(columns(path, 'ruling').get('answer'), false, 'ruling.answer 要可為空');
	assert.ok(columns(path, 'card_fetch').has('complete'), 'card_fetch');
	assert.ok(columns(path, 'rule_section').has('body'), 'rule_section');
}

const ORDERS = [
	['alias', 'rules', 'ruling'], ['alias', 'ruling', 'rules'],
	['rules', 'alias', 'ruling'], ['rules', 'ruling', 'alias'],
	['ruling', 'alias', 'rules'], ['ruling', 'rules', 'alias'],
];

for (const order of ORDERS) {
	test(`空資料庫，載入順序 ${order.join(' → ')}：表都建得起來`, async t => {
		t.mock.method(console, 'log', () => {});
		const path = fresh_path();
		await load(path, order);
		assert_complete(path);
	});
}

/** 用舊版的樣子先建好，並塞一筆資料 */
function old_database(sql, user_version) {
	const path = fresh_path();
	const db = new DatabaseSync(path);
	db.exec(`${sql}; PRAGMA user_version = ${user_version};`);
	db.close();
	return path;
}

const one = (path, sql) => {
	const db = new DatabaseSync(path, { readOnly: true });
	const row = db.prepare(sql).get();
	db.close();
	return row;
};

test('已經壞掉的資料庫（版本號 4、沒有別名表）：自己修好', async t => {
	t.mock.method(console, 'log', () => {});
	const path = old_database('CREATE TABLE rule_meta (key TEXT PRIMARY KEY, value TEXT)', 4);
	await load(path, ['alias']);
	assert.ok(columns(path, 'card_alias').has('status'));
});

test('舊版別名表：補欄位，原有的俗稱仍然算數', async t => {
	t.mock.method(console, 'log', () => {});
	const path = old_database(`
		CREATE TABLE card_alias (norm TEXT NOT NULL, card_id INTEGER NOT NULL, raw TEXT NOT NULL,
			kind TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (norm, card_id));
		INSERT INTO card_alias VALUES ('g', 1, 'G', 'community', 0)`, 4);
	await load(path, ['alias']);
	assert.equal(one(path, 'SELECT status FROM card_alias').status, 'approved');
});

test('舊版裁定表：版本號已經被別的模組寫大也照樣遷移，資料留著', async t => {
	t.mock.method(console, 'log', () => {});
	const path = old_database(`
		CREATE TABLE ruling (fid INTEGER PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL,
			updated_at TEXT, fetched_at INTEGER NOT NULL);
		CREATE TABLE card_fetch (cid INTEGER PRIMARY KEY, fetched_at INTEGER NOT NULL, total INTEGER NOT NULL);
		INSERT INTO ruling VALUES (1, '問', '答', '2026-01-01', 0);
		INSERT INTO card_fetch VALUES (5, 0, 1)`, 4);
	await load(path, ['ruling']);
	assert.equal(columns(path, 'ruling').get('answer'), false);
	assert.equal(one(path, 'SELECT answer FROM ruling WHERE fid = 1').answer, '答');
	assert.equal(one(path, 'SELECT complete FROM card_fetch WHERE cid = 5').complete, 1);
});
