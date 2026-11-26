/**
 * 規則語料匯入的保護 —— 語料開在記憶體，不碰 db/、不連網路。
 */

// ⚠️ 一定要是第一個 import：下面的模組一載入就開資料庫了。
import 'data:text/javascript,process.env.YGO_RULES_DB = ":memory:";';

import test from 'node:test';
import assert from 'node:assert/strict';
import { import_sections, corpus_state, get_section } from '../ygo-rules.mjs';

const section = (title, chars = 100) => ({
	file: 'a.rst', title, path: title, level: 1, body: '文'.repeat(chars), chars,
});
const corpus = (count, prefix = '舊', chars = 100) =>
	Array.from({ length: count }, (_, i) => section(`${prefix}${i}`, chars));

/** 每個測試從同一份 10 節 / 1000 字的語料開始 */
const reset = () => import_sections(corpus(10), { force: true });

const unchanged = () => {
	assert.equal(corpus_state().sections, 10);
	assert.equal(corpus_state().chars, 1000);
	assert.equal(get_section(1).title, '舊0');
};

test('第一次匯入（原本是空的）直接寫入', () => {
	assert.equal(corpus_state().sections, 0);
	assert.equal(import_sections(corpus(3)).sections, 3);
});

test('解析出 0 節：中止，加 force 也一樣', () => {
	reset();
	assert.throws(() => import_sections([]), /0 節/);
	assert.throws(() => import_sections([], { force: true }), /0 節/);
	unchanged();
});

test('節數少兩成以上：中止並保留原本的', () => {
	reset();
	assert.throws(() => import_sections(corpus(7, '新', 200)), /少太多/);
	unchanged();
});

test('節數沒少、字數少兩成以上（內文解析壞了）：中止', () => {
	reset();
	assert.throws(() => import_sections(corpus(10, '新', 70)), /少太多/);
	unchanged();
});

test('小幅減少照常匯入', () => {
	reset();
	assert.equal(import_sections(corpus(9, '新')).sections, 9);
	assert.equal(get_section(1).title, '新0');
});

test('force：確認過的話可以匯入少很多的語料', () => {
	reset();
	assert.equal(import_sections(corpus(2, '新'), { force: true }).sections, 2);
});

test('寫到一半失敗：整批退回，之後還能正常匯入', () => {
	reset();
	const before = corpus_state().imported_at;
	const broken = corpus(10, '新');
	broken[5].title = null;	// 欄位是 NOT NULL
	assert.throws(() => import_sections(broken));
	unchanged();
	assert.equal(corpus_state().imported_at, before);
	assert.equal(import_sections(corpus(10, '再')).sections, 10);
});
