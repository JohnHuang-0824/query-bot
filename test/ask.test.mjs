/**
 * /ask 的單元測試 —— 不連模型、不連網路。
 *
 *   docker compose -f docker-compose.dev.yml run --rm --no-deps --user root bot node --test test/
 *
 * ⚠️ 這些測的是「擋人的那一層」：模型編造、引錯條、宣稱有依據卻沒引用。
 *    改 verify_cites／mention_gaps／check_relevance／answer_question 之後要先跑
 *    這個，再去花模型額度跑評測。
 *
 * 檔尾的整條流程測試用假模型（opts.gen_fn）和假的規則語料，但需要卡表（db/，
 * 載入時自己下載）。
 * ⚠️ 匯入卡表會重寫 db/query.cdb，而 node --test 是各檔案平行跑 —— 會載入卡表的
 *    測試都放這個檔案，另開一個會有兩個行程同時寫、把資料庫弄壞。
 *
 * 裁定快取、節流與規則語料開在記憶體（下面第一個 import），不碰本機資料。
 */

// ⚠️ 一定要是第一個 import：下面的模組一載入就開資料庫了。
import 'data:text/javascript,process.env.YGO_RULING_DB = ":memory:"; process.env.YGO_RULES_DB = ":memory:";';

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

/* ---- answer_question：整條流程，用假模型 ---- */

import { answer_question } from '../ygo-answer.mjs';
import { import_sections, toc_rows, get_section } from '../ygo-rules.mjs';
import { resolve_id } from '../ygo-alias.mjs';
import { LIST_TTL_MS } from '../ygo-ruling.mjs';
import { get_card } from '../ygo-query.mjs';
import { choice_table } from '../common_all.js';

// 假語料：一個內容完整的葉章節，一個只有引言的母章節帶一個子章節。
// 用假的才能在全新環境跑，結果也不會跟著來源改版而變。
const section = (path, sentences) => {
	const body = Array.from({ length: sentences }, (_, i) => `「${path}」的第 ${i + 1} 句測試內容。`).join('\n');
	return { file: 'test.rst', title: path.split(' › ').at(-1), path, level: path.split(' › ').length, body, chars: body.length };
};
import_sections([
	section('內容完整的章節', 40),
	section('只有引言的母章節', 2),
	section('只有引言的母章節 › 子章節', 40),
]);
// LEAF 不會被展開也一定切得出句子；STUB 夠短，選到它要自動帶上 CHILD
const [LEAF, STUB, CHILD] = toc_rows();
const CARD = { name: '拉的翼神龍-不死鳥', id: 10000090 };
const NO_CARD = '不存在的卡名甲';

const select = (sections = [LEAF.id], cards = []) => ({ sections, cards });
const reply = (extra = {}) => ({
	refused: false, answer: '可以。',
	cites: [{ type: 'rule', id: LEAF.id, sents: [`R${LEAF.id}-1`] }],
	...extra,
});

/** 用假模型跑一次。replies 依呼叫順序給；多呼叫一次就讓測試失敗。 */
async function ask(t, replies, { relevance = false, ...opts } = {}) {
	t.mock.method(console, 'warn', () => {});
	// 開發機的 .env 可能開著相關性檢查，測試自己決定開不開
	const saved = process.env.ASK_RELEVANCE_CHECK;
	t.after(() => {
		if (saved === undefined)
			delete process.env.ASK_RELEVANCE_CHECK;
		else
			process.env.ASK_RELEVANCE_CHECK = saved;
	});
	process.env.ASK_RELEVANCE_CHECK = relevance ? '1' : '';
	const calls = [];
	const gen_fn = async (prompt, gen) => {
		calls.push({ prompt, ...gen });
		assert.ok(calls.length <= replies.length, `模型被多呼叫了（第 ${calls.length} 次）`);
		const r = replies[calls.length - 1];
		return r.error ? r : { text: typeof r === 'string' ? r : JSON.stringify(r) };
	};
	const result = await answer_question('測試問題', { allow_fetch: false, gen_fn, ...opts });
	return { r: result, calls };
}

test('流程：作答成功，引文由程式取原文，回答裡的句子編號被拿掉', async t => {
	const { r, calls } = await ask(t, [select(), reply({ answer: `可以⟦R${LEAF.id}-1⟧。` })]);
	assert.equal(r.refused, false);
	assert.equal(r.reason, undefined);
	assert.equal(r.answer, '可以。');
	assert.deepEqual(r.rule_ids, [LEAF.id]);
	assert.equal(r.quotes[0].quote, numbered(get_section(LEAF.id).body, 'R').sents[0]);
	assert.deepEqual(calls.map(c => c.stage), ['select', 'answer']);
	assert.ok(calls.every(c => c.temperature === 0 && c.prompt.includes('測試問題')));
});

test('流程：作答成功時也回傳解析不到的卡名', async t => {
	const { r } = await ask(t, [select([LEAF.id], [NO_CARD]), reply()]);
	assert.equal(r.refused, false);
	assert.deepEqual(r.unresolved, [NO_CARD]);
	assert.deepEqual(r.cards, []);
});

test('流程：解析得到的卡，卡文送進第二段而且可以引用', async t => {
	const cites = [{ type: 'card', id: CARD.id, sents: [`C${CARD.id}-1`] }];
	const { r, calls } = await ask(t, [select([], [CARD.name]), reply({ cites })]);
	assert.ok(calls[1].prompt.includes(`⟦C${CARD.id}-1⟧`));
	assert.deepEqual(r.card_ids, [CARD.id]);
	assert.deepEqual(r.unresolved, []);
});

// 沒有官方編號的卡（先行卡、剛發售還沒進編號表的卡）。是哪幾張會隨卡表變，現挑。
const NO_CID = [...choice_table.full].find(([name, id]) => {
	if (choice_table['zh-tw'].has(name))
		return false;
	const card = get_card(id);
	return card && !card.cid && card.text.description && resolve_id(name) === id;
});
const needs_no_cid = { skip: NO_CID ? false : '卡表裡沒有缺編號的卡' };

test('流程：沒有官方編號的卡，卡文照樣送進第二段，但不查裁定', needs_no_cid, async t => {
	const [name, id] = NO_CID;
	t.mock.method(globalThis, 'fetch', async () => assert.fail('沒有編號的卡不該發出請求'));
	const cites = [{ type: 'card', id, sents: [`C${id}-1`] }];
	const { r, calls } = await ask(t, [select([], [name]), reply({ cites })], { allow_fetch: true });
	assert.ok(calls[1].prompt.includes(`⟦C${id}-1⟧`));
	assert.deepEqual(r.card_ids, [id]);
	assert.equal(r.cards.length, 1);
	assert.deepEqual(r.ruling_fids, []);
	assert.deepEqual(r.unresolved, []);
});

test('流程：裁定快取過期時重抓，新裁定和改過的全文送進第二段', async t => {
	// 假的官方站：清單加明細。時鐘每個請求往前撥一點，免得節流真的去等。
	const site = { 201: '舊的回答內容在這裡。' };
	const real_now = Date.now;
	let skew = 0;
	t.mock.method(Date, 'now', () => real_now() + skew);
	t.mock.method(globalThis, 'fetch', async url => {
		const q = new URL(url).searchParams;
		skew += 2000;
		if (q.get('ope') === '5')
			return new Response(`<span>2026-01-01</span><div id="question_text">可以發動嗎？</div><div id="answer_text">${site[q.get('fid')]}</div>`);
		return new Response(`全${Object.keys(site).length}件` + Object.keys(site).map(fid =>
			`<div class="t_row"><span class="name">標題</span><span>更新日:</span> 2026-01-01 ope=5&fid=${fid}</div>`).join(''));
	});
	const run = () => ask(t, [select([LEAF.id], [CARD.name]), reply()], { allow_fetch: true });

	const first = await run();
	assert.ok(first.calls[1].prompt.includes('舊的回答內容在這裡'));

	site[201] = '改過的回答內容在這裡。';
	site[202] = '後來發布的新裁定內容。';
	skew += LIST_TTL_MS;
	const second = await run();
	assert.ok(second.calls[1].prompt.includes('改過的回答內容在這裡'));
	assert.ok(second.calls[1].prompt.includes('後來發布的新裁定內容'));
});

test('流程：卡表裡沒有的卡號算解析不到', async t => {
	const { r } = await ask(t, [select([], ['999999999'])]);
	assert.equal(r.reason, 'no_evidence');
	assert.deepEqual(r.unresolved, ['999999999']);
	assert.deepEqual(r.cards, []);
});

test('流程：沒有任何依據就不呼叫第二段', async t => {
	const { r, calls } = await ask(t, [select([], [NO_CARD])]);
	assert.equal(r.reason, 'no_evidence');
	assert.deepEqual(r.unresolved, [NO_CARD]);
	assert.equal(calls.length, 1);
});

for (const [reason, extra] of [
	['model', () => ({ refused: true, answer: '查無依據。', cites: [] })],
	['bad_quote', () => ({ cites: [{ type: 'rule', id: LEAF.id, sents: [`R${LEAF.id}-9999`] }] })],
	['mention_gap', () => ({ answer: '依據規則，可以。', cites: [] })],
	['no_cite', () => ({ cites: [] })],
]) {
	test(`流程：拒答原因 ${reason}`, async t => {
		const { r } = await ask(t, [select([LEAF.id], [NO_CARD]), reply(extra())]);
		assert.equal(r.refused, true);
		assert.equal(r.reason, reason);
		assert.deepEqual(r.unresolved, [NO_CARD]);
	});
}

test('流程：相關性檢查開啟且引文被判不相關 → 拒答', async t => {
	const verdict = { results: [{ n: 1, direct: false, reason: '講別的情況' }] };
	const { r, calls } = await ask(t, [select(), reply(), verdict], { relevance: true });
	assert.equal(r.reason, 'relevance');
	assert.equal(calls.length, 3);
	assert.ok(calls[2].prompt.includes('引文審查員'));
});

test('流程：相關性檢查通過就照常作答', async t => {
	const verdict = { results: [{ n: 1, direct: true, reason: '適用' }] };
	const { r } = await ask(t, [select(), reply(), verdict], { relevance: true });
	assert.equal(r.refused, false);
});

test('流程：第一段出錯就停，錯誤原樣回傳', async t => {
	const { r, calls } = await ask(t, [{ error: '429 每日上限' }]);
	assert.equal(r.error, '429 每日上限');
	assert.equal(calls.length, 1);
});

test('流程：第二段出錯或回的不是 JSON，都回報錯誤', async t => {
	const failed = await ask(t, [select(), { error: '503' }]);
	assert.equal(failed.r.error, '503');
	const garbled = await ask(t, [select(), '我覺得可以']);
	assert.match(garbled.r.error, /JSON/);
});

test('流程：force_sections 跳過第一段的模型呼叫', async t => {
	const { r, calls } = await ask(t, [reply()], { force_sections: [LEAF.id] });
	assert.equal(r.refused, false);
	assert.deepEqual(calls.map(c => c.stage), ['answer']);
});

test('流程：第一段挑到空殼母章節時，子章節也送進第二段', async t => {
	const { r, calls } = await ask(t, [select([STUB.id]), reply({ refused: true, cites: [] })]);
	assert.ok(r.debug.sections.some(s => s.startsWith(`${CHILD.id}:`)), r.debug.sections.join(' '));
	assert.ok(calls[1].prompt.includes(`⟦R${CHILD.id}-1⟧`));
});
