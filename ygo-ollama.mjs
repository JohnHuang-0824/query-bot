/**
 * Ollama 呼叫層（本機模型）。介面與 ygo-gemini.mjs 的 generate() 相同，
 * 由 ygo-llm.mjs 依 LLM_PROVIDER=ollama 選用。
 *
 * 定位：開發與評測用 —— 沒有額度、沒有費用，可以無限次地跑管線。
 * ⚠️ 它的評測分數不能拿來跟 Gemini／Claude 直接比較，更不能當正式作答的品質依據。
 *
 * ⚠️ **num_ctx 一定要明講。** Ollama 的預設上下文很短，而第二段的 prompt 可以到
 *    幾萬 token；超過時它會**靜默截斷**，模型根本沒看到依據，症狀只是「拒答」。
 *    所以這裡用回應裡的 prompt_eval_count 偵測：用量貼到 num_ctx 上限就當成錯誤。
 *
 * 用串流（stream: true）：非串流要等整段生成完才送 header，本機慢的時候會撞到
 * undici 的 headersTimeout（5 分鐘）。
 */

const BASE = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const MODELS = {
	select: process.env.OLLAMA_MODEL_SELECT || process.env.OLLAMA_MODEL || 'qwen2.5:7b',
	answer: process.env.OLLAMA_MODEL_ANSWER || process.env.OLLAMA_MODEL || 'qwen2.5:7b',
};
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 16384;
// 輸出上限。⚠️ Ollama 的 prompt 可用空間 = num_ctx − num_predict。呼叫端為雲端模型設的
//    max_tokens（例如 8192，含思考預算）直接套過來，會把 16384 的上下文吃掉一半，prompt 被
//    靜默截斷到 8192 —— 實測 rules-012 就是這樣，兩次 prompt 都剛好 8194 token。
//    本機模型沒有思考預算，答案本身 2048 綽綽有餘。
const NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT) || 2048;
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 15 * 60_000;

const JSON_SYSTEM = '只輸出一個 JSON 物件，不要有任何其他文字、說明或 markdown 程式碼框。';

let calls = 0;
let errors = 0;
let tokens = 0;

export function usage() {
	return { days: [], window: { calls, errors, tokens }, quota_block: null };
}

/**
 * @param {string} prompt
 * @param {{ stage?: 'select'|'answer', json?: boolean, max_tokens?: number, temperature?: number }} opts
 * @returns {Promise<{ text: string, meta?: object } | { error: string }>}
 */
export async function generate(prompt, opts = {}) {
	const model = MODELS[opts.stage] ?? MODELS.answer;
	const body = {
		model,
		stream: true,
		messages: [
			...(opts.json ? [{ role: 'system', content: JSON_SYSTEM }] : []),
			{ role: 'user', content: prompt },
		],
		options: {
			temperature: opts.temperature ?? 0.2,
			num_ctx: NUM_CTX,
			num_predict: Math.min(opts.max_tokens ?? NUM_PREDICT, NUM_PREDICT),
		},
		...(opts.json ? { format: 'json' } : {}),
	};

	// ⚠️ 送出前先估算。Ollama 的 prompt 超過 num_ctx 時不報錯，而是**把它砍到約一半**
	//    （實測：num_ctx 16384 的 ~20k token prompt 回報 prompt_eval_count = 8194），
	//    所以事後看回報的數字抓不到 —— 數字看起來很正常，只是依據被丟了一半。
	//    純簡中約 0.54 token/字，但 prompt 混了日文裁定與繁中，實測整份約 0.95 token/字（25k 字 = 24224 token），取 1.0 保守估。
	const est_tokens = Math.ceil(prompt.length * 1.0);
	if (est_tokens + body.options.num_predict > NUM_CTX) {
		return { error: `提示估計約 ${est_tokens} token，加上輸出 ${body.options.num_predict} 超過 num_ctx ${NUM_CTX}，會被靜默截斷；調高 OLLAMA_NUM_CTX` };
	}

	calls++;
	const started = Date.now();
	let res;
	try {
		res = await fetch(`${BASE}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	}
	catch (err) {
		errors++;
		return { error: `連線失敗（${BASE}）：${err.message}` };
	}
	if (!res.ok) {
		errors++;
		return { error: `HTTP ${res.status}：${(await res.text()).slice(0, 300)}` };
	}

	let text = '';
	let final = null;
	try {
		const decoder = new TextDecoder();
		let buf = '';
		for await (const chunk of res.body) {
			buf += decoder.decode(chunk, { stream: true });
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line)
					continue;
				const obj = JSON.parse(line);
				if (obj.error) {
					errors++;
					return { error: `Ollama：${obj.error}` };
				}
				text += obj.message?.content ?? '';
				if (obj.done)
					final = obj;
			}
		}
	}
	catch (err) {
		errors++;
		return { error: `讀取回應失敗：${err.message}` };
	}

	const prompt_tokens = final?.prompt_eval_count ?? 0;
	const out_tokens = final?.eval_count ?? 0;
	tokens += prompt_tokens + out_tokens;
	const meta = { model, prompt_tokens, out_tokens, num_ctx: NUM_CTX, ms: Date.now() - started };
	if (process.env.YGO_DEBUG)
		console.log(`[ollama] ${JSON.stringify(meta)}`);

	// 事後再檢查一次：回報的 token 數遠少於字數該有的量，代表被砍過（估算漏掉的情況）。
	if (prompt_tokens < prompt.length * 0.3) {
		errors++;
		return { error: `疑似被截斷（${prompt.length} 字只算出 ${prompt_tokens} token）；調高 OLLAMA_NUM_CTX`, meta };
	}
	if (final?.done_reason === 'length') {
		errors++;
		return { error: `輸出被截斷（num_predict ${body.options.num_predict} 不足）`, meta };
	}
	if (!text.trim()) {
		errors++;
		return { error: `空回應（done_reason=${final?.done_reason ?? '未知'}）`, meta };
	}
	return { text, meta };
}

export function model_name() {
	return MODELS.select === MODELS.answer ? `ollama:${MODELS.answer}` : `ollama:${MODELS.select} → ${MODELS.answer}`;
}
