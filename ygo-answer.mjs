/**
 * 作答管線：問題 → 依據 → 繁中回答。
 *
 * 兩段式（架構決策第八節）：
 *   第一段  目錄 + 問題 → 模型挑章節、抽卡名
 *   第二段  章節原文 + 官方裁定 + 問題 → 繁中回答
 *
 * ⚠️ 這個檔案的重點不是「怎麼問模型」，是**怎麼不相信它**。
 *    第二段回來之後每一個引用都會被驗證對得回我們送進去的東西，對不
 *    回去的整個回答就作廢改成拒答。引用因此是程式保證的不變量，不是
 *    prompt 裡的一句期望。
 */

import { generate, model_name } from './ygo-gemini.mjs';
import { build_toc, collect_sections, get_section, corpus_state } from './ygo-rules.mjs';
import { resolve_id, display_name } from './ygo-alias.mjs';
import { get_card } from './ygo-query.mjs';
import { cache_state, fetch_rulings, get_rulings, get_ruling, ensure_detail } from './ygo-ruling.mjs';

const MAX_SECTIONS = 3;
const MAX_CARDS = 3;
const MAX_RULINGS = 6;

/* ------------------------------------------------------------------ 第一段 */

const SELECT_PROMPT = (toc, question) => `你是遊戲王規則資料的檢索助手。下面是規則文件的目錄，每行是「編號<TAB>章節路徑」。

${toc}

使用者的問題：
${question}

請輸出 JSON，不要有其他文字：
{"sections":[編號,…],"cards":["卡名",…]}

規則：
- sections 最多 ${MAX_SECTIONS} 個，挑最可能包含答案的章節編號。
  ⚠️ 只有在目錄裡**完全沒有任何相關主題**時才給空陣列 —— 主題沾得上邊就挑出來，
  後面還有一關會判斷依據夠不夠。
- cards 是問題裡提到的卡片名稱，原樣抄出來，最多 ${MAX_CARDS} 個。沒提到卡就給空陣列。
- 目錄是簡體中文，問題可能是繁體中文或日文，請自行對應。`;

function parse_json(text) {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m)
		return null;
	try {
		return JSON.parse(m[0]);
	}
	catch {
		return null;
	}
}

/* ------------------------------------------------------------------ 第二段 */

const ANSWER_PROMPT = (question, rules, rulings) => `你是遊戲王規則的說明助手。只能根據下面提供的「依據」回答，不能使用依據以外的知識。

=== 依據 A：規則文件（簡體中文，來源 OCG Rule）===
${rules.length ? rules.map(r => `[規則 ${r.id}] ${r.path}\n${r.body}`).join('\n\n---\n\n') : '（沒有提供）'}

=== 依據 B：官方裁定（日文，來源 Konami 官方資料庫）===
${rulings.length ? rulings.map(r => `[裁定 ${r.fid}] 更新 ${r.updated_at ?? '—'}\nQ: ${r.question}\nA: ${r.answer ?? '（未取得全文）'}`).join('\n\n---\n\n') : '（沒有提供）'}

=== 使用者的問題 ===
${question}

請輸出 JSON，不要有其他文字：
{"refused":布林,"answer":"繁體中文回答","cites":[{"type":"rule","id":數字},{"type":"ruling","id":數字}]}

必須遵守的規則：
1. **回答用繁體中文**，但引用依據裡的原文時**一字不改地照抄**，不要翻譯、不要改寫。
2. 每一個結論都要有依據。**cites 只能填上面出現過的編號**，不可以自己編。
3. ⚠️ **判斷依據夠不夠的標準是「有沒有直接回答使用者問的那個情境」，不是「相不相關」。**
   依據只是主題相關、卻沒有涵蓋問題問的那個具體狀況時，refused 設為 true。
   例如使用者問「A 卡對上 B 卡會怎樣」，而依據只有 A 卡自己的說明、沒有提到這個組合，
   那就是不夠 —— 即使你覺得可以從 A 卡的性質推出答案，也要拒答。
4. ⚠️ ⚠️ **絕對不要把多條依據組合起來推論出一個新結論。**
   每條依據只能用來回答它自己涵蓋的情況。用兩三條各自正確的依據推出一個它們都沒說過的
   結論，是這個系統最嚴重的錯誤 —— 它看起來有憑有據，實際上是你編的。
5. 拒答時 answer 要寫明「查無直接涵蓋這個情況的依據」，並建議洽裁判或官方事務局。
   **不要用「一般來說」「應該是」「推測」這種說法把推論講成事實。**
6. 回答時**保留遊戲王的術語原樣**（cost、連鎖、時點、效果處理等），不要翻譯成日常用語。
7. 規則文件是社群整理的，官方裁定才是官方的。兩者衝突時以官方裁定為準，並說明。
8. answer 控制在 800 字以內。`;

/* ------------------------------------------------------------------ 主流程 */

/**
 * 回答一個問題。
 *
 * @param {string} question
 * @param {{ allow_fetch?: boolean }} opts
 * @returns {Promise<{
 *   refused: boolean, answer: string, model: string,
 *   rule_ids: number[], ruling_fids: number[], cards: string[],
 *   error?: string, dropped?: string[]
 * }>}
 */
export async function answer_question(question, opts = {}) {
	const allow_fetch = opts.allow_fetch ?? true;
	// 批次評測時傳 wait_for_slot，讓節流變成等待而不是失敗
	const gen = { wait_for_slot: opts.wait_for_slot === true };
	const base = { model: model_name(), rule_ids: [], ruling_fids: [], cards: [] };

	if (!corpus_state().sections)
		return { ...base, refused: true, answer: '規則語料還沒匯入，無法作答。', error: '語料為空' };

	// --- 第一段：挑章節、抽卡名 ---
	const sel_res = await generate(SELECT_PROMPT(build_toc(), question), { json: true, max_tokens: 3000, ...gen });
	if (sel_res.error)
		return { ...base, refused: true, answer: '目前無法查詢，請稍後再試。', error: sel_res.error };

	const sel = parse_json(sel_res.text) ?? {};
	const section_ids = (Array.isArray(sel.sections) ? sel.sections : [])
		.map(Number).filter(Number.isInteger).slice(0, MAX_SECTIONS)
		.filter(id => get_section(id));
	const card_names = (Array.isArray(sel.cards) ? sel.cards : []).slice(0, MAX_CARDS);

	// --- 蒐集依據 ---
	const rules = collect_sections(section_ids);

	const rulings = [];
	const resolved = [];
	for (const name of card_names) {
		const id = resolve_id(name);
		if (id === null)
			continue;
		const card = get_card(id);
		if (!card?.cid)
			continue;
		resolved.push(display_name(id));
		if (allow_fetch && !cache_state(card.cid).fetched)
			await fetch_rulings(card.cid);
		for (const r of get_rulings(card.cid).slice(0, MAX_RULINGS)) {
			if (!rulings.some(x => x.fid === r.fid))
				rulings.push(r);
		}
	}
	// 只把要送進去的那幾條抓全文，其餘留標題就好 —— 每多一條就是一次請求。
	for (const r of rulings.slice(0, MAX_RULINGS)) {
		if (!r.answer && allow_fetch)
			await ensure_detail(r.fid);
	}
	const ruling_ctx = rulings.slice(0, MAX_RULINGS)
		.map(r => get_ruling(r.fid) ?? r);

	if (!rules.length && !ruling_ctx.length) {
		return {
			...base, cards: resolved, refused: true,
			answer: '查無可用的依據（規則章節與官方裁定都沒有命中）。這不代表可以自行推論結果 —— 請洽裁判或官方事務局。',
		};
	}

	// --- 第二段：作答 ---
	const ans_res = await generate(ANSWER_PROMPT(question, rules, ruling_ctx), { json: true, max_tokens: 4096, ...gen });
	if (ans_res.error)
		return { ...base, cards: resolved, refused: true, answer: '目前無法查詢，請稍後再試。', error: ans_res.error };

	const parsed = parse_json(ans_res.text);
	if (!parsed || typeof parsed.answer !== 'string')
		return { ...base, cards: resolved, refused: true, answer: '回覆格式不正確，已中止。', error: '模型輸出不是預期的 JSON' };

	// --- ⚠️ 引用驗證：對不回去的引用一律丟掉 ---
	//
	// 這是整個檔案的重點。模型「引用」了一個我們沒送進去的編號，代表它
	// 在編 —— 那種回答比沒有回答危險得多，因為它看起來有出處。
	const rule_ok = new Set(rules.map(r => r.id));
	const ruling_ok = new Set(ruling_ctx.map(r => r.fid));
	const cites = Array.isArray(parsed.cites) ? parsed.cites : [];
	const dropped = [];
	const rule_ids = [];
	const ruling_fids = [];
	// ⚠️ 編號欄位名要寬容，**允許的編號集合要嚴格**。
	//    prompt 裡規則用 id、裁定用 fid，模型實測會把兩者都寫成 id ——
	//    踩過一次：fid 24022（炎王の聖域 × 羽根帚，確實有送進去）被當成
	//    編造，整個正確的回答被作廢成拒答。認錯欄位名不是編造，只有
	//    「這個編號我們沒送過」才是。
	for (const c of cites) {
		const n = Number(c?.fid ?? c?.id);
		if (c?.type === 'rule' && rule_ok.has(n))
			rule_ids.push(n);
		else if (c?.type === 'ruling' && ruling_ok.has(n))
			ruling_fids.push(n);
		else
			dropped.push(JSON.stringify(c));
	}

	const refused = parsed.refused === true;

	// 沒拒答卻一個有效引用都沒有 → 整個回答作廢。
	// ⚠️ 不要只是把引用拿掉照樣顯示 —— 沒有出處的規則回答就是猜測，
	//    而使用者分不出來。
	if (!refused && !rule_ids.length && !ruling_fids.length) {
		return {
			...base, cards: resolved, refused: true, dropped,
			answer: '這題找不到可以對應的依據，因此不提供結論 —— 請洽裁判或官方事務局。',
		};
	}

	return {
		model: model_name(),
		refused,
		answer: parsed.answer.trim(),
		rule_ids, ruling_fids, cards: resolved,
		...(dropped.length ? { dropped } : {}),
	};
}
