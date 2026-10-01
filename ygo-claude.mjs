/**
 * Claude 呼叫層。介面與 ygo-gemini.mjs 的 generate() 完全相同，
 * 由 ygo-llm.mjs 依 LLM_PROVIDER 選用。
 *
 * 一樣用 REST 直接打，不裝 SDK —— 理由同 ygo-gemini.mjs：這個 fork 只有
 * discord.js 一個依賴。
 *
 * ⚠️ 兩段用不同模型（opts.stage）：
 *    select  挑章節、抽卡名，是從目錄挑編號的檢索工作 → Haiku
 *    answer  繁中作答加引用 → Sonnet
 *    模型要釘死版本，理由同 Gemini 那邊：換模型要靠評測數字比較。
 *
 * ⚠️ Claude 沒有 responseMimeType。opts.json 只能靠 prompt 要求「只輸出
 *    JSON」，不用 assistant prefill（新一代模型不一定接受）。呼叫端的
 *    parse_json 本來就會從回應裡擷取 {...}，所以多餘文字不致命。
 *
 * ⚠️ 沒有每日硬上限，只有依儲值等級的每分鐘上限。CLAUDE_RPM 照 console
 *    顯示的數字填，不要猜。
 */

import { DatabaseSync } from 'node:sqlite';
import { blocked_reason, wait_ms, record, stats, quota_day } from './ygo-throttle.mjs';

const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';
const KEY = process.env.ANTHROPIC_API_KEY;
const MODELS = {
	select: process.env.CLAUDE_MODEL_SELECT || 'claude-haiku-4-5-20251001',
	answer: process.env.CLAUDE_MODEL_ANSWER || 'claude-sonnet-5-5',
};

const RATE = {
	MIN_INTERVAL_MS: 200,
	PER_MINUTE: Number(process.env.CLAUDE_RPM) || 30,
	// 沒有每日硬上限；給一個誇張的數字讓 blocked_reason 永遠不因每日跳出
	PER_DAY: Number(process.env.CLAUDE_RPD) || 1_000_000,
	MAX_RETRY: 2,
};

const JSON_SYSTEM = '只輸出一個 JSON 物件，不要有任何其他文字、說明或 markdown 程式碼框。';

const db = new DatabaseSync(new URL('./db/ruling.db', import.meta.url).pathname);
db.exec(`
	CREATE TABLE IF NOT EXISTS claude_usage (
		day    TEXT PRIMARY KEY,
		calls  INTEGER NOT NULL DEFAULT 0,
		tokens INTEGER NOT NULL DEFAULT 0,
		errors INTEGER NOT NULL DEFAULT 0
	);
`);
const stmt_bump = db.prepare(`
	INSERT INTO claude_usage (day, calls, tokens, errors) VALUES (?, ?, ?, ?)
	ON CONFLICT(day) DO UPDATE SET
		calls = calls + excluded.calls,
		tokens = tokens + excluded.tokens,
		errors = errors + excluded.errors
`);
const stmt_usage = db.prepare('SELECT day, calls, tokens, errors FROM claude_usage ORDER BY day DESC LIMIT ?');

export function usage(days = 7) {
	return { days: stmt_usage.all(days), window: stats('claude') };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} prompt
 * @param {{ stage?: 'select'|'answer', json?: boolean, max_tokens?: number,
 *           temperature?: number, wait_for_slot?: boolean, wait_max_ms?: number }} opts
 * @returns {Promise<{ text: string } | { error: string }>}
 */
export async function generate(prompt, opts = {}) {
	if (!KEY)
		return { error: 'ANTHROPIC_API_KEY 沒設' };

	const limits = { per_minute: RATE.PER_MINUTE, per_day: RATE.PER_DAY };
	let blocked = blocked_reason('claude', limits);
	if (blocked && opts.wait_for_slot) {
		const deadline = Date.now() + (opts.wait_max_ms ?? 120_000);
		while (blocked && Date.now() < deadline) {
			if (blocked.includes('每日'))
				break;
			await sleep(5000);
			blocked = blocked_reason('claude', limits);
		}
	}
	if (blocked)
		return { error: `節流：${blocked}` };

	const body = {
		model: MODELS[opts.stage] ?? MODELS.answer,
		max_tokens: opts.max_tokens ?? 2048,
		temperature: opts.temperature ?? 0.2,
		messages: [{ role: 'user', content: prompt }],
		...(opts.json ? { system: JSON_SYSTEM } : {}),
	};

	for (let attempt = 0; attempt <= RATE.MAX_RETRY; attempt++) {
		const wait = wait_ms('claude', RATE.MIN_INTERVAL_MS);
		if (wait > 0)
			await sleep(wait);
		// ⚠️ 發出前就記。失敗的請求對方一樣算，我們也要算。
		record('claude');

		let res;
		try {
			res = await fetch(URL_MESSAGES, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': KEY,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify(body),
			});
		}
		catch (err) {
			stmt_bump.run(quota_day(), 1, 0, 1);
			return { error: `連線失敗：${err.message}` };
		}

		// 429 與 529（過載）都是「等一下再來」。退避時間聽對方的 retry-after。
		if (res.status === 429 || res.status === 529) {
			await res.text();
			const delay_ms = Math.round(parseFloat(res.headers.get('retry-after') ?? '') * 1000) || 2000 * (attempt + 1);
			const cap = opts.wait_for_slot ? 70_000 : 5_000;
			if (attempt < RATE.MAX_RETRY && delay_ms <= cap) {
				await sleep(delay_ms);
				continue;
			}
			stmt_bump.run(quota_day(), 1, 0, 1);
			return { error: `HTTP ${res.status}，對方要求等 ${Math.round(delay_ms / 1000)} 秒` };
		}
		if (!res.ok) {
			const detail = (await res.text()).slice(0, 300);
			// 部分新模型不接受 temperature。只退一次，拿掉它重送。
			if (res.status === 400 && 'temperature' in body && /temperature/i.test(detail)) {
				delete body.temperature;
				continue;
			}
			stmt_bump.run(quota_day(), 1, 0, 1);
			return { error: `HTTP ${res.status}：${detail}` };
		}

		const data = await res.json();
		const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
		const tokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

		// ⚠️ 截斷必須當成錯誤，理由與 ygo-gemini.mjs 相同：截斷的 JSON 解析失敗
		//    之後會退化成「查無結果」，跟「呼叫失敗」症狀一模一樣。
		if (data.stop_reason === 'max_tokens') {
			stmt_bump.run(quota_day(), 1, tokens, 1);
			return { error: '輸出被截斷（max_tokens 不足）' };
		}
		if (!text) {
			stmt_bump.run(quota_day(), 1, tokens, 1);
			return { error: `空回應（stop_reason=${data.stop_reason ?? '未知'}）` };
		}
		stmt_bump.run(quota_day(), 1, tokens, 0);
		return { text };
	}
	stmt_bump.run(quota_day(), 1, 0, 1);
	return { error: '重試後仍然失敗' };
}

/** 寫進回覆出處資訊用。兩段模型不同時兩個都列。 */
export function model_name() {
	return MODELS.select === MODELS.answer ? MODELS.answer : `${MODELS.select} → ${MODELS.answer}`;
}
