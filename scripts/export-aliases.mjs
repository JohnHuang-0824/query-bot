/**
 * 把核准過的社群俗稱匯出成 alias-seed.json 格式。
 *
 *   docker compose -f docker-compose.dev.yml exec -T bot node scripts/export-aliases.mjs > alias-seed.json
 *
 * ⚠️ 為什麼需要這支：
 *
 *    別名表是架構決策第一節說的「這個專案唯一會隨時間增值的資產」，
 *    但它住在 db/ruling.db —— 那個檔在 .gitignore 裡（裡面有快取的官方
 *    裁定，不能進版控），而且只存在於那一台機器的 SSD 上。
 *
 *    也就是說：**碟掛了，社群花時間累積的俗稱就全沒了**，而且沒有任何
 *    地方留著。這支把「自己養出來的那部分」撈回可進版控的格式。
 *
 *    ⚠️ 只匯出俗稱，不匯出快取的裁定 —— 那是別人的內容，我們承諾過
 *      不轉散布。
 */

import { DatabaseSync } from 'node:sqlite';
import { display_name } from '../ygo-alias.mjs';

const db = new DatabaseSync(new URL('../db/ruling.db', import.meta.url).pathname);
const rows = db.prepare(
	"SELECT raw, card_id, kind FROM card_alias WHERE status = 'approved' ORDER BY kind, raw").all();

const out = {
	_說明: '俗稱 → 官方卡名。右邊必須是索引裡找得到且唯一的名稱。',
	_注意: '底線開頭的鍵會被略過。改完重啟容器生效。',
	_匯出時間: new Date().toISOString(),
};
let skipped = 0;
for (const r of rows) {
	const name = display_name(r.card_id);
	if (!name || name === String(r.card_id)) {
		skipped++;
		continue;
	}
	out[r.raw] = name;
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
if (skipped)
	process.stderr.write(`⚠️ ${skipped} 筆對不到卡名，已略過\n`);
process.stderr.write(`匯出 ${rows.length - skipped} 筆別名\n`);
