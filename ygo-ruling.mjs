/**
 * 官方裁定（Q&A）的本地快取。
 *
 * 資料來源是 Konami 官方資料庫的 FAQ：
 *   ope=4&cid=  某張卡的所有 Q&A 清單
 *   ope=5&fid=  單條 Q&A 的質問／回答全文
 *
 * ⚠️ 使用條款：可以使用，但**禁止商業利用與大量自動化存取**。
 *    「大量」是關鍵字 —— 這支 bot 本質上就是自動化存取，所以合規與否
 *    取決於量，而量必須由設計保證，不能靠自律。詳見
 *    ../YGORuleData/架構決策.md 第七節。
 *
 * ⚠️ 這個檔案**不碰 cards.cdb**。那個檔每次同步都會被整個換掉，
 *    我們的資料放獨立的 db/ruling.db。
 */

import { DatabaseSync } from 'node:sqlite';
import { print_qa_link } from './ygo-utility.mjs';

const RULING_DB = new URL('./db/ruling.db', import.meta.url).pathname;

/** 清單快取多久算過期。裁定很少變動，所以拉長。 */
export const LIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const db = new DatabaseSync(RULING_DB);

db.exec(`
CREATE TABLE IF NOT EXISTS ruling (
	fid        INTEGER PRIMARY KEY,
	question   TEXT    NOT NULL,
	answer     TEXT    NOT NULL,
	updated_at TEXT,
	fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ruling_card (
	fid INTEGER NOT NULL,
	cid INTEGER NOT NULL,
	PRIMARY KEY (fid, cid)
);
CREATE INDEX IF NOT EXISTS idx_ruling_card_cid ON ruling_card (cid);

-- 記錄「這張卡的清單抓過沒有」。
-- ⚠️ 這張表存在的理由不是效能，是誠實：
--    「查無官方裁定」只有在真的查過的時候才說得出口。沒抓過就說沒有，
--    那是另一種形式的編造。
CREATE TABLE IF NOT EXISTS card_fetch (
	cid        INTEGER PRIMARY KEY,
	fetched_at INTEGER NOT NULL,
	total      INTEGER NOT NULL
);
`);

const stmt_by_cid = db.prepare(`
	SELECT r.fid, r.question, r.answer, r.updated_at
	FROM ruling_card rc JOIN ruling r ON r.fid = rc.fid
	WHERE rc.cid = ?
	ORDER BY r.updated_at DESC
`);
const stmt_fetch_state = db.prepare('SELECT fetched_at, total FROM card_fetch WHERE cid = ?');

/**
 * 某張卡的快取狀態。
 * @param {number} cid
 * @returns {{fetched: boolean, fresh: boolean, total: number}}
 */
export function cache_state(cid) {
	const row = stmt_fetch_state.get(cid);
	if (!row)
		return { fetched: false, fresh: false, total: 0 };
	return {
		fetched: true,
		fresh: Date.now() - row.fetched_at < LIST_TTL_MS,
		total: row.total,
	};
}

/**
 * 讀取快取裡某張卡的裁定。不會觸發抓取。
 * @param {number} cid
 */
export function get_rulings(cid) {
	return stmt_by_cid.all(cid);
}

/**
 * 兩張卡共同的裁定 —— 這就是「A 卡對上 B 卡」的答案。
 *
 * 官方 Q&A 是掛在卡片上的，一條裁定可以關聯多張卡，所以交集正好是
 * 「同時提到這兩張卡的官方回答」。
 * @param {number} cid_a
 * @param {number} cid_b
 */
export function get_common_rulings(cid_a, cid_b) {
	const b = new Set(get_rulings(cid_b).map(r => r.fid));
	return get_rulings(cid_a).filter(r => b.has(r.fid));
}

/**
 * 官方 Q&A 頁的連結（上游已有的 helper，ope=4&cid=…）。
 * 降級模式只給連結不取內文時用這個。
 * @param {number} cid
 */
export function qa_link(cid) {
	return print_qa_link(cid);
}

/**
 * ⚠️ 第 2 階段才實作：從官方資料庫抓取某張卡的裁定並寫入快取。
 *
 * 動手前必讀 ../YGORuleData/架構決策.md 第七節。實作時必須滿足：
 *
 *   1. 只由真實使用者的查詢觸發，一次一張卡。
 *      ❌ 不做全量預抓、❌ 不排程 crawler、❌ 不做背景預熱。
 *   2. 熔斷：全域請求數超過閾值就停止抓取，回傳 null 讓呼叫端走降級模式。
 *   3. 明確的 User-Agent，留得到聯絡方式。
 *   4. 只在回答裡引用單條並連回原頁，不轉散布全文。
 *
 * 在實作之前一律回傳 null —— 呼叫端會因此走降級模式（只給官方連結），
 * 那條路現在就能用，而且零內文重製。
 *
 * @param {number} cid
 * @returns {Promise<null>}
 */
export async function fetch_rulings(cid) {
	void cid;
	return null;
}
