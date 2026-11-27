/**
 * 模型回答的評分。純函式，不碰模型與資料庫 —— 跑測（run.mjs）和事後重算
 * （rescore.mjs）共用，兩邊判法才不會分家。
 */

import { bad_conclusions } from './conclude.mjs';

// 拒答原因（見 ygo-answer.mjs 回傳的 reason）。
export const REASON_TEXT = {
	model: '模型自己拒答',
	bad_quote: '引文驗證失敗（編造或亂改）',
	cite_format: '引用格式不符（沒附句子編號、引文太短或超過句數上限）',
	mention_gap: '提到規則／裁定卻沒有對應引用',
	relevance: '相關性檢查未通過',
	no_cite: '沒有任何有效引用',
	no_evidence: '沒有可用的依據（章節與裁定都沒命中）',
};

/**
 * @param {object} c 題目（rules-cases.json 的一筆）
 * @param {{ answer: string, refused: boolean, reason?: string, dropped?: string[],
 *   fabricated?: string[] }} r 作答結果
 * @param {string[]} rule_paths 引用到的規則章節路徑
 * @returns {string[]} 不符合的項目，空陣列 = 通過
 */
export function score_answer(c, r, rule_paths = []) {
	const e = c.expect ?? {};
	const bad = [];

	if (e.must_refuse === true && !r.refused)
		bad.push('預期拒答，實際給了結論');
	// 作答題（must_refuse: false，或有必要內容的題目）拒答一律算失敗。
	// ⚠️ 不能靠必要內容的字面比對擋 —— 拒答文字常常複述問題（「回合玩家是否可以
	//    選擇先發動選發效果，而不是必發效果」），「可以」「必發」「選發」全都命中，
	//    rules-004 就這樣假通過過一次。沒有必要內容的題目（rules-012）仍然可以拒答。
	const needs_answer = e.must_refuse === false
		|| (e.must_refuse !== true && Boolean(e.must_contain?.length || e.must_contain_any?.length));
	const wrongly_refused = needs_answer && r.refused;
	if (wrongly_refused)
		bad.push(`不該拒答卻拒答了（原因：${REASON_TEXT[r.reason] ?? r.reason ?? '未標示'}）`);

	// 結論不可以是這個樣子。⚠️ 只在**沒拒答**時檢查 —— 拒答的字面裡可能剛好有
	//    「可以」，這裡不管拒答（作答題拒答由上面那條判失敗）。用正規表達式是因為
	//    「可以發動」是「不可以發動」的子字串，單純比字串會誤判。引號裡的引文不算。
	if (!r.refused) {
		for (const re of bad_conclusions(r.answer, e.must_not_conclude))
			bad.push(`給出了不該有的結論（符合 /${re}/）`);
	}

	for (const w of e.must_not_contain ?? []) {
		if (r.answer.includes(w))
			bad.push(`出現禁用字眼「${w}」`);
	}
	// 錯誤拒答時不比對必要內容：命中了不算數，缺了也只是重複上面那一條。
	for (const w of wrongly_refused ? [] : e.must_contain ?? []) {
		if (!r.answer.includes(w))
			bad.push(`缺少必要內容「${w}」`);
	}
	// 同義詞：每一組至少要出現一個（答案寫「無法」或「不能」都算數）。
	for (const group of wrongly_refused ? [] : e.must_contain_any ?? []) {
		if (!group.some(w => r.answer.includes(w)))
			bad.push(`缺少必要內容（以下任一）「${group.join('」「')}」`);
	}
	if (e.max_chars && r.answer.length > e.max_chars)
		bad.push(`回答 ${r.answer.length} 字，超過上限 ${e.max_chars}`);

	// 期望引用到的章節：比對實際引用章節的路徑
	const paths = rule_paths.join(' | ');
	for (const want of e.cites ?? []) {
		if (!paths.includes(want))
			bad.push(`沒引用到「${want}」，實際引用：${paths || '無'}`);
	}

	// ⚠️ 模型編造引用是重大缺陷，不是小瑕疵 —— 管線雖然已經把它丟掉了，
	//    但它發生過這件事本身就要讓這題紅燈。格式不符（超過句數上限等）也算
	//    紅燈，只是分開寫。fabricated 是後來才加的欄位，沒有它的舊存檔分不
	//    出來，照舊當編造。
	const fabricated = r.fabricated ?? r.dropped ?? [];
	if (fabricated.length)
		bad.push(`模型編造了引用：${fabricated.join(' ')}`);
	else if (r.dropped?.length)
		bad.push(`引用格式不符：${r.dropped.join(' ')}`);

	return bad;
}
