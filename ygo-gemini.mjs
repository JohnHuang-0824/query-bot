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
import { blocked_reason, wait_ms, record, stats } from './ygo-throttle.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = process.env.GEMINI_API_KEY;

/**
 * ⚠️ 免費層的限制比你想的緊（Flash 系列大約每分鐘十次等級）。
 *    這裡刻意抓得比官方數字保守 —— 撞到 429 的代價是使用者等不到回答，
 *    而慢一點只是慢一點。
 */
// 官方免費層（gemini-2.5-flash）：RPM 15、RPD 1500、TPM 100 萬。
// 自訂值刻意壓在官方之下留餘裕 —— 撞到 429 的代價是使用者等不到回答。
const RATE = {
	MIN_INTERVAL_MS: 1500,
	PER_MINUTE: 10,
	PER_DAY: 1200,
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

function today() {
	return new Date().toISOString().slice(0, 10);
}

/** 近幾天的用量。⚠️ 這不是儀表板，是「撞到上限時知道為什麼」的最低限度。 */
export function usage(days = 7) {
	return { days: stmt_usage.all(days), window: stats('gemini') };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
	const limits = { per_minute: RATE.PER_MINUTE, per_day: RATE.PER_DAY };
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

		// 429 是免費層最常見的失敗，退避後重試。其他 4xx 重試也沒用。
		if (res.status === 429 && attempt < RATE.MAX_RETRY) {
			await sleep(2000 * (attempt + 1));
			continue;
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
		stmt_bump.run(today(), 1, data.usageMetadata?.totalTokenCount ?? 0, 0);

		// ⚠️ 截斷**必須當成錯誤**。回一段不完整的 JSON 給呼叫端的話，
		//    它解析失敗之後會退化成「查無結果」—— 那跟「呼叫失敗」是完全
		//    不同的兩件事，而症狀長得一模一樣。這個坑踩過一次。
		if (finish === 'MAX_TOKENS')
			return { error: `輸出被截斷（maxOutputTokens 不足；思考型模型的推理也算在內）` };
		if (!text)
			return { error: `空回應（finishReason=${finish}）` };
		return { text };
	}
	stmt_bump.run(today(), 1, 0, 1);
	return { error: '重試後仍然失敗（429）' };
}

/** 目前用的模型，寫進回覆的出處資訊用。 */
export function model_name() {
	return MODEL;
}
