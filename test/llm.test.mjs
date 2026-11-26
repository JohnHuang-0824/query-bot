/**
 * 模型呼叫層的失敗處理 —— fetch 是假的、用量記在記憶體，不連網路、不花額度。
 */

// ⚠️ 一定要是第一個 import：下面兩個模組載入時就讀環境變數、開資料庫。
//    金鑰換成假的，.env 裡真的那把不會被讀到；本機節流上限一併清掉。
import 'data:text/javascript,Object.assign(process.env, { YGO_RULING_DB: ":memory:", GEMINI_API_KEY: "test-key", ANTHROPIC_API_KEY: "test-key", GEMINI_RPM: "", GEMINI_RPD: "", CLAUDE_RPM: "", CLAUDE_RPD: "" });';

import test from 'node:test';
import assert from 'node:assert/strict';
import * as gemini from '../ygo-gemini.mjs';
import * as claude from '../ygo-claude.mjs';

// 每個請求把時鐘往前撥超過一分鐘，節流不用真的等。只往前、不歸零。
const real_now = Date.now;
let skew = 0;
Date.now = () => real_now() + skew;

/** 依序回應每一次請求。每個 reply 是回傳 Response 或丟例外的函式。 */
function fake_api(t, ...replies) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, opts) => {
		calls.push(opts);
		skew += 61_000;
		const reply = replies[calls.length - 1];
		assert.ok(reply, `請求多送了（第 ${calls.length} 次）`);
		return reply(opts);
	});
	return calls;
}

/** 回應開始之後內文讀到一半斷線 */
const cut_off = () => new Response(new ReadableStream({
	start(c) {
		c.enqueue(new TextEncoder().encode('{"candidates":'));
		c.error(new TypeError('terminated'));
	},
}));

const providers = [
	{
		name: 'Gemini', api: gemini,
		ok: () => Response.json({ candidates: [{ content: { parts: [{ text: '好' }] }, finishReason: 'STOP' }] }),
		counted: () => gemini.usage().days.reduce((n, d) => n + d.errors, 0),
	},
	{
		name: 'Claude', api: claude,
		ok: () => Response.json({ content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn' }),
		counted: () => claude.usage().days.reduce((n, d) => n + d.errors, 0),
	},
];

for (const { name, api, ok, counted } of providers) {
	/** 失敗要回 {error}、不丟例外、記進錯誤數，而且不重送 */
	async function fails(t, reply, pattern) {
		const calls = fake_api(t, reply);
		const before = counted();
		const r = await api.generate('問題');
		assert.match(r.error, pattern);
		assert.equal(counted(), before + 1);
		assert.equal(calls.length, 1);
	}

	test(`${name}：正常回應`, async t => {
		const calls = fake_api(t, ok);
		assert.deepEqual(await api.generate('問題'), { text: '好' });
		assert.ok(calls[0].signal instanceof AbortSignal, '請求要帶逾時');
	});

	test(`${name}：逾時回錯誤`, async t => {
		const expired = AbortSignal.abort(new DOMException('timeout', 'TimeoutError'));
		t.mock.method(AbortSignal, 'timeout', () => expired);
		await fails(t, opts => {
			throw opts.signal.reason;
		}, /秒內沒有回應/);
	});

	test(`${name}：連不上回錯誤`, async t => {
		await fails(t, () => {
			throw new TypeError('fetch failed');
		}, /連線失敗：fetch failed/);
	});

	test(`${name}：回應讀到一半斷線回錯誤`, async t => {
		await fails(t, cut_off, /連線失敗/);
	});

	test(`${name}：200 但不是 JSON 回錯誤`, async t => {
		await fails(t, () => new Response('<html>Bad Gateway</html>'), /不是完整的 JSON/);
	});

	test(`${name}：HTTP 錯誤帶上對方的說明`, async t => {
		await fails(t, () => new Response('invalid key', { status: 403 }), /HTTP 403：invalid key/);
	});
}

test('Gemini：每分鐘 429 照對方給的秒數等，然後重試成功', async t => {
	const limited = () => Response.json({
		error: { details: [{ retryDelay: '0.01s' }, { violations: [{ quotaId: 'RequestsPerMinute' }] }] },
	}, { status: 429 });
	const calls = fake_api(t, limited, providers[0].ok);
	assert.deepEqual(await gemini.generate('問題'), { text: '好' });
	assert.equal(calls.length, 2);
});

// ⚠️ 每日配額用完會記下來、當天不再送請求，所以這條放最後。
test('Gemini：每日 429 不重試，之後的請求在本機擋掉', async t => {
	const exhausted = () => Response.json({
		error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProject', quotaValue: '20' }] }] },
	}, { status: 429 });
	const calls = fake_api(t, exhausted);
	assert.match((await gemini.generate('問題')).error, /每日上限（Google 回報 20/);
	assert.match((await gemini.generate('問題')).error, /每日上限/);
	assert.equal(calls.length, 1);
});
