/**
 * /ask 的每人次數。
 *
 * 兩個上限分開記：
 *   每分鐘：每次嘗試都算，失敗也算 —— 防連按。
 *   每日  ：只算有回覆的（拒答也是回覆）。系統失敗（模型逾時、配額用完、
 *           輸出看不懂）退回，但一天最多退「每日上限」那麼多次：失敗的呼叫
 *           多半一樣吃模型配額，無限退的話一個人重試就能把全服的額度燒光。
 */

import { blocked_reason, record, forget } from './ygo-throttle.mjs';

export const PER_MINUTE = 3;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * 提問前先佔一次。⚠️ 要在呼叫模型之前佔 —— 等回覆才記的話，同時送出好幾題
 * 會全部通過檢查。
 *
 * @param {string} user_id
 * @param {number} per_day 每日上限，0 = 不限制
 * @returns {{ blocked: string } | { blocked: null, refund: () => boolean }}
 *   refund：這次是系統失敗，退回每日次數。回傳有沒有退成。
 */
export function take_ask_slot(user_id, per_day) {
	// per_day 給 0 的話 blocked_reason 會擋掉每一次（count >= 0 恆真），
	// 所以「不限制」要換成一個大到不會踩到的數，不是傳 0 下去。
	const limit = per_day > 0 ? per_day : NO_LIMIT;
	const tries = `user-try:${user_id}`;
	const used = `user:${user_id}`;
	const failed = `user-fail:${user_id}`;

	const blocked = blocked_reason(tries, { per_minute: PER_MINUTE, per_day: NO_LIMIT })
		?? blocked_reason(used, { per_minute: NO_LIMIT, per_day: limit });
	if (blocked)
		return { blocked };

	record(tries);
	const slot = record(used);
	let settled = false;
	return {
		blocked: null,
		refund() {
			if (settled || blocked_reason(failed, { per_minute: NO_LIMIT, per_day: limit }))
				return false;
			settled = true;
			forget(used, slot);
			record(failed);
			return true;
		},
	};
}
