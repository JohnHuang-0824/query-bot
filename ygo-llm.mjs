/**
 * LLM 供應者切換。LLM_PROVIDER=gemini（預設）| claude。
 *
 * 呼叫端只認這個檔。兩邊的 generate(prompt, opts) 介面相同，回傳
 * `{text}` 或 `{error}`；opts.stage（'select' | 'answer'）給 Claude 挑模型，
 * Gemini 忽略它。
 *
 * ⚠️ 換供應者就等於換模型，要重跑評測用數字比較。
 */

import * as gemini from './ygo-gemini.mjs';
import * as claude from './ygo-claude.mjs';

const PROVIDERS = { gemini, claude };
const name = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
const impl = PROVIDERS[name];
if (!impl)
	throw new Error(`LLM_PROVIDER 只能是 ${Object.keys(PROVIDERS).join(' 或 ')}，收到 "${name}"`);

export const provider = name;
export const generate = impl.generate;
export const model_name = impl.model_name;
export const usage = impl.usage;
