/**
 * LLM 供應者切換。
 *
 *   LLM_PROVIDER         gemini（預設）| claude | ollama（本機，開發評測用）
 *   LLM_PROVIDER_SELECT  只覆寫第一段（選章節、抽卡名）的供應者
 *   LLM_PROVIDER_ANSWER  只覆寫第二段（作答）的供應者
 *
 * 混合用的典型設定：第一段雲端、第二段本機 ——
 *   LLM_PROVIDER_SELECT=gemini
 *   LLM_PROVIDER_ANSWER=ollama
 * 實測 7B 本機模型選章節不準（挑不到「傷害步驟」），但第一段每題只要 1 次
 * 雲端請求，把需要長上下文的第二段留在本機就能把雲端請求減半。
 *
 * 呼叫端只認這個檔。各家的 generate(prompt, opts) 介面相同，回傳
 * `{text}` 或 `{error}`；opts.stage（'select' | 'answer'）決定走哪一家。
 *
 * ⚠️ 換供應者就等於換模型，要重跑評測用數字比較。
 */

import * as gemini from './ygo-gemini.mjs';
import * as claude from './ygo-claude.mjs';
import * as ollama from './ygo-ollama.mjs';

const PROVIDERS = { gemini, claude, ollama };
const pick = (key, fallback) => {
	const name = (process.env[key] || fallback).toLowerCase();
	if (!PROVIDERS[name])
		throw new Error(`${key} 只能是 ${Object.keys(PROVIDERS).join('、')}，收到 "${name}"`);
	return name;
};

const base = pick('LLM_PROVIDER', 'gemini');
const by_stage = {
	select: pick('LLM_PROVIDER_SELECT', base),
	answer: pick('LLM_PROVIDER_ANSWER', base),
};

export const provider = by_stage.select === by_stage.answer
	? by_stage.answer
	: `${by_stage.select}+${by_stage.answer}`;

export function generate(prompt, opts = {}) {
	// 沒標 stage 的呼叫當成作答
	return PROVIDERS[by_stage[opts.stage] ?? by_stage.answer].generate(prompt, opts);
}

/** 寫進回覆出處資訊用。兩段模型不同時兩個都列。 */
export function model_name() {
	if (by_stage.select === by_stage.answer)
		return PROVIDERS[by_stage.answer].model_name();
	return `${PROVIDERS[by_stage.select].model_name()} → ${PROVIDERS[by_stage.answer].model_name()}`;
}

export function usage(days) {
	const out = {};
	for (const name of new Set(Object.values(by_stage)))
		out[name] = PROVIDERS[name].usage(days);
	return out;
}
