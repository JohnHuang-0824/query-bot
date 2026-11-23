/**
 * /ask 引用驗證的單元測試 —— 不連模型、不連網路。
 *
 *   docker compose -f docker-compose.dev.yml run --rm --no-deps --user root bot node --test test/
 *
 * ⚠️ 這些測的是「擋人的那一層」：模型編造、引錯條、宣稱有依據卻沒引用。
 *    改 verify_cites／mention_gaps／check_relevance 之後要先跑這個，
 *    再去花模型額度跑評測。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	split_sents, numbered, strip_marks, verify_cites, mention_gaps, check_relevance,
} from '../ygo-answer.mjs';

// 兩條規則、一條裁定、一張卡。規則 21 與 22 都有「第 3 句」，
// 專門用來測編號會不會指到別條去。
const R21 = ['卡的发动的定义。', '魔法卡从手卡发动。', '灵摆卡放置到灵摆区域进行发动。', '第四句内容在此。'];
const R22 = ['另一条规则开头。', '它的第二句。', '它的第三句不相干。'];
const J900 = ['Q: 罠カードの発動について。', 'A: セットされた罠カードを表側にして発動する。'];
const C555 = ['①：这张卡发动。', '②：同纵列有魔法卡发动的场合可以发动。'];

const ctx = () => ({
	sent_map: {
		rule: new Map([[21, R21], [22, R22]]),
		ruling: new Map([[900, J900]]),
		card: new Map([[555, C555]]),
	},
	evidence: {
		rule: new Map([[21, R21.join('')], [22, R22.join('')]]),
		ruling: new Map([[900, J900.join('')]]),
		card: new Map([[555, C555.join('')]]),
	},
});
const verify = cites => verify_cites(cites, ctx());

/* ---------------------------------------------------------------- 切句與編號 */

test('split_sents：依句號與換行切，過短的殘片併回前一句', () => {
	assert.deepEqual(split_sents('甲乙丙丁戊己。庚辛壬癸子丑。'), ['甲乙丙丁戊己。', '庚辛壬癸子丑。']);
	assert.deepEqual(split_sents('第一行內容很長啊\n第二行內容也很長'), ['第一行內容很長啊', '第二行內容也很長']);
	assert.deepEqual(split_sents('這是第一個完整的句子。」'), ['這是第一個完整的句子。」']);
	assert.deepEqual(split_sents(''), []);
	assert.deepEqual(split_sents(null), []);
});

test('numbered：編號帶來源標籤，且每條依據各自從 1 起算', () => {
	const a = numbered('第一句比較長一點。第二句也比較長。', 'R21');
	assert.match(a.view, /^⟦R21-1⟧第一句/);
	assert.match(a.view, /\n⟦R21-2⟧第二句/);
	assert.equal(a.sents.length, 2);
});

test('strip_marks：去掉各種 ⟦…⟧ 編號', () => {
	assert.equal(strip_marks('依據規則⟦R21-3⟧與⟦J900-2⟧，可以。'), '依據規則與，可以。');
	assert.equal(strip_marks('沒有編號'), '沒有編號');
	assert.equal(strip_marks(undefined), '');
});

/* ---------------------------------------------------------------- verify_cites */

test('帶來源的編號：取回那一句原文，並記入對應的 id', () => {
	const r = verify([{ type: 'rule', id: 21, sents: ['R21-3'] }]);
	assert.deepEqual(r.rule_ids, [21]);
	assert.deepEqual(r.quotes, [{ type: 'rule', id: 21, quote: R21[2] }]);
	assert.deepEqual(r.bad_quotes, []);
});

test('編號可寫成 ⟦R21-3⟧、小寫、含空白', () => {
	for (const t of ['⟦R21-3⟧', 'r21-3', ' R21-3 '])
		assert.deepEqual(verify([{ type: 'rule', id: 21, sents: [t] }]).quotes[0].quote, R21[2], t);
});

test('多句：依句號排序後以換行相接', () => {
	const r = verify([{ type: 'rule', id: 21, sents: ['R21-3', 'R21-1'] }]);
	assert.equal(r.quotes[0].quote, `${R21[0]}\n${R21[2]}`);
});

test('裸數字沿用 cite 自己指的那一條', () => {
	const r = verify([{ type: 'rule', id: 22, sents: [3] }]);
	assert.deepEqual(r.quotes, [{ type: 'rule', id: 22, quote: R22[2] }]);
});

test('⚠️ 編號指到別條依據：引文取自它真正所在的那條，歸屬跟著走', () => {
	// 模型寫 rule 21，卻填了 R22-3 —— 句子是真的，但屬於規則 22
	const r = verify([{ type: 'rule', id: 21, sents: ['R22-3'] }]);
	assert.deepEqual(r.quotes, [{ type: 'rule', id: 22, quote: R22[2] }]);
	assert.deepEqual(r.rule_ids, [22]);
});

test('同一個 cite 橫跨規則與裁定：兩邊都記', () => {
	const r = verify([{ type: 'rule', id: 21, sents: ['R21-2', 'J900-2'] }]);
	assert.deepEqual(r.rule_ids, [21]);
	assert.deepEqual(r.ruling_fids, [900]);
	assert.equal(r.quotes.length, 2);
});

test('句號超出範圍、為 0、不是編號 → 作廢', () => {
	for (const bad of ['R21-9', 'R21-0', 'R99-1', 'X21-1', '第三句', 'R21-', '']) {
		const r = verify([{ type: 'rule', id: 21, sents: [bad] }]);
		assert.equal(r.bad_quotes.length, 1, `「${bad}」應該被擋`);
		assert.deepEqual(r.rule_ids, []);
	}
});

test('沒有 sents 的內容、或超過 5 句 → 作廢', () => {
	assert.equal(verify([{ type: 'rule', id: 21, sents: [] }]).bad_quotes.length, 1);
	const six = ['R21-1', 'R21-2', 'R21-3', 'R21-4', 'R22-1', 'R22-2'];
	assert.equal(verify([{ type: 'rule', id: 21, sents: six }]).bad_quotes.length, 1);
});

test('⚠️ 我們沒送過的 id 一律丟掉，不算引文錯誤也不進 ids', () => {
	const r = verify([{ type: 'rule', id: 999, sents: ['R21-1'] }, { type: 'ruling', id: 21, sents: ['J900-1'] }]);
	assert.equal(r.dropped.length, 2);
	assert.deepEqual([r.rule_ids, r.ruling_fids, r.quotes, r.bad_quotes], [[], [], [], []]);
});

test('裁定的編號欄位寫成 id 也認得（寬容欄位名、嚴格 id 集合）', () => {
	assert.deepEqual(verify([{ type: 'ruling', id: 900, sents: ['J900-2'] }]).ruling_fids, [900]);
	assert.deepEqual(verify([{ type: 'ruling', fid: 900, sents: ['J900-2'] }]).ruling_fids, [900]);
});

test('卡片效果引用', () => {
	const r = verify([{ type: 'card', id: 555, sents: ['C555-2'] }]);
	assert.deepEqual(r.card_ids, [555]);
	assert.equal(r.quotes[0].quote, C555[1]);
});

test('同一條重複引用只記一次 id', () => {
	const r = verify([{ type: 'rule', id: 21, sents: ['R21-1'] }, { type: 'rule', id: 21, sents: ['R21-2'] }]);
	assert.deepEqual(r.rule_ids, [21]);
	assert.equal(r.quotes.length, 2);
});

test('只要有一筆壞引用就會出現在 bad_quotes（主流程據此整個作廢）', () => {
	const r = verify([{ type: 'rule', id: 21, sents: ['R21-1'] }, { type: 'rule', id: 22, sents: ['R22-8'] }]);
	assert.equal(r.bad_quotes.length, 1);
	assert.deepEqual(r.rule_ids, [21]);
});

test('沒照格式、自己寫 quote：仍用原文比對', () => {
	assert.equal(verify([{ type: 'rule', id: 21, quote: '灵摆卡放置到灵摆区域进行发动' }]).bad_quotes.length, 0);
	assert.equal(verify([{ type: 'rule', id: 21, quote: '這句話原文裡根本沒有出現過' }]).bad_quotes.length, 1);
	assert.equal(verify([{ type: 'rule', id: 21, quote: '太短' }]).bad_quotes.length, 1);
	// 省略號：片段要依序出現
	assert.equal(verify([{ type: 'rule', id: 21, quote: '魔法卡从手卡发动…灵摆卡放置到灵摆区域' }]).bad_quotes.length, 0);
	assert.equal(verify([{ type: 'rule', id: 21, quote: '灵摆卡放置到灵摆区域…魔法卡从手卡发动' }]).bad_quotes.length, 1);
});

test('cites 內容不是物件也不會炸', () => {
	const r = verify([null, 'x', 42, {}]);
	assert.equal(r.dropped.length, 4);
});

/* ---------------------------------------------------------------- mention_gaps */

test('mention_gaps：提到規則／裁定卻沒有對應引用', () => {
	assert.deepEqual(mention_gaps('依據規則文件，可以。', [], []), ['規則']);
	assert.deepEqual(mention_gaps('依據 OCG Rule 與裁定。', [], []), ['規則', '裁定']);
	assert.deepEqual(mention_gaps('依據裁定 23176。', [21], []), ['裁定']);
});

test('mention_gaps：有對應引用、或根本沒提到 → 不報', () => {
	assert.deepEqual(mention_gaps('依據規則與裁定。', [21], [900]), []);
	assert.deepEqual(mention_gaps('這張卡的效果文字寫了條件。', [], []), []);
});

/* ---------------------------------------------------------------- check_relevance */

const Q = [{ type: 'rule', id: 21, quote: 'a' }, { type: 'ruling', id: 900, quote: 'b' }];
const fake = text => async () => (text instanceof Error ? { error: String(text) } : { text });
const judge = text => check_relevance('問題', '回答', Q, {}, fake(text));

test('審查：全部 direct=true → 通過', async () => {
	assert.deepEqual(await judge('{"results":[{"n":1,"direct":true},{"n":2,"direct":true}]}'), []);
});

test('審查：明確說 false 的才被標出來', async () => {
	assert.deepEqual(await judge('{"results":[{"n":1,"direct":true},{"n":2,"direct":false}]}'), ['ruling:900']);
});

test('審查：小模型漏回一筆不算判決', async () => {
	assert.deepEqual(await judge('{"results":[{"n":1,"direct":true}]}'), []);
	assert.deepEqual(await judge('{"results":[{"n":2,"direct":false}]}'), ['ruling:900']);
});

test('審查：fail-closed —— 呼叫失敗、不是 JSON、沒有 results 都算沒通過', async () => {
	assert.deepEqual(await judge(new Error('503')), ['審查失敗']);
	assert.deepEqual(await judge('不是 JSON'), ['審查失敗']);
	assert.deepEqual(await judge('{"foo":1}'), ['審查失敗']);
});

test('審查：送給審查員的回答已去掉 ⟦⟧ 編號', async () => {
	let seen = '';
	await check_relevance('問題', '依據⟦R21-3⟧可以。', Q, {}, async p => {
		seen = p;
		return { text: '{"results":[]}' };
	});
	assert.ok(!seen.includes('⟦R21-3⟧'));
	assert.ok(seen.includes('依據可以。'));
});

test('審查：提示詞依依據種類分開標準，且標出每段的種類與編號', async () => {
	let seen = '';
	const quotes = [
		{ type: 'rule', id: 31, quote: '規則通則' },
		{ type: 'ruling', id: 900, quote: '裁定內容' },
		{ type: 'card', id: 555, quote: '卡片效果' },
	];
	await check_relevance('問題', '回答', quotes, {}, async p => {
		seen = p;
		return { text: '{"results":[]}' };
	});
	// 三種依據各有自己的標準：規則是通則（例子換別張卡不算不相關）、卡片只確認效果文字、裁定最嚴格
	for (const w of ['通則', '即使它舉的例子用的是別張卡', '問題提到的那張卡', '針對特定卡、特定情境'])
		assert.ok(seen.includes(w), `提示詞應該包含「${w}」`);
	assert.ok(seen.includes('[rule 31]') && seen.includes('[ruling 900]') && seen.includes('[card 555]'));
	assert.ok(seen.includes('reason'), '要求審查員附上理由');
});

test('審查：被標出來的引文，審查員的理由會進日誌', async t => {
	const warn = t.mock.method(console, 'warn', () => {});
	const bad = await judge('{"results":[{"n":1,"direct":true,"reason":"通則"},{"n":2,"direct":false,"reason":"裁定講的是別張卡"}]}');
	assert.deepEqual(bad, ['ruling:900']);
	const logged = warn.mock.calls.map(c => c.arguments[0]).join('\n');
	assert.ok(logged.includes('ruling:900') && logged.includes('裁定講的是別張卡'));
	// 通過的不記理由
	assert.ok(!logged.includes('rule:21'));
});

test('審查：沒附理由也照常判讀，不會因為缺 reason 而炸', async t => {
	t.mock.method(console, 'warn', () => {});
	assert.deepEqual(await judge('{"results":[{"n":1,"direct":false}]}'), ['rule:21']);
});

/* ---- expand_stubs：空殼母章節帶上子章節 ---- */

import { expand_stubs } from '../ygo-rules.mjs';

const ROWS = [
	{ id: 17, path: '进行回合的优先权', chars: 201 },
	{ id: 18, path: '进行回合的优先权 › 特定阶段·步骤的优先权转移', chars: 608 },
	{ id: 19, path: '进行回合的优先权 › 其他', chars: 300 },
	{ id: 241, path: '同一时点发动多个诱发类效果', chars: 6849 },
	{ id: 242, path: '同一时点发动多个诱发类效果 › 子節', chars: 100 },
];

test('展開：選到空殼母章節就帶上它的子章節，原本的順序不變', () => {
	assert.deepEqual(expand_stubs([241, 17], ROWS), [241, 17, 18, 19]);
});

test('展開：大章節不展開（即使有子章節）', () => {
	assert.deepEqual(expand_stubs([241], ROWS), [241]);
});

test('展開：子章節已經在清單裡就不重複加', () => {
	assert.deepEqual(expand_stubs([17, 18], ROWS), [17, 18, 19]);
});

test('展開：總數不超過上限', () => {
	assert.deepEqual(expand_stubs([241, 17], ROWS, 400, 3), [241, 17, 18]);
});

test('展開：目錄裡找不到的編號原樣保留、不炸', () => {
	assert.deepEqual(expand_stubs([999], ROWS), [999]);
});
