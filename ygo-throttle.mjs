/**
 * 跨行程的節流計數。
 *
 * ⚠️ 這個檔案存在的理由是一個實際踩到的 bug：
 *
 *    原本 Gemini 與 Konami 的節流都用模組層的變數計數。bot 是常駐行程，
 *    所以看起來沒問題 —— 但 `docker compose exec bot node script.mjs`
 *    每次都是**全新的行程**，模組變數跟著歸零。連續跑十幾個測試腳本，
 *    每一個都以為自己有全新的額度，於是實際請求速率遠高於設定值，
 *    最後撞到對方的 429。
 *
 *    節流如果是合規要求（Konami 那條就是），它就不能靠行程記憶體 ——
 *    必須存在所有行程都看得到的地方。
 */

import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(new URL('./db/ruling.db', import.meta.url).pathname);
db.exec(`
	CREATE TABLE IF NOT EXISTS rate_event (
		source TEXT    NOT NULL,
		at     INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_rate_event ON rate_event (source, at);
`);

const stmt_add = db.prepare('INSERT INTO rate_event (source, at) VALUES (?, ?)');
const stmt_count = db.prepare('SELECT COUNT(*) n FROM rate_event WHERE source = ? AND at > ?');
const stmt_last = db.prepare('SELECT MAX(at) t FROM rate_event WHERE source = ?');
const stmt_prune = db.prepare('DELETE FROM rate_event WHERE at < ?');

/** 清掉兩天前的紀錄，這張表不該無限長大。 */
function prune() {
	stmt_prune.run(Date.now() - 2 * 86_400_000);
}

/**
 * 上一個「太平洋時間午夜」的時間戳。
 *
 * ⚠️ Google 免費層的每日配額是**在太平洋時間午夜歸零**，不是滾動 24 小時。
 *    兩者的差別在額度只有 20 次的時候非常致命：如果我們用滾動視窗計數，
 *    下午把額度用完之後，對方午夜就補滿了，我們卻要再等到隔天下午才肯
 *    放行 —— 症狀是「明明還有額度卻一直說超量」。
 */
function pacific_day_start() {
	const now = Date.now();
	const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/Los_Angeles', hour12: false,
		hour: '2-digit', minute: '2-digit', second: '2-digit',
	}).formatToParts(new Date(now)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
	const into_day = (parts.hour % 24) * 3600 + parts.minute * 60 + parts.second;
	return now - into_day * 1000;
}

/** 今天（太平洋時間）的日期字串，用來跟對方的配額對齊。 */
export function quota_day() {
	return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

/**
 * 還能不能發請求。
 * @param {string} source 'gemini' | 'konami'
 * @param {{ per_minute: number, per_day: number, day_reset?: 'pacific' }} limits
 *   day_reset: 'pacific' 時每日視窗從太平洋午夜起算（對齊 Google 的配額），
 *   不給就是滾動 24 小時（Konami 那種自訂的禮貌上限用這個就好）。
 * @returns {string | null} 不能發時回原因
 */
export function blocked_reason(source, limits) {
	const now = Date.now();
	if (stmt_count.get(source, now - 60_000).n >= limits.per_minute)
		return `每分鐘上限 ${limits.per_minute}`;
	const day_from = limits.day_reset === 'pacific' ? pacific_day_start() : now - 86_400_000;
	if (stmt_count.get(source, day_from).n >= limits.per_day)
		return `每日上限 ${limits.per_day}`;
	return null;
}

/** 距離上一次請求還要等多久（毫秒）。 */
export function wait_ms(source, min_interval_ms) {
	const last = stmt_last.get(source).t ?? 0;
	return Math.max(0, min_interval_ms - (Date.now() - last));
}

/** 記一次請求。⚠️ 實際發出前就要記，不要等回應 —— 失敗的請求也是請求。 */
export function record(source) {
	stmt_add.run(source, Date.now());
	if (Math.random() < 0.02)
		prune();
}

/** 目前用量，給診斷用。 */
export function stats(source) {
	const now = Date.now();
	return {
		last_minute: stmt_count.get(source, now - 60_000).n,
		last_day: stmt_count.get(source, now - 86_400_000).n,
		since_pacific_midnight: stmt_count.get(source, pacific_day_start()).n,
	};
}
