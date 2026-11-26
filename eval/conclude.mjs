/**
 * must_not_conclude 的比對。run.mjs 跟 test/ 共用同一份，免得兩邊算法不一致。
 *
 * ⚠️ 比對前先拿掉「」『』裡的字：引述卡文、規則原文不是 bot 自己的結論。
 *    卡文本身就寫著「……可以發動」，不拿掉的話，結論是「不能發動」的正確回答
 *    只要引了卡文就會被判成相反結論。代價：結論本身寫在引號裡會漏掉。
 */

/** 拿掉引號裡的內容（含巢狀）。 */
export function strip_quotes(text) {
	let out = text, prev;
	do {
		prev = out;
		out = out.replace(/「[^「」『』]*」|『[^「」『』]*』/g, '');
	} while (out !== prev);
	return out;
}

/** 回傳回答符合了哪幾條「不可以出現的結論」；空陣列＝沒有。 */
export function bad_conclusions(answer, patterns = []) {
	const own = strip_quotes(answer);
	return patterns.filter(re => new RegExp(re).test(own));
}
