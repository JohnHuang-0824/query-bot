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
 * 還能不能發請求。
 * @param {string} source 'gemini' | 'konami'
 * @param {{ per_minute: number, per_day: number }} limits
 * @returns {string | null} 不能發時回原因
 */
export function blocked_reason(source, limits) {
	const now = Date.now();
	if (stmt_count.get(source, now - 60_000).n >= limits.per_minute)
		return `每分鐘上限 ${limits.per_minute}`;
	if (stmt_count.get(source, now - 86_400_000).n >= limits.per_day)
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
	};
}
