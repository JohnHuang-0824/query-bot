/**
 * 作答失敗時要不要停掉整輪。免費層每天只有 20 次請求，而失敗的請求也扣額度。
 *
 * @param {string} error answer_question 回傳的 error
 * @returns {string | null} 要停的原因；null = 只有這一題失敗，繼續跑
 */
export function halt_reason(error) {
	// ⚠️ 只有**每日**配額用完才算。每分鐘的 429 等一下就好 —— 第一版把所有 429
	//    都當成「今日用完」，撞到一次每分鐘上限，後面的題目就全被跳過。
	//    ygo-gemini.mjs 對每日配額的錯誤訊息一定含「每日上限」。
	if (/每日上限|PerDay/i.test(error))
		return '今日配額已用完';
	// generate() 對 5xx 已經重試過，一次失敗的呼叫就送了 3 個請求；過載通常持續
	// 一陣子，繼續跑下一題多半只是再燒 3 次（2026-11-27 一輪 17 次耗在 503 上）。
	if (/^HTTP 5\d\d/.test(error))
		return '模型過載（HTTP 5xx），過一陣子再跑';
	return null;
}
