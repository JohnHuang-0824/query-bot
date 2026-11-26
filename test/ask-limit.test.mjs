/**
 * /ask 的每人次數 —— 不載入卡表、不連網路，計數開在記憶體。
 */

// ⚠️ 一定要是第一個 import：下面的模組一載入就開資料庫了。
import 'data:text/javascript,process.env.YGO_RULING_DB = ":memory:";';

import test from 'node:test';
import assert from 'node:assert/strict';
import { take_ask_slot, PER_MINUTE } from '../ygo-ask-limit.mjs';
import { stats } from '../ygo-throttle.mjs';

const today = key => stats(key).last_day;
const taken = (user, per_day) => {
	const slot = take_ask_slot(user, per_day);
	assert.equal(slot.blocked, null);
	return slot;
};

test('有回覆的提問算次數，到每日上限就擋', () => {
	taken('a', 2);
	taken('a', 2);
	assert.equal(take_ask_slot('a', 2).blocked, '每日上限 2');
});

test('失敗退回每日次數，但一天最多退同樣次數', () => {
	assert.equal(taken('b', 1).refund(), true);
	assert.equal(today('user:b'), 0);
	// 退回過一次了，第二次失敗照算
	assert.equal(taken('b', 1).refund(), false);
	assert.equal(take_ask_slot('b', 1).blocked, '每日上限 1');
});

test('每分鐘的限制連失敗一起算', () => {
	for (let i = 0; i < PER_MINUTE; i++)
		assert.equal(taken('c', 10).refund(), true);
	assert.equal(take_ask_slot('c', 10).blocked, `每分鐘上限 ${PER_MINUTE}`);
	assert.equal(today('user:c'), 0);
});

test('同一次提問只能退一次，不會刪到別次的紀錄', () => {
	const first = taken('d', 5);
	taken('d', 5);
	assert.equal(first.refund(), true);
	assert.equal(first.refund(), false);
	assert.equal(today('user:d'), 1);
	assert.equal(today('user-fail:d'), 1);
});

test('不限制時沒有每日上限，每分鐘的照舊', () => {
	for (let i = 0; i < PER_MINUTE; i++)
		taken('e', 0);
	assert.equal(take_ask_slot('e', 0).blocked, `每分鐘上限 ${PER_MINUTE}`);
});
