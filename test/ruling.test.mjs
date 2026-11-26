/**
 * 裁定快取的更新規則 —— 資料庫開在記憶體、官網用假的 fetch，不碰 db/、不連網路。
 */

// ⚠️ 一定要是第一個 import：下面的模組一載入就開資料庫了。
import 'data:text/javascript,process.env.YGO_RULING_DB = ":memory:";';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	LIST_TTL_MS, refresh_rulings, ensure_detail, get_rulings, get_ruling, cache_state,
} from '../ygo-ruling.mjs';

// 時鐘只往前撥、不歸零 —— 節流記錄的是撥過的時間，撥回去的話下一個請求
// 會以為要等很久。
const real_now = Date.now;
let skew = 0;
Date.now = () => real_now() + skew;
const expire = () => skew += LIST_TTL_MS + 1000;

const entry = (date, answer = '回答內容。') => ({ date, title: '清單標題', question: '明細頁的完整問題。', answer });

const list_page = rulings => `全${Object.keys(rulings).length}件` + Object.entries(rulings).map(([fid, r]) =>
	`<div class="t_row"><span class="name">${r.title}</span><span>更新日:</span> ${r.date ?? ''}
	<input value="/yugiohdb/faq_search.action?ope=5&fid=${fid}"></div>`).join('');

const detail_page = r => `<span>${r.date}</span>
	<div id="question_text">${r.question}</div><div id="answer_text">${r.answer}</div>`;

/** 假的官方站。改 rulings 模擬改版，down 模擬連不上，broken 模擬頁面改版。 */
function official_site(t, rulings) {
	const site = { rulings, down: false, broken: false, requests: [] };
	t.mock.method(console, 'error', () => {});
	t.mock.method(globalThis, 'fetch', async url => {
		const q = new URL(url).searchParams;
		const is_list = q.get('ope') === '4';
		site.requests.push(is_list ? 'list' : `detail ${q.get('fid')}`);
		skew += 2000;	// 超過兩次請求的最小間隔，測試不用真的等
		if (site.down)
			throw new TypeError('fetch failed');
		if (site.broken)
			return new Response('<html>メンテナンス中</html>');
		return new Response(is_list ? list_page(site.rulings) : detail_page(site.rulings[q.get('fid')]));
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
