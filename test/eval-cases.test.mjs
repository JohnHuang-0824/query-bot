/**
 * 評測集本身的檢查 —— 不連模型。
 *
 * 作答結論是「可以」的題目，must_contain 只比對「可以」兩個字，而「不可以」也命中。
 * 擋相反結論靠 must_not_conclude 的正規表達式，這裡驗它們：
 * 擋得住相反結論、又不會誤擋 gold 與正確的說法。
 *
 * ⚠️ 改了這幾題的 must_not_conclude 就要跑這個。評測跑出誤擋或漏擋時，
 *    把那句實際回答加進下面的樣本。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { cases } = JSON.parse(readFileSync(new URL('../eval/rules-cases.json', import.meta.url), 'utf8'));
const by_id = id => cases.find(c => c.id === id);
const blocked = (id, answer) => by_id(id).expect.must_not_conclude.some(re => new RegExp(re).test(answer));

const SAMPLES = {
	'rules-004': {
		wrong: [
			// 實跑過的錯誤回答（引規則 241 得出相反結論）
			'在結束階段，當兩個效果同時滿足發動條件時，回合玩家不能選擇先發動「閃刀姬-零空②」。',
			'必須按照規則中規定的順序，即必發效果優先於選發效果發動。',
			'無法先發動選發效果。',
			'回合玩家必須先發動必發效果。',
			'此時只能先發動必發效果。',
		],
		right: [
			'回合玩家可以先發動選發效果，必發效果可以之後再處理。',
			'必發效果並不優先，回合玩家可以選擇先發動閃刀姬-零空②。',
		],
	},
	'rules-008': {
		wrong: [
			'不能。對方在這個結束階段沒有發動的機會。',
			'因此對方不能在這個結束階段發動冰劍龍的③效果。',
			'非回合玩家無法再發動。',
		],
		right: [
			'可以。非回合玩家在步驟7仍可發動必發效果。',
			'回合玩家放棄優先權之後，非回合玩家可以發動。',
		],
	},
	'rules-009': {
		wrong: [
			'不能適用代替破壞。',
			'炎王の聖域②的代替破壞無法使用。',
			'這個情況無法適用代替破壞，兩張卡都被破壞。',
			'可以適用，但場地魔法也會被破壞。',
		],
		right: [
			'可以適用代替破壞。結果炎王的聖域被破壞，場地魔法留在場上。',
			'可以適用。場地魔法不會被破壞，代替破壞不能指定已確定被破壞的卡。',
		],
	},
	'rules-010': {
		wrong: [
			'不能再發動。',
			'因此這回合無法再發動效果。',
			'這回合不能再發動效果。',
			'發動被無效的場合仍然計數。',
		],
		right: [
			'可以再發動1次。發動被無效的場合不會計數。',
			'可以再發動1次；用掉之後，這回合不能再發動第二次。',
		],
	},
	'rules-011': {
		wrong: [
			'不能發動。',
			'放置P卡不算魔法卡的發動。',
			'因此②效果不能發動。',
			'這個行為不屬於卡的發動。',
			'在同縱列發動P卡時，無法觸發②效果。',
		],
		right: [
			'是的，可以發動②效果。',
			'可以。放置到P區域屬於卡的發動。',
			'可以發動。如果只是效果的發動而非卡的發動，則不能發動。',
		],
	},
};

// gold 是正確答案的一種寫法。它過不了的字串檢查，代表正確的回答也會被判失敗 ——
// rules-007／009／010 就這樣寫過（gold 寫「尚未開始適用」「不會計數」，檢查要的
// 卻是「尚未適用」「不計數」）。拒答題的 gold 是在描述預期行為，不是答案，不檢查。
test('評測集：每題的 gold 通過自己的字串檢查', () => {
	const bad = [];
	for (const c of cases) {
		const e = c.expect ?? {};
		if (!c.gold || e.must_refuse === true)
			continue;
		for (const w of e.must_contain ?? []) {
			if (!c.gold.includes(w))
				bad.push(`${c.id} 缺「${w}」`);
		}
		for (const group of e.must_contain_any ?? []) {
			if (!group.some(w => c.gold.includes(w)))
				bad.push(`${c.id} 缺（任一）「${group.join('」「')}」`);
		}
		for (const w of e.must_not_contain ?? []) {
			if (c.gold.includes(w))
				bad.push(`${c.id} 含禁用字眼「${w}」`);
		}
	}
	assert.deepEqual(bad, []);
});

test('評測集：結論是「可以」的作答題都有擋相反結論的規則', () => {
	const positive = cases.filter(c => c.expect?.must_contain?.includes('可以')).map(c => c.id);
	assert.deepEqual(positive.sort(), Object.keys(SAMPLES).sort());
	for (const id of positive)
		assert.ok(by_id(id).expect.must_not_conclude?.length, `${id} 沒有 must_not_conclude`);
});

for (const [id, s] of Object.entries(SAMPLES)) {
	test(`${id}：相反結論會被擋`, () => {
		for (const a of s.wrong)
			assert.ok(blocked(id, a), `沒擋到：${a}`);
	});
	test(`${id}：gold 與正確說法不會被誤擋`, () => {
		for (const a of [by_id(id).gold, ...s.right])
			assert.ok(!blocked(id, a), `誤擋：${a}`);
	});
}
