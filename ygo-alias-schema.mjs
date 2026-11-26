/**
 * 別名表的建表與補欄位。獨立成一個檔是為了能單獨測試 —— import ygo-alias.mjs
 * 會連帶載入整個卡表。
 *
 * ⚠️ **不要用 PRAGMA user_version 判斷要不要建表。** ruling.db 是好幾個模組
 *    共用的，版本號整個檔只有一個。實際發生過：規則模組先把它寫成 4，這裡
 *    就以為別名表早就建好了，之後每次啟動都是 `no such table: card_alias`。
 *    直接看實際的資料表和欄位，跟載入順序無關。
 */

/** @param {import('node:sqlite').DatabaseSync} db */
export function ensure_alias_schema(db) {
	// status 決定這條別名算不算數 ——
	// 'proposed' 只存著不進索引，'approved' 才會被 suggest 看到。
	db.exec(`
		CREATE TABLE IF NOT EXISTS card_alias (
			norm        TEXT    NOT NULL,
			card_id     INTEGER NOT NULL,
			raw         TEXT    NOT NULL,
			kind        TEXT    NOT NULL,
			weight      INTEGER NOT NULL DEFAULT 0,
			status      TEXT    NOT NULL DEFAULT 'approved',
			proposed_by TEXT,
			created_at  INTEGER,
			PRIMARY KEY (norm, card_id)
		);
		CREATE INDEX IF NOT EXISTS idx_card_alias_norm ON card_alias (norm);
	`);
	// 提案流程之前建的表沒有後面三欄
	const columns = new Set(db.prepare('PRAGMA table_info(card_alias)').all().map(c => c.name));
	for (const [col, ddl] of [
		['status', "TEXT NOT NULL DEFAULT 'approved'"],
		['proposed_by', 'TEXT'],
		['created_at', 'INTEGER'],
	]) {
		if (!columns.has(col)) {
			db.exec(`ALTER TABLE card_alias ADD COLUMN ${col} ${ddl}`);
			console.log(`[alias] 別名表補欄位 ${col}`);
		}
	}
	db.exec('CREATE INDEX IF NOT EXISTS idx_card_alias_status ON card_alias (status)');
}
