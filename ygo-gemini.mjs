/**
 * Gemini 呼叫層。
 *
 * 用 REST API 直接打，不裝 SDK —— 這個 fork 只有 discord.js 一個依賴，
 * 為了兩個 endpoint 多背一個套件不划算，而且之後要向上游提 PR 時，
 * 多一個依賴就是多一個被拒絕的理由。
 *
 * ⚠️ 模型要釘死版本，不要用 `-latest` 那種別名。
 *    別名會在你不知情的時候換掉背後的模型，於是評測結果變了卻找不到
 *    原因 —— 那正是評測集要防的「憑感覺調 LLM」。要換模型就改 .env
 *    再跑一次評測，用數字比較，不要靠感覺。
 */

import { DatabaseSync } from 'node:sqlite';
import { blocked_reason, wait_ms, record, stats, quota_day } from './ygo-throttle.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = process.env.GEMINI_API_KEY;

/**
 * ⚠️ **不要相信文件上的數字，要相信 429 回應裡的數字。**
 *
 *    文件寫 gemini-2.5-flash 免費層是 RPM 15 / RPD 1500，我們據此把
 *    PER_DAY 設成 1200，結果評測跑到一半整批失敗。實際去問對方
 *    （2026-09-16 實測）拿到的是：
 *
 *      quotaId = GenerateRequestsPerDayPerProjectPerModel-FreeTier
 *      value   = 20
 *
 *    **每天 20 次**，不是 1500。差了 75 倍，而且症狀是「模型答不出來」，
 *    不是「額度用完」—— 因為我們自己的節流永遠不會先跳出來擋。
 *
 *    一題要兩次呼叫（選章 + 作答），所以這等於**每天 10 題**。這不是
 *    調參數能解決的，是產品層級的限制，見架構決策第十二節。
 *
 *    用 env 覆寫：開了付費層或換模型之後改 .env，不要改這裡。
 */
const RATE = {
	MIN_INTERVAL_MS: 1500,
	PER_MINUTE: Number(process.env.GEMINI_RPM) || 10,
	PER_DAY: Number(process.env.GEMINI_RPD) || 20,
	MAX_RETRY: 2,
};

const db = new DatabaseSync(new URL('./db/ruling.db', import.meta.url).pathname);
db.exec(`
	CREATE TABLE IF NOT EXISTS llm_usage (
		day    TEXT PRIMARY KEY,
		calls  INTEGER NOT NULL DEFAULT 0,
		tokens INTEGER NOT NULL DEFAULT 0,
		errors INTEGER NOT NULL DEFAULT 0
	);
`);
const stmt_bump = db.prepare(`
	INSERT INTO llm_usage (day, calls, tokens, errors) VALUES (?, ?, ?, ?)
	ON CONFLICT(day) DO UPDATE SET
		calls = calls + excluded.calls,
		tokens = tokens + excluded.tokens,
		errors = errors + excluded.errors
`);
const stmt_usage = db.prepare('SELECT day, calls, tokens, errors FROM llm_usage ORDER BY day DESC LIMIT ?');

// ⚠️ 用太平洋時間的日期當 key。用 UTC 的話我們的「今天」會橫跨對方
//    兩個配額日，帳對不起來 —— 實際看到過「今天 27 次」卻撞到 20 次上限。
function today() {
	return quota_day();
}

/** 近幾天的用量。⚠️ 這不是儀表板，是「撞到上限時知道為什麼」的最低限度。 */
export function usage(days = 7) {
	return { days: stmt_usage.all(days), window: stats('gemini') };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 從 429 的回應體挖出「該等多久」與「撞到哪一條配額」。
 *
 * ⚠️ 這兩件事對方**有寫在回應裡**，而第一版把整段當純文字截 200 字丟掉了。
 *    後果是評測跑完只看到「HTTP 429」，分不出撞的是每分鐘還是每日 ——
 *    前者等一下就好，後者今天不用再跑了，處置完全相反。
 *
 *    details 裡會有：
 *      RetryInfo    { retryDelay: "26s" }
 *      QuotaFailure { violations: [{ quotaId: "...PerMinutePerProjectPerModel" }] }
 */
function parse_429(text) {
	let delay_ms = 0;
	const quotas = [];
	try {
		for (const d of JSON.parse(text)?.error?.details ?? []) {
			const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay ?? '');
			if (m)
				delay_ms = Math.round(parseFloat(m[1]) * 1000);
			for (const v of d.violations ?? []) {
				if (v.quotaId)
					quotas.push(v.quotaId);
			}
		}
	}
	catch { /* 回應不是 JSON 就只能靠預設退避 */ }
	return { delay_ms, quota: quotas.join('、') };
}

/**
 * 呼叫 Gemini。
 *
 * @param {string} prompt
 * @param {{ json?: boolean, max_tokens?: number, temperature?: number }} opts
 * @returns {Promise<{ text: string } | { error: string }>}
 *   ⚠️ 失敗回的是 `{error}` 而不是丟例外 —— 呼叫端幾乎都要走降級路徑，
 *      用回傳值表達比 try/catch 清楚。
 */
export async function generate(prompt, opts = {}) {
	if (!KEY)
		return { error: 'GEMINI_API_KEY 沒設' };

	// ⚠️ 撞到每分鐘上限時要「等」還是「失敗」，取決於呼叫端是誰：
	//    互動中的使用者 → 快速失敗，讓他知道現在忙（等 30 秒更糟）
	//    批次評測       → 等，否則 30 次呼叫會有大半變成「作答失敗」，
	//                     而那看起來像模型答不出來，不是節流
	const limits = { per_minute: RATE.PER_MINUTE, per_day: RATE.PER_DAY, day_reset: 'pacific' };
	let blocked = blocked_reason('gemini', limits);
	if (blocked && opts.wait_for_slot) {
		const deadline = Date.now() + (opts.wait_max_ms ?? 120_000);
		while (blocked && Date.now() < deadline) {
			// 每日上限等不到，只有每分鐘的滾動視窗會自己空出來
			if (blocked.includes('每日'))
				break;
			await sleep(5000);
			blocked = blocked_reason('gemini', limits);
		}
	}
	if (blocked)
		return { error: `節流：${blocked}` };

	const body = {
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: {
			temperature: opts.temperature ?? 0.2,
			maxOutputTokens: opts.max_tokens ?? 2048,
			// ⚠️ 2.5 起的 Flash 是思考型模型，**思考用掉的 token 也算在
			//    maxOutputTokens 裡**。純檢索那種不需要推理的任務要把它關掉
			//    （thinkingBudget: 0），否則額度全被推理吃光、輸出被截斷，
			//    而截斷的 JSON 解析失敗之後看起來像「查無結果」。
			...(opts.thinking_budget !== undefined
				? { thinkingConfig: { thinkingBudget: opts.thinking_budget } }
				: {}),
			...(opts.json ? { responseMimeType: 'application/json' } : {}),
		},
	};

	let last_429 = '';
	for (let attempt = 0; attempt <= RATE.MAX_RETRY; attempt++) {
		const wait = wait_ms('gemini', RATE.MIN_INTERVAL_MS);
		if (wait > 0)
			await sleep(wait);
		// ⚠️ 發出前就記。失敗的請求對方一樣算，我們也要算。
		record('gemini');

		let res;
		try {
			res = await fetch(`${BASE}/${MODEL}:generateContent`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
				body: JSON.stringify(body),
			});
		}
		catch (err) {
			stmt_bump.run(today(), 1, 0, 1);
			return { error: `連線失敗：${err.message}` };
		}

		// 429 是免費層最常見的失敗。⚠️ 退避時間要聽對方的，不要自己猜 ——
		//    每分鐘配額的 retryDelay 常常是 20-60 秒，而第一版只等 2 秒、
		//    4 秒就放棄，於是三次嘗試在 6 秒內燒掉、還多送兩次請求進去。
		if (res.status === 429) {
			const raw = await res.text();
			const { delay_ms, quota } = parse_429(raw);
			last_429 = quota || '未指明配額';
			// 互動中的使用者等不了一分鐘，批次評測可以。
			const cap = opts.wait_for_slot ? 70_000 : 5_000;
			const need = delay_ms || 2000 * (attempt + 1);
			// 要求等的時間超過上限就不重試了 —— 那通常是每日配額，
			// 硬等下去只是讓使用者多盯著「思考中」而已。
			if (attempt < RATE.MAX_RETRY && need <= cap) {
				await sleep(need);
				continue;
			}
			stmt_bump.run(today(), 1, 0, 1);
			return { error: `HTTP 429（配額：${last_429}）${delay_ms ? `，對方要求等 ${Math.round(delay_ms / 1000)} 秒` : ''}` };
		}
		if (!res.ok) {
			stmt_bump.run(today(), 1, 0, 1);
			const detail = (await res.text()).slice(0, 200);
			return { error: `HTTP ${res.status}：${detail}` };
		}

		const data = await res.json();
		const cand = data.candidates?.[0];
		const text = cand?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
		const finish = cand?.finishReason ?? '未知';
		const tokens = data.usageMetadata?.totalTokenCount ?? 0;

		// ⚠️ 截斷**必須當成錯誤**。回一段不完整的 JSON 給呼叫端的話，
		//    它解析失敗之後會退化成「查無結果」—— 那跟「呼叫失敗」是完全
		//    不同的兩件事，而症狀長得一模一樣。這個坑踩過一次。
		// ⚠️ 截斷與空回應要記成 **errors**，不是成功。原本它們排在
		//    stmt_bump(…, 0) 後面，於是使用者收到錯誤、計數器卻寫著
		//    「2 次呼叫、0 個錯誤」—— 查的人會往完全錯誤的方向找。
		//    HTTP 成功不等於這次呼叫成功。
		if (finish === 'MAX_TOKENS') {
			stmt_bump.run(today(), 1, tokens, 1);
			return { error: '輸出被截斷（maxOutputTokens 不足；思考型模型的推理也算在內）' };
		}
		if (!text) {
			stmt_bump.run(today(), 1, tokens, 1);
			return { error: `空回應（finishReason=${finish}）` };
		}
		stmt_bump.run(today(), 1, tokens, 0);
		return { text };
	}
	stmt_bump.run(today(), 1, 0, 1);
	return { error: `重試後仍然失敗（429${last_429 ? `，配額：${last_429}` : ''}）` };
}

/** 目前用的模型，寫進回覆的出處資訊用。 */
export function model_name() {
	return MODEL;
}
