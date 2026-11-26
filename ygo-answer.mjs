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

import { generate, model_name } from './ygo-llm.mjs';
import { build_toc, collect_sections, expand_stubs, get_section, toc_rows, corpus_state } from './ygo-rules.mjs';
import { resolve_id, display_name } from './ygo-alias.mjs';
import { get_card } from './ygo-query.mjs';
import { cache_state, fetch_rulings, get_rulings, get_ruling, ensure_detail } from './ygo-ruling.mjs';

// ⚠️ 3 節太少。實測「P 牌放進 P 區算不算魔法卡的發動」這題：關鍵那句話
//    在[21] 卡的发动，而目錄裡標題含「发动」的章節就有 50 節 —— 只挑 3 節
//    等於在賭運氣。dev 挑中了、Pi 沒挑中，同一題一邊肯定作答一邊拒答。
//
//    多挑幾節的代價是 token，而**稀缺的是請求數不是 token**（每天 20 次
//    請求 vs 每分鐘 100 萬 token）。拿不缺的換會缺的，很划算。
const MAX_SECTIONS = 6;
const MAX_CARDS = 5;
const MAX_RULINGS = 6;
// 單張卡的效果文本上限。⚠️ 要截就截尾巴，不要截頭 —— 效果文字的條件在前。
const MAX_CARD_TEXT = 1500;

/* ------------------------------------------------------------------ 第一段 */

export const SELECT_PROMPT = (toc, question) => `你是遊戲王規則資料的檢索助手。下面是規則文件的目錄，每行是「編號<TAB>章節路徑」。

${toc}

使用者的問題：
${question}

請輸出 JSON，不要有其他文字：
{"sections":[編號,…],"cards":["卡名",…]}

規則：
- sections 最多 ${MAX_SECTIONS} 個，挑最可能包含答案的章節編號。
  ⚠️ 只有在目錄裡**完全沒有任何相關主題**時才給空陣列 —— 主題沾得上邊就挑出來，
  後面還有一關會判斷依據夠不夠。
  ⚠️ **問題裡出現的關鍵用語，它的「定義」章節也要挑進來**，不要只挑主題章節。
  很多問題的形式是「某個動作算不算某個用語」（例如「把 P 怪獸放到 P 區算不算
  魔法卡的發動」），答案就寫在那個用語的定義裡，而定義章節的標題看起來跟
  問題一點都不像。寧可多挑一節定義，也不要漏掉。
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

const ANSWER_PROMPT = (question, rules, rulings, cards) => `你是遊戲王規則的說明助手。只能根據下面提供的「依據」回答，不能使用依據以外的知識。

=== 依據 A：規則文件（簡體中文，來源 OCG Rule）===
${rules.length ? rules.map(r => `[規則 ${r.id}] ${r.path}\n${r.view}`).join('\n\n---\n\n') : '（沒有提供）'}

=== 依據 B：官方裁定（日文，來源 Konami 官方資料庫）===
${rulings.length ? rulings.map(r => `[裁定 ${r.fid}] 更新 ${r.updated_at ?? '—'}\n${r.view}`).join('\n\n---\n\n') : '（沒有提供）'}

=== 依據 C：卡片效果文本（繁體中文，來源 卡片資料庫）===
${cards.length ? cards.map(c => `[卡片 ${c.id}] ${c.name}\n${c.view}`).join('\n\n---\n\n') : '（沒有提供）'}

=== 使用者的問題 ===
${question}

請輸出 JSON，不要有其他文字：
{"refused":布林,"answer":"繁體中文回答","cites":[{"type":"rule","id":數字,"sents":["R數字-句號"]},{"type":"ruling","id":數字,"sents":["J數字-句號"]},{"type":"card","id":數字,"sents":["C數字-句號"]}]}

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
8. 依據 C 只能用來確認「這張卡的效果文字寫了什麼」（發動條件、時點、必發或選發等），
   **不能**用它推測規則怎麼處理。效果文字與規則怎麼套用，仍要由依據 A、B 說明；
   兩者合起來也不能組合出它們都沒說過的新結論（第 4 條）。
9. ⚠️ **引用一條依據時，只能說它「直接寫了什麼」，不可以說它「暗示」「可推知」「類推」
   「同理」「換言之」。** 一條裁定問的是 A 情境，就只能拿來回答 A 情境；
   你想用「它說 A 不行，所以暗示 B 可以」把它延伸到使用者問的 B，那就是組合推論，
   該拒答，不是該寫「暗示」。
10. ⚠️ **依據的每一句前面都有編號，形如 ⟦R21-3⟧（R 規則、J 裁定、C 卡片，後面是該條的編號與句號）。**
    每一個 cites 都要在 sents 填入直接支持你結論的那幾句的編號，寫成 "R21-3"（至多 5 句）。
    **只填編號，不要自己寫引文** —— 程式會用編號取回原文。沒有任何一句直接支持結論，
    就代表這條依據不能用。
    **answer 的文字裡不要出現 ⟦ ⟧ 編號**；回答若提到「規則」或「裁定」，cites 就必須有對應的 rule／ruling。
11. answer 控制在 800 字以內。`;

// 組合推論的口頭禪。⚠️ 這只是**訊號**不是判決：正常回答也可能剛好用到這些字，
// 所以目前只記日誌、回傳 hedges，不改變拒答與否。先看過幾題的誤判率再決定要不要硬擋。
// 比對引文用的正規化：全半形統一、去掉所有空白與換行。模型抄原文時常會
// 在換行處多加或少加空白，那不是編造，不該因此作廢。
const norm_quote = t => (t ?? '').normalize('NFKC').replace(/\s+/g, '');
const MIN_QUOTE = 8;

/**
 * 引文是否真的出現在依據原文裡。
 *
 * 模型抄長段原文時常用「...」或「…」省略中間，那是正當的節錄，不是編造 ——
 * 所以按省略號切成片段，每一段都要**依序**出現在原文裡。⚠️ 片段不能亂序：
 * 亂序等於把不相干的句子拼成一句原文。
 * 太短的片段（< 4 字）幾乎什麼都對得上，不計入比對，但整段引文
 * 去掉省略號後仍要有 MIN_QUOTE 字。
 */
function quote_in(evidence, quote) {
	const frags = (quote ?? '').split(/\.{2,}|…|⋯/).map(norm_quote).filter(f => f.length >= 4);
	if (frags.reduce((n, f) => n + f.length, 0) < MIN_QUOTE)
		return 'short';
	let at = 0;
	for (const f of frags) {
		const i = evidence.indexOf(f, at);
		if (i < 0)
			return 'missing';
		at = i + f.length;
	}
	return 'ok';
}

/**
 * 把一條依據切成句子並編號。模型只回報編號，引文由程式取回 ——
 * 存在的編號取回來的一定是原文，所以引文不可能被編造或改寫。
 * （仍保留 quote_in 給沒照格式、自己寫 quote 的輸出。）
 */
const MAX_SENTS = 5;
export function split_sents(text) {
	const out = [];
	for (const piece of (text ?? '').split(/(?<=[。！？!?；;\n])/)) {
		const t = piece.trim();
		if (!t)
			continue;
		// 太短的殘片（單獨一個「」」之類）併回前一句，不佔編號
		if (out.length && t.length < 6)
			out[out.length - 1] += t;
		else
			out.push(t);
	}
	return out;
}
// ⚠️ 編號要帶來源（R21-3），不能每條依據都從 1 重編 —— 否則模型會把 A 條的 ⟦3⟧
//    當成 B 條的，而且還對得上（每條都有第 3 句），引用就悄悄指向別的句子。
export function numbered(text, tag) {
	const sents = split_sents(text);
	return { sents, view: sents.map((t, i) => `⟦${tag}-${i + 1}⟧${t}`).join('\n') };
}

const KIND = { R: 'rule', J: 'ruling', C: 'card' };
export const strip_marks = t => (t ?? '').replace(/⟦[^⟧]*⟧/g, '');

/**
 * 驗證模型的 cites。純函式，不碰模型，測試直接餵進來。
 *
 * sent_map：{ rule|ruling|card: Map(編號 → 句子陣列) }，也就是「我們送進去的依據」。
 * evidence：同形，值是正規化後的整段原文，給沒照格式、自己寫 quote 的輸出用。
 *
 * 編號帶來源（R21-3）時，引文取自編號指的那一句，**不看 cite 自己寫的 id** ——
 * 句子是真的、也確實送過，只是歸屬要照它真正所在的那條依據。
 * 裸數字（3）沿用 cite 自己指的那一條。
 */
export function verify_cites(cites, { sent_map, evidence }) {
	const out = { rule_ids: [], ruling_fids: [], card_ids: [], quotes: [], dropped: [], bad_quotes: [] };
	const bucket = { rule: out.rule_ids, ruling: out.ruling_fids, card: out.card_ids };
	const add = (type, id) => {
		if (!bucket[type].includes(id))
			bucket[type].push(id);
	};
	for (const c of cites) {
		// ⚠️ 編號欄位名要寬容，**允許的編號集合要嚴格**。
		//    prompt 裡規則用 id、裁定用 fid，模型實測會把兩者都寫成 id ——
		//    踩過一次：fid 24022 確實有送進去，卻被當成編造，整個正確的回答被作廢。
		//    認錯欄位名不是編造，只有「這個編號我們沒送過」才是。
		const n = Number(c?.fid ?? c?.id);
		if (!sent_map[c?.type]?.has(n)) {
			out.dropped.push(JSON.stringify(c));
			continue;
		}
		// ⚠️ 編號對得上還不夠 —— 引文也要真的出現在那條依據裡。
		let verdict = 'ok';
		const found = [];
		if (Array.isArray(c.sents)) {
			const toks = [...new Set(c.sents.map(x => String(x).replace(/[⟦⟧\s]/g, '').toUpperCase()))].filter(Boolean);
			if (!toks.length || toks.length > MAX_SENTS)
				verdict = 'short';
			else {
				const picks = new Map();
				for (const t of toks) {
					const m = /^(?:([RJC])(\d+)-)?(\d+)$/.exec(t);
					const type = m ? (m[1] ? KIND[m[1]] : c.type) : null;
					const id = m ? (m[1] ? Number(m[2]) : n) : null;
					const all = type && sent_map[type]?.get(id);
					const i = m ? Number(m[3]) : 0;
					if (!all || i < 1 || i > all.length) {
						verdict = 'missing';
						break;
					}
					const key = `${type}:${id}`;
					if (!picks.has(key))
						picks.set(key, { type, id, idx: new Set() });
					picks.get(key).idx.add(i);
				}
				if (verdict === 'ok') {
					for (const { type, id, idx } of picks.values()) {
						const all = sent_map[type].get(id);
						found.push({ type, id, quote: [...idx].sort((a, b) => a - b).map(i => all[i - 1]).join('\n') });
					}
				}
			}
		}
		else {
			verdict = quote_in(evidence[c.type].get(n) ?? '', c.quote);
			if (verdict === 'ok')
				found.push({ type: c.type, id: n, quote: c.quote });
		}
		if (verdict !== 'ok') {
			const why = verdict === 'short' ? '沒附句子編號或太多句' : '句子編號不存在或引文找不到';
			out.bad_quotes.push(`${c.type}:${n}（${why}）`);
			out.dropped.push(JSON.stringify(c));
			continue;
		}
		for (const f of found) {
			out.quotes.push(f);
			add(f.type, f.id);
		}
	}
	return out;
}

/** 回答提到「規則」「裁定」卻沒有對應有效引用時，回傳缺的那幾項。 */
export function mention_gaps(answer, rule_ids, ruling_fids) {
	const missing = [];
	if (/規則|OCG ?Rule/i.test(answer) && !rule_ids.length)
		missing.push('規則');
	if (/裁定/.test(answer) && !ruling_fids.length)
		missing.push('裁定');
	return missing;
}

// ⚠️ 審查標準要**依依據的種類分開**。第一版對三種一視同仁（「講別張卡就是不相關」），
//    結果 9 題作答題裡有 3 題被擋，其中至少 2 題是誤殺：
//    規則 31 是「大宇宙適用中不能發動送去墓地作為 cost 的效果」這條通則，就是 gold 的依據，
//    只因為它的例子寫的是增殖的G、問題問的是禁忌一滴，就被判成「講別張卡」；
//    卡片效果文字（問題提到的那張卡）也被判成「沒有直接回答問題」。
//    規則是通則、卡片文字只是確認效果寫了什麼，只有官方裁定才是「針對特定情境」的 ——
//    也只有裁定才需要「同一張卡、同一個情境」。
const JUDGE_PROMPT = (question, answer, quotes) => `你是引文審查員。下面是使用者的問題、一個回答，以及回答所引用的原文。
逐段判斷：**這段原文能不能作為這個回答的依據，而不是被硬套在它沒講的情境上**。
問題常由幾個部分組成（例如「某卡的發動條件」＋「某種動作算不算發動」），一段原文只需要
直接講到其中一個部分就算 direct=true，**不必單獨回答整個問題**。

依據分三種，標準不同：

【規則】（標示為 [rule …]）：規則文件是**通則**。只要它講的規則概念適用於問題的情況就是 direct=true，
  **即使它舉的例子用的是別張卡**（例如規則寫「大宇宙適用中不能發動送去墓地作為 cost 的效果」，
  例子是增殖的G，而問題問禁忌一滴，這條規則仍然適用）。
  只有當它講的是**跟問題無關的別種規則**（不同的階段、不同的機制），或只是一個看不出內容的殘缺片段，才是 false。

【卡片】（標示為 [card …]）：卡片效果文字只用來確認「這張卡的效果寫了什麼」。
  只要是**問題提到的那張卡**（或回答用到的那張卡）的效果文字就是 direct=true。
  只有它是一張跟問題完全無關的卡才是 false。

【裁定】（標示為 [ruling …]）：官方裁定是**針對特定卡、特定情境**的回答，最容易被拿去類推，所以最嚴格。
  - direct=true：裁定的問答裡**出現了問題所提到的卡名**，且講的是同一個情境。
  - direct=false：裁定的問答裡**沒有出現問題提到的那張卡**，只是講別張卡的類似效果，
    回答卻靠它「類推」出結論。**即使機制相同、結論看起來合理，也是 false**
    （例如問 A 卡，裁定只談 B 卡、C 卡，用的是同一種機制；或問 P 怪獸，裁定講的是陷阱卡）。
    判斷方法：把問題裡的卡名逐一在裁定原文找，找不到就是 false。

每一筆都要附 reason：用一句話說明判斷的理由（例如「規則通則，適用於本題」「裁定講的是別張卡」）。

=== 使用者的問題 ===
${question}

=== 回答 ===
${answer}

=== 引用的原文 ===
${quotes.map((q, i) => `(${i + 1}) [${q.type} ${q.id}]\n${q.quote}`).join('\n\n')}

只輸出 JSON：{"results":[{"n":1,"direct":布林,"reason":"一句話"},{"n":2,"direct":布林,"reason":"一句話"}]}，每段原文一筆。`;

/** 回傳沒通過的引文標記；空陣列＝全部通過。 */
export async function check_relevance(question, answer, quotes, gen, gen_fn = generate) {
	const res = await gen_fn(JUDGE_PROMPT(question, strip_marks(answer), quotes),
		{ stage: 'answer', json: true, max_tokens: 2048, thinking_budget: 512, temperature: 0, ...gen });
	if (process.env.YGO_DEBUG)
		console.log(`[ask] 相關性審查原始輸出：${res.error ?? res.text}`);
	const results = res.error ? null : parse_json(res.text)?.results;
	if (!Array.isArray(results))
		return ['審查失敗'];
	return quotes
		.map((q, i) => ({ q, r: results.find(x => Number(x?.n) === i + 1) }))
		// 只有明確說 false 的才算沒通過；小模型常漏回其中一筆，漏回不是判決
		.filter(({ r }) => r?.direct === false)
		.map(({ q, r }) => {
			// 把審查員的理由留在日誌 —— 之前被擋了只能看到編號，要判斷是擋對還是誤殺得再猜一輪。
			if (r.reason)
				console.warn(`[ask] 審查理由 ${q.type}:${q.id}：${String(r.reason).slice(0, 200)}`);
			return `${q.type}:${q.id}`;
		});
}

const HEDGE_WORDS = ['暗示', '可推知', '可以推知', '推測', '類推', '同理', '換言之', '應該是', '一般來說'];

function find_hedges(text) {
	return HEDGE_WORDS.filter(w => text.includes(w));
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 回答一個問題。
 *
 * @param {string} question
 * @param {{ allow_fetch?: boolean, wait_for_slot?: boolean, gen_fn?: typeof generate,
 *   force_sections?: number[], force_cards?: string[] }} opts
 *   gen_fn：測試用，換掉模型呼叫（兩段與相關性審查都走它）。正式路徑不傳。
 * @returns {Promise<{
 *   refused: boolean, answer: string, model: string,
 *   rule_ids: number[], ruling_fids: number[], card_ids: number[], cards: string[],
 *   error?: string, dropped?: string[], unresolved?: string[]
 * }>}
 */
export async function answer_question(question, opts = {}) {
	const allow_fetch = opts.allow_fetch ?? true;
	const gen_fn = opts.gen_fn ?? generate;
	// 批次評測時傳 wait_for_slot，讓節流變成等待而不是失敗
	const gen = { wait_for_slot: opts.wait_for_slot === true };
	const base = { model: model_name(), rule_ids: [], ruling_fids: [], cards: [] };

	if (!corpus_state().sections)
		return { ...base, refused: true, answer: '規則語料還沒匯入，無法作答。', error: '語料為空' };

	// --- 第一段：挑章節、抽卡名 ---
	// ⚠️ thinking_budget 要明講，不要讓它自己決定。思考型模型的推理 token
	//    算在 maxOutputTokens 裡，不設上限的話它可以把整個預算吃光，
	//    而症狀是 finishReason=MAX_TOKENS —— HTTP 200、有 token 消耗、
	//    計數器記成成功，只有回答是空的。實際在 Pi 上踩到過。
	//    選章只是從目錄挑編號，用不著長篇推理。
	// temperature 0：檢索不需要創意，需要的是同一題每次挑到同一批章節。
	// 0.2 的浮動已經造成 dev 與 Pi 對同一題給出相反的結果。
	// 測試用：opts.force_sections／force_cards 直接指定第一段的結果，跳過第一段的模型呼叫。
	// 用來把「第二段模型的品質」和「第一段選章節的隨機性」分開 —— 兩者疊在一起時，
	// 拒答分不出是章節沒選到還是作答模型不行。正式路徑不會傳這兩個。
	let sel;
	if (Array.isArray(opts.force_sections)) {
		sel = { sections: opts.force_sections, cards: opts.force_cards ?? [] };
	}
	else {
		const sel_res = await gen_fn(SELECT_PROMPT(build_toc(), question),
			{ stage: 'select', json: true, max_tokens: 4096, thinking_budget: 1024, temperature: 0, ...gen });
		if (sel_res.error)
			return { ...base, refused: true, answer: '目前無法查詢，請稍後再試。', error: sel_res.error };
		sel = parse_json(sel_res.text) ?? {};
	}
	const picked = (Array.isArray(sel.sections) ? sel.sections : [])
		.map(Number).filter(Number.isInteger).slice(0, MAX_SECTIONS)
		.filter(id => get_section(id));
	// 空殼母章節的子章節一起帶上（上限 MAX_SECTIONS + 2）。
	const section_ids = expand_stubs(picked, toc_rows(), 400, MAX_SECTIONS + 2);
	const card_names = (Array.isArray(sel.cards) ? sel.cards : []).slice(0, MAX_CARDS);

	// --- 蒐集依據 ---
	// 上限跟著 MAX_SECTIONS 一起放大，否則多挑的章節會被靜靜切掉。
	const rules = collect_sections(section_ids, 40000);

	const rulings = [];
	const resolved = [];
	const card_ctx = [];
	// ⚠️ 卡名解析不到時不報錯、只是少了卡文與裁定 —— 失敗是無聲的。
	//    使用者用別的譯名問（「太陽神之翼神龍-不死鳥」vs 官方「拉的翼神龍-不死鳥」）
	//    就會遇到，所以記下來回傳，由指令層寫進日誌，才有地方知道該補哪些別名。
	const unresolved = [];
	for (const name of card_names) {
		const id = resolve_id(name);
		// 純數字會被 resolve_id 原樣當成卡號，卡表裡不一定有
		const card = id === null ? null : get_card(id);
		if (!card) {
			unresolved.push(name);
			continue;
		}
		resolved.push(display_name(id));
		const text = card.text?.description;
		if (text && !card_ctx.some(c => c.id === card.id)) {
			card_ctx.push({
				id: card.id,
				name: display_name(id),
				text: text.length > MAX_CARD_TEXT ? `${text.slice(0, MAX_CARD_TEXT)}…` : text,
			});
		}
		// 先行卡與剛發售的卡還沒有官方編號：卡文照附，只是沒有裁定可查。
		if (!card.cid)
			continue;
		if (allow_fetch && !cache_state(card.cid).fetched)
			await fetch_rulings(card.cid);
		for (const r of get_rulings(card.cid).slice(0, MAX_RULINGS)) {
			if (!rulings.some(x => x.fid === r.fid))
				rulings.push(r);
		}
	}
	base.unresolved = unresolved;
	// 只把要送進去的那幾條抓全文，其餘留標題就好 —— 每多一條就是一次請求。
	for (const r of rulings.slice(0, MAX_RULINGS)) {
		if (!r.answer && allow_fetch)
			await ensure_detail(r.fid);
	}
	const ruling_ctx = rulings.slice(0, MAX_RULINGS)
		.map(r => get_ruling(r.fid) ?? r);

	// ⚠️ 診斷用。配額是每天 20 次，而「為什麼答不出來」幾乎都要看中間
	//    狀態才知道 —— 選了哪幾節、卡名解析成什麼、送了哪幾條裁定。
	//    沒有這個就得為了看一眼再燒一輪。設 YGO_DEBUG=1 打開。
	const debug = {
		sections: rules.map(r => `${r.id}:${r.path}`),
		cards: card_names.map(n => `${n}→${resolve_id(n) ?? '解析不到'}`),
		rulings: ruling_ctx.map(r => `${r.fid}${r.answer ? '' : '（沒全文）'}`),
		card_texts: card_ctx.map(c => `${c.id}:${c.name}`),
	};
	if (process.env.YGO_DEBUG)
		console.log(`[ask] 依據：${JSON.stringify(debug, null, 1)}`);

	if (!rules.length && !ruling_ctx.length && !card_ctx.length) {
		return {
			...base, cards: resolved, refused: true, reason: 'no_evidence', debug,
			answer: '查無可用的依據（規則章節與官方裁定都沒有命中）。這不代表可以自行推論結果 —— 請洽裁判或官方事務局。',
		};
	}

	// --- 第二段：作答 ---
	// 作答要留足夠的餘裕：推理 2048 + 回答本身（prompt 限 800 字，約 1200
	// token）。4096 全開給推理時剛好會把回答擠掉，Pi 上就是這樣掛的。
	// temperature 0：同一題要得到同一個結論。0.2 時 rules-012 連跑五次是
	// 可以 2／不能 1／拒答 2，等於擲骰子。⚠️ 一致不等於正確 —— 它只是讓
	// 錯誤可重現、可以被評測抓到。
	const rules_n = rules.map(r => ({ ...r, ...numbered(r.body, `R${r.id}`) }));
	const rulings_n = ruling_ctx.map(r => ({ ...r, ...numbered(`Q: ${r.question}\nA: ${r.answer ?? '（未取得全文）'}`, `J${r.fid}`) }));
	const cards_n = card_ctx.map(c => ({ ...c, ...numbered(c.text, `C${c.id}`) }));
	const sent_map = {
		rule: new Map(rules_n.map(r => [r.id, r.sents])),
		ruling: new Map(rulings_n.map(r => [r.fid, r.sents])),
		card: new Map(cards_n.map(c => [c.id, c.sents])),
	};
	const ans_res = await gen_fn(ANSWER_PROMPT(question, rules_n, rulings_n, cards_n),
		{ stage: 'answer', json: true, max_tokens: 8192, thinking_budget: 2048, temperature: 0, ...gen });
	if (ans_res.error)
		return { ...base, cards: resolved, refused: true, answer: '目前無法查詢，請稍後再試。', error: ans_res.error };

	const parsed = parse_json(ans_res.text);
	if (!parsed || typeof parsed.answer !== 'string')
		return { ...base, cards: resolved, refused: true, answer: '回覆格式不正確，已中止。', error: '模型輸出不是預期的 JSON' };

	// --- ⚠️ 引用驗證：對不回去的引用一律丟掉 ---
	//
	// 這是整個檔案的重點。模型「引用」了一個我們沒送進去的編號，代表它
	// 在編 —— 那種回答比沒有回答危險得多，因為它看起來有出處。
	const cites = Array.isArray(parsed.cites) ? parsed.cites : [];
	if (process.env.YGO_DEBUG)
		console.log(`[ask] 模型的 cites：${JSON.stringify(cites)}`);
	// 每條依據的原文（正規化後），給沒照格式、自己寫 quote 的輸出比對用。
	const evidence = {
		rule: new Map(rules.map(r => [r.id, norm_quote(`${r.path}\n${r.body}`)])),
		ruling: new Map(ruling_ctx.map(r => [r.fid, norm_quote(`${r.question}\n${r.answer ?? ''}`)])),
		card: new Map(card_ctx.map(c => [c.id, norm_quote(`${c.name}\n${c.text}`)])),
	};
	const { rule_ids, ruling_fids, card_ids, quotes, dropped, bad_quotes } = verify_cites(cites, { sent_map, evidence });

	const refused = parsed.refused === true;
	const hedges = refused ? [] : find_hedges(parsed.answer);
	if (hedges.length)
		console.warn(`[ask] 回答含推論用語 ${JSON.stringify(hedges)}｜問題：${question}`);

	// 引文對不上 = 模型在這條引用上編造或亂改。整個回答作廢，不是只拿掉那條 ——
	// 它的結論多半就是靠那段「原文」得出來的。
	if (!refused && bad_quotes.length) {
		console.warn(`[ask] 引文驗證失敗 ${bad_quotes.join('、')}｜問題：${question}`);
		return {
			...base, cards: resolved, refused: true, reason: 'bad_quote', dropped, debug,
			answer: '回答的引文無法對回依據原文，因此不提供結論 —— 請洽裁判或官方事務局。',
		};
	}

	// 回答說「依據規則／裁定」，cites 卻沒有對應的有效引用 → 作廢。
	// ⚠️ 只靠卡片效果文本的引用撐起來的回答，不能宣稱有規則依據
	//    （實測 qwen3 會這樣：只引卡片，卻寫「依據規則文件」）。
	if (!refused) {
		const missing = mention_gaps(parsed.answer, rule_ids, ruling_fids);
		if (missing.length) {
			console.warn(`[ask] 回答提到${missing.join('、')}但沒有對應引用｜問題：${question}`);
			return {
				...base, cards: resolved, refused: true, reason: 'mention_gap', dropped, debug,
				answer: `回答聲稱依據${missing.join('、')}，但沒有對應的有效引用，因此不提供結論 —— 請洽裁判或官方事務局。`,
			};
		}
	}

	// --- 相關性檢查（選用：ASK_RELEVANCE_CHECK=1）---
	// 引文是真的，不代表它支持結論 —— 模型會拿「陷阱卡的發動」的裁定去答
	// 「P 牌的發動」。另外問一次：每段引文有沒有直接涵蓋使用者問的那個情境？
	// 任何一段說沒有，整個回答作廢（同「不組合推論」的立場）。
	// ⚠️ 多一次模型呼叫（用第二段的供應者），所以預設關閉；fail-closed：
	//    檢查本身失敗或輸出看不懂，也當作沒通過。
	if (!refused && process.env.ASK_RELEVANCE_CHECK === '1' && quotes.length) {
		const bad = await check_relevance(question, parsed.answer, quotes, gen, gen_fn);
		if (bad.length) {
			console.warn(`[ask] 相關性檢查未通過 ${bad.join('、')}｜問題：${question}`);
			return {
				...base, cards: resolved, refused: true, reason: 'relevance', dropped, debug, quotes,
				answer: '引用的依據沒有直接涵蓋你問的情況，因此不提供結論 —— 請洽裁判或官方事務局。',
			};
		}
	}

	// 沒拒答卻一個有效引用都沒有 → 整個回答作廢。
	// ⚠️ 不要只是把引用拿掉照樣顯示 —— 沒有出處的規則回答就是猜測，
	//    而使用者分不出來。
	if (!refused && !rule_ids.length && !ruling_fids.length && !card_ids.length) {
		return {
			...base, cards: resolved, refused: true, reason: 'no_cite', dropped, debug,
			answer: '這題找不到可以對應的依據，因此不提供結論 —— 請洽裁判或官方事務局。',
		};
	}

	return {
		model: model_name(),
		refused, ...(refused ? { reason: 'model' } : {}),
		// 模型有時會把 ⟦3⟧ 這種編號寫進回答文字，對使用者沒意義，去掉
		answer: strip_marks(parsed.answer).trim(),
		rule_ids, ruling_fids, card_ids, cards: resolved, debug, quotes, unresolved,
		...(dropped.length ? { dropped } : {}),
		...(hedges.length ? { hedges } : {}),
	};
}
