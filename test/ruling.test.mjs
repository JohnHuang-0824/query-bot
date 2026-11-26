/**
 * 裁定快取的更新規則 —— 資料庫開在記憶體、官網用假的 fetch，不碰 db/、不連網路。
 */

// ⚠️ 一定要是第一個 import：下面的模組一載入就開資料庫了。
import 'data:text/javascript,process.env.YGO_RULING_DB = ":memory:";';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	LIST_TTL_MS, refresh_rulings, ensure_detail, get_rulings, get_ruling, cache_state, parse_list,
} from '../ygo-ruling.mjs';

// 時鐘只往前撥、不歸零 —— 節流記錄的是撥過的時間，撥回去的話下一個請求
// 會以為要等很久。
const real_now = Date.now;
let skew = 0;
Date.now = () => real_now() + skew;
const expire = () => skew += LIST_TTL_MS + 1000;

const entry = (date, answer = '回答內容。') => ({ date, title: '清單標題', question: '明細頁的完整問題。', answer });

// 官方站「沒有裁定」的頁面長這樣（實測）
const NO_RULINGS = '<div class="no_data">\n\t\tこのカードに関連するＱ＆Ａはありません。\n\t</div>';

const list_row = ([fid, r]) => `<div class="t_row"><span class="name">${r.title}</span><span>更新日:</span> ${r.date ?? ''}
	<input value="/yugiohdb/faq_search.action?ope=5&fid=${fid}"></div>`;

/** 一頁 100 條。total 可以另外指定，模擬件數比列得出來的多。 */
function list_page({ rulings, total }, page) {
	const all = Object.entries(rulings);
	if (!all.length)
		return NO_RULINGS;
	return `全${total ?? all.length}件中` + all.slice((page - 1) * 100, page * 100).map(list_row).join('');
}

const detail_page = r => `<span>${r.date}</span>
	<div id="question_text">${r.question}</div><div id="answer_text">${r.answer}</div>`;

/**
 * 假的官方站。改 rulings 模擬改版，down 模擬連不上，broken 模擬維護公告
 * （broken_from 只壞清單的第幾頁之後）。
 */
function official_site(t, rulings) {
	const site = { rulings, down: false, broken: false, broken_from: Infinity, total: undefined, requests: [] };
	t.mock.method(console, 'error', () => {});
	t.mock.method(console, 'warn', () => {});
	t.mock.method(globalThis, 'fetch', async url => {
		const q = new URL(url).searchParams;
		const is_list = q.get('ope') === '4';
		site.requests.push(is_list ? 'list' : `detail ${q.get('fid')}`);
		skew += 2000;	// 超過兩次請求的最小間隔，測試不用真的等
		if (site.down)
			throw new TypeError('fetch failed');
		const page = Number(q.get('page'));
		if (site.broken || (is_list && page >= site.broken_from))
			return new Response('<html>メンテナンス中</html>');
		return new Response(is_list ? list_page(site, page) : detail_page(site.rulings[q.get('fid')]));
	});
	return site;
}

test('清單：沒抓過就抓，新鮮的不重抓，過期才重抓、看得到新裁定', async t => {
	const site = official_site(t, { 101: entry('2026-01-01') });
	await refresh_rulings(1);
	assert.deepEqual(site.requests, ['list']);

	site.rulings[102] = entry('2026-02-01');
	await refresh_rulings(1);
	assert.equal(site.requests.length, 1);

	expire();
	await refresh_rulings(1);
	assert.equal(site.requests.length, 2);
	assert.deepEqual(get_rulings(1).map(r => r.fid), [102, 101]);
});

test('清單：重抓連不上時不丟例外，舊快取照用', async t => {
	const site = official_site(t, { 201: entry('2026-01-01') });
	await refresh_rulings(2);
	expire();
	site.down = true;
	await refresh_rulings(2);
	assert.deepEqual(get_rulings(2).map(r => r.fid), [201]);
	assert.equal(cache_state(2).fresh, false, '沒抓到就不能算新鮮，下次要再試');
});

test('清單：第一次就連不上，不能當成抓過', async t => {
	official_site(t, {}).down = true;
	await refresh_rulings(3);
	assert.equal(cache_state(3).fetched, false);
});

test('全文：期限內不重抓；過期重抓，更新日沒變也拿得到新內容', async t => {
	const site = official_site(t, { 401: entry('2026-01-01', '舊回答。') });
	await refresh_rulings(4);
	assert.equal(await ensure_detail(401), true);
	assert.equal(await ensure_detail(401), true);
	assert.deepEqual(site.requests, ['list', 'detail 401']);

	site.rulings[401].answer = '舊回答。多列了一張卡。';
	expire();
	assert.equal(await ensure_detail(401), true);
	assert.equal(get_ruling(401).answer, '舊回答。多列了一張卡。');
});

test('全文：過期重抓失敗（連不上或解析不了）時沿用舊的', async t => {
	const site = official_site(t, { 501: entry('2026-01-01', '舊回答。') });
	await refresh_rulings(5);
	await ensure_detail(501);
	expire();
	for (const failure of ['down', 'broken']) {
		site[failure] = true;
		assert.equal(await ensure_detail(501), true, failure);
		assert.equal(get_ruling(501).answer, '舊回答。', failure);
		site[failure] = false;
	}
});

test('改版：清單日期變了就丟掉舊全文，下次重抓', async t => {
	const site = official_site(t, { 601: entry('2026-01-01', '舊回答。') });
	await refresh_rulings(6);
	await ensure_detail(601);

	site.rulings[601] = entry('2026-03-01', '新回答。');
	expire();
	await refresh_rulings(6);
	assert.equal(get_ruling(601).answer, null);
	assert.equal(get_ruling(601).question, '清單標題');
	assert.equal(get_ruling(601).updated_at, '2026-03-01');

	await ensure_detail(601);
	assert.equal(get_ruling(601).answer, '新回答。');
});

test('改版：新全文抓不到時寧可沒有，也不拿舊內容配新日期', async t => {
	const site = official_site(t, { 701: entry('2026-01-01', '舊回答。') });
	await refresh_rulings(7);
	await ensure_detail(701);
	site.rulings[701] = entry('2026-03-01', '新回答。');
	expire();
	await refresh_rulings(7);
	site.down = true;
	assert.equal(await ensure_detail(701), false);
	assert.equal(get_ruling(701).answer, null);
});

test('清單重抓而日期沒變（或解析不出日期）：全文和完整問題都保留', async t => {
	const site = official_site(t, { 801: entry('2026-01-01'), 802: entry('2026-01-01') });
	await refresh_rulings(8);
	await ensure_detail(801);
	await ensure_detail(802);
	site.rulings[802].date = null;
	expire();
	await refresh_rulings(8);
	for (const fid of [801, 802]) {
		const r = get_ruling(fid);
		assert.equal(r.answer, '回答內容。', `${fid}`);
		assert.equal(r.question, '明細頁的完整問題。', `${fid}`);
		assert.equal(r.updated_at, '2026-01-01', `${fid}`);
	}
});

/* ---------------------------------------------------------------- 認得的清單頁 */

const fids = cid => get_rulings(cid).map(r => r.fid).sort((a, b) => a - b);
const many = (from, count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [from + i, entry('2026-01-01')]));

test('parse_list：只有明講沒有裁定的頁面算 empty', () => {
	assert.equal(parse_list(NO_RULINGS).empty, true);
	assert.equal(parse_list('<html>メンテナンス中</html>').empty, false);
	// 卡號不存在是另一句話
	assert.equal(parse_list('<div class="no_data">カード情報がありません。</div>').empty, false);
	// 有列出裁定時，別處出現那句話也不算
	assert.equal(parse_list(NO_RULINGS + list_row(['1', entry('2026-01-01')])).empty, false);
});

test('parse_list：件數帶千分位也讀得到', () => {
	assert.equal(parse_list('全1,234件中').total, 1234);
});

test('認不得的清單頁：第一次抓到不能記成 0 條，下次還會再試', async t => {
	const site = official_site(t, { 901: entry('2026-01-01') });
	site.broken = true;
	await refresh_rulings(90);
	assert.equal(cache_state(90).fetched, false);

	site.broken = false;
	await refresh_rulings(90);
	assert.deepEqual(fids(90), [901]);
	assert.equal(site.requests.length, 2);
});

test('認不得的清單頁：重抓時舊的關聯原封不動', async t => {
	const site = official_site(t, { 911: entry('2026-01-01') });
	await refresh_rulings(91);
	expire();
	site.broken = true;
	await refresh_rulings(91);
	assert.deepEqual(fids(91), [911]);
	assert.equal(cache_state(91).fresh, false);
});

test('官方明講沒有裁定：記成抓過、0 條', async t => {
	official_site(t, {});
	await refresh_rulings(92);
	assert.deepEqual(cache_state(92), { fetched: true, fresh: true, total: 0, complete: true });
});

test('撤掉的裁定：從重抓的那張卡移除，別張卡的和裁定本身不動', async t => {
	const site = official_site(t, { 931: entry('2026-01-01'), 932: entry('2026-01-01') });
	await refresh_rulings(93);
	await refresh_rulings(94);
	delete site.rulings[931];
	expire();
	await refresh_rulings(93);
	assert.deepEqual(fids(93), [932]);
	assert.deepEqual(fids(94), [931, 932]);
	assert.ok(get_ruling(931));
});

test('撤到一條不剩（官方明講沒有）：全部移除', async t => {
	const site = official_site(t, { 951: entry('2026-01-01') });
	await refresh_rulings(95);
	site.rulings = {};
	expire();
	await refresh_rulings(95);
	assert.deepEqual(fids(95), []);
});

test('多頁清單：每一頁都抓完才比對，第二頁的撤銷也看得到', async t => {
	const site = official_site(t, many(2000, 150));
	await refresh_rulings(96);
	assert.equal(fids(96).length, 150);
	assert.deepEqual(site.requests, ['list', 'list']);

	delete site.rulings[2140];
	expire();
	await refresh_rulings(96);
	assert.equal(fids(96).length, 149);
	assert.ok(!fids(96).includes(2140));
});

test('清單沒抓完整（超過分頁上限）：不移除任何東西', async t => {
	const site = official_site(t, { 971: entry('2026-01-01') });
	await refresh_rulings(97);
	site.rulings = many(3000, 350);
	expire();
	await refresh_rulings(97);
	assert.equal(cache_state(97).complete, false);
	assert.ok(fids(97).includes(971));
});

test('第二頁認不得：整次當失敗，不移除任何東西', async t => {
	const site = official_site(t, { 981: entry('2026-01-01') });
	await refresh_rulings(98);
	site.rulings = many(4000, 150);
	site.broken_from = 2;
	expire();
	await refresh_rulings(98);
	assert.ok(fids(98).includes(981));
	assert.equal(cache_state(98).fresh, false);
});
