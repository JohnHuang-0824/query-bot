/**
 * 官方裁定（Q&A）的抓取與本地快取。
 *
 * 資料來源是 Konami 官方資料庫的 FAQ：
 *   ope=4&cid=  某張卡的所有 Q&A 清單（標題、更新日、fid）
 *   ope=5&fid=  單條 Q&A 的質問／回答全文
 *
 * ⚠️ 使用條款：可以使用，但**禁止商業利用與大量自動化存取**。
 *    「大量」是關鍵字 —— 這支 bot 本質上就是自動化存取，所以合規與否
 *    取決於量，而量必須由設計保證，不能靠自律。本檔案的節流與熔斷
 *    就是那個保證。詳見 ../YGORuleData/架構決策.md 第七節。
 *
 * ⚠️ 這個檔案**不碰 cards.cdb**。那個檔每次同步都會被整個換掉，
 *    我們的資料放獨立的 db/ruling.db（已在 .gitignore）。
 */

import { DatabaseSync } from 'node:sqlite';
import { print_qa_link } from './ygo-utility.mjs';

const BASE = 'https://www.db.yugioh-card.com/yugiohdb/faq_search.action';

/** 帶得到聯絡方式的 User-Agent —— 對方要找人時找得到。 */
const USER_AGENT = 'ygo-ruling-bot/0.1 (+https://github.com/JohnHuang-0824/query-bot)';

/** 清單快取多久算過期。裁定很少變動，所以拉長。 */
export const LIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * ⚠️ 節流與熔斷 —— 這一段是合規的實作，不是效能調校。
 *
 * rp=100 讓一次請求就拿完整份清單（青眼白龍有 88 條，rp=10 要九次）。
 * 請求數少一個量級，對他們的站更好。
 */
const RATE = {
	/** 兩次請求之間的最小間隔（毫秒）。序列化，永遠不併發。 */
	MIN_INTERVAL_MS: 1200,
	/** 滾動視窗：一分鐘內最多幾次。 */
	PER_MINUTE: 20,
	/** 一天最多幾次。超過就熔斷，全部走降級模式。 */
	PER_DAY: 800,
	/** 清單分頁上限。一張卡超過這個量就不再往下抓。 */
	MAX_PAGES: 3,
	RP: 100,
};

const RULING_DB = new URL('./db/ruling.db', import.meta.url).pathname;
const db = new DatabaseSync(RULING_DB);

db.exec(`
CREATE TABLE IF NOT EXISTS ruling (
	fid        INTEGER PRIMARY KEY,
	question   TEXT    NOT NULL,
	answer     TEXT,
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
	total      INTEGER NOT NULL,
	complete   INTEGER NOT NULL DEFAULT 1
);
`);

// ⚠️ schema 遷移 —— 用 PRAGMA user_version，不要靠 CREATE TABLE IF NOT EXISTS。
//
//    那個寫法只建新表，**既有的表一律原封不動**：加欄位不會加、改約束
//    不會改，而且完全不報錯。開發時已經因此踩過兩次（card_fetch 少了
//    complete 欄位、ruling.answer 還帶著舊的 NOT NULL），症狀都是跑到
//    一半才炸，而錯誤訊息不會告訴你是 schema 漂移。
//
//    ruling.db 是長期累積的快取，不能每次改 schema 就砍掉重建，所以
//    改 schema 時：把上面的 CREATE 改成新樣子，然後在下面加一段遷移。
const SCHEMA_VERSION = 1;
const current_version = db.prepare('PRAGMA user_version').get().user_version;

if (current_version < 1) {
	// v1：answer 從 NOT NULL 放寬成可為 NULL（清單先寫入、明細之後補），
	//     card_fetch 補 complete 欄位。
	const cols = db.prepare('PRAGMA table_info(ruling)').all();
	if (cols.some(c => c.name === 'answer' && c.notnull)) {
		// SQLite 不能直接放寬約束，只能重建再搬 —— 這是官方建議的做法。
		db.exec(`
			CREATE TABLE ruling_new (
				fid INTEGER PRIMARY KEY, question TEXT NOT NULL, answer TEXT,
				updated_at TEXT, fetched_at INTEGER NOT NULL
			);
			INSERT INTO ruling_new SELECT fid, question, answer, updated_at, fetched_at FROM ruling;
			DROP TABLE ruling;
			ALTER TABLE ruling_new RENAME TO ruling;
		`);
	}
	if (!db.prepare('PRAGMA table_info(card_fetch)').all().some(c => c.name === 'complete'))
		db.exec('ALTER TABLE card_fetch ADD COLUMN complete INTEGER NOT NULL DEFAULT 1');

	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	console.log(`[ruling] schema 遷移 ${current_version} -> ${SCHEMA_VERSION}`);
}

const stmt_by_cid = db.prepare(`
	SELECT r.fid, r.question, r.answer, r.updated_at
	FROM ruling_card rc JOIN ruling r ON r.fid = rc.fid
	WHERE rc.cid = ?
	ORDER BY r.updated_at DESC
`);
const stmt_fetch_state = db.prepare('SELECT fetched_at, total, complete FROM card_fetch WHERE cid = ?');
const stmt_get_ruling = db.prepare('SELECT fid, question, answer, updated_at FROM ruling WHERE fid = ?');
const stmt_upsert_list = db.prepare(`
	INSERT INTO ruling (fid, question, updated_at, fetched_at) VALUES (?, ?, ?, ?)
	ON CONFLICT(fid) DO UPDATE SET question = excluded.question, updated_at = excluded.updated_at
`);
const stmt_upsert_detail = db.prepare('UPDATE ruling SET question = ?, answer = ?, updated_at = ?, fetched_at = ? WHERE fid = ?');
const stmt_link = db.prepare('INSERT OR IGNORE INTO ruling_card (fid, cid) VALUES (?, ?)');
const stmt_mark_card = db.prepare(`
	INSERT INTO card_fetch (cid, fetched_at, total, complete) VALUES (?, ?, ?, ?)
	ON CONFLICT(cid) DO UPDATE SET fetched_at = excluded.fetched_at, total = excluded.total, complete = excluded.complete
`);

// ---------------------------------------------------------------- 讀取

/**
 * 某張卡的快取狀態。
 * @param {number} cid
 */
export function cache_state(cid) {
	const row = stmt_fetch_state.get(cid);
	if (!row)
		return { fetched: false, fresh: false, total: 0, complete: false };
	return {
		fetched: true,
		fresh: Date.now() - row.fetched_at < LIST_TTL_MS,
		total: row.total,
		complete: !!row.complete,
	};
}

/** 讀快取裡某張卡的裁定。不會觸發抓取。 */
export function get_rulings(cid) {
	return stmt_by_cid.all(cid);
}

/**
 * 兩張卡共同的裁定 —— 這就是「A 卡對上 B 卡」的答案。
 *
 * 官方 Q&A 掛在卡片上，一條可以關聯多張卡，所以交集正好是「同時提到
 * 這兩張卡的官方回答」。
 */
export function get_common_rulings(cid_a, cid_b) {
	const b = new Set(get_rulings(cid_b).map(r => r.fid));
	return get_rulings(cid_a).filter(r => b.has(r.fid));
}

/** 官方 Q&A 頁連結（上游已有的 helper）。降級模式用。 */
export function qa_link(cid) {
	return print_qa_link(cid);
}

// ---------------------------------------------------------------- 節流

let last_request_at = 0;
let minute_window = [];
let day_count = 0;
let day_started_at = Date.now();
let tripped_reason = null;

/** 熔斷狀態。命令列層可以用它決定要不要提示降級。 */
export function breaker_state() {
	return { tripped: !!tripped_reason, reason: tripped_reason, day_count };
}

function check_breaker() {
	const now = Date.now();
	if (now - day_started_at > 24 * 60 * 60 * 1000) {
		day_started_at = now;
		day_count = 0;
		tripped_reason = null;
	}
	if (day_count >= RATE.PER_DAY)
		return (tripped_reason = `每日上限 ${RATE.PER_DAY}`);
	minute_window = minute_window.filter(t => now - t < 60_000);
	if (minute_window.length >= RATE.PER_MINUTE)
		return `每分鐘上限 ${RATE.PER_MINUTE}`;
	return null;
}

/**
 * 唯一對外發請求的地方。序列化、有間隔、記入計數。
 * ⚠️ 不要在別處直接 fetch 官方站 —— 繞過這裡就等於繞過熔斷。
 */
async function polite_fetch(url) {
	const blocked = check_breaker();
	if (blocked) {
		console.warn(`[ruling] 熔斷：${blocked}，改走降級模式`);
		return null;
	}
	const wait = RATE.MIN_INTERVAL_MS - (Date.now() - last_request_at);
	if (wait > 0)
		await new Promise(r => setTimeout(r, wait));

	last_request_at = Date.now();
	minute_window.push(last_request_at);
	day_count++;

	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) {
		console.error(`[ruling] HTTP ${res.status} ${url}`);
		return null;
	}
	return res.text();
}

// ---------------------------------------------------------------- 解析

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** HTML 片段 → 純文字。`<br>` 變換行，其餘標籤丟掉。 */
function to_text(html) {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m.toLowerCase()] ?? m)
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** 取出 id="xxx" 那個 div 的內容（內層沒有巢狀 div，取到第一個 </div>）。 */
function block_by_id(html, id) {
	const start = html.indexOf(`id="${id}"`);
	if (start < 0)
		return '';
	const open_end = html.indexOf('>', start);
	const close = html.indexOf('</div>', open_end);
	return close < 0 ? '' : html.slice(open_end + 1, close);
}

/**
 * 清單頁 → [{fid, question, updated_at}]，加上「全 N 件」。
 * @param {string} html
 */
export function parse_list(html) {
	const total = Number(html.match(/全(\d+)件/)?.[1] ?? 0);
	const rows = [];
	for (const chunk of html.split('class="t_row"').slice(1)) {
		const fid = Number(chunk.match(/ope=5&(?:amp;)?fid=(\d+)/)?.[1]);
		if (!fid)
			continue;
		const title = chunk.match(/<span class="name">([\s\S]*?)<\/span>/)?.[1] ?? '';
		const date = chunk.match(/更新日:<\/span>\s*([\d-]+)/)?.[1] ?? null;
		rows.push({ fid, question: to_text(title), updated_at: date });
	}
	return { total, rows };
}

/**
 * 明細頁 → {question, answer, updated_at, cids}
 *
 * 回傳的 `mentioned_cids` 是**答案文字裡提到的卡**，僅供顯示時連結用。
 *
 * ⚠️ ⚠️ **絕對不要拿它去寫 ruling_card。** 官方答案常常列舉一長串同類
 *    效果的卡名（實測有一條列了 134 張），那些卡只是被舉例，這條裁定
 *    並不是在講它們。拿來建關聯的話，`/ruling A B` 會把「B 剛好出現在
 *    某條裁定的列舉清單裡」誤判成「這條裁定講的是 A 對 B」。
 *
 *    權威的關聯只有一個來源：**清單頁**（`ope=4&cid=`）。一條裁定出現
 *    在某張卡的官方 Q&A 清單裡，那是 Konami 自己的判斷，不是我們從
 *    文字推論出來的 —— 這跟第二節「不准組合推論」是同一條原則。
 * @param {string} html
 */
export function parse_detail(html) {
	const q_html = block_by_id(html, 'question_text');
	const a_html = block_by_id(html, 'answer_text');
	if (!q_html || !a_html)
		return null;
	const cids = new Set();
	for (const part of [q_html, a_html]) {
		for (const m of part.matchAll(/ope=4&(?:amp;)?cid=(\d+)/g))
			cids.add(Number(m[1]));
	}
	return {
		question: to_text(q_html),
		answer: to_text(a_html),
		updated_at: html.match(/(20\d\d-\d\d-\d\d)/)?.[1] ?? null,
		mentioned_cids: [...cids],
	};
}

// ---------------------------------------------------------------- 抓取

/**
 * 抓某張卡的裁定清單並寫入快取。
 *
 * 只抓清單，**不抓每一條的明細** —— 清單已經有標題、日期與 fid，足夠
 * 算出「A 卡對上 B 卡」的交集。明細留給真的要顯示的那幾條（見
 * ensure_detail），這讓一次查詢通常只花 2～5 個請求。
 *
 * ⚠️ 四條合規要求（架構決策第七節）都在這裡落實：
 *   1. 只由使用者查詢觸發 —— 沒有排程、沒有預熱、沒有全量預抓
 *   2. 熔斷 —— polite_fetch 超過上限就回 null
 *   3. User-Agent 帶聯絡方式
 *   4. 不轉散布 —— 只存快取，回答裡只引用單條並連回原頁
 *
 * @param {number} cid
 * @returns {Promise<{total: number, complete: boolean} | null>} null = 熔斷或失敗
 */
export async function fetch_rulings(cid) {
	let total = 0;
	let got = 0;
	let complete = true;

	for (let page = 1; page <= RATE.MAX_PAGES; page++) {
		const params = new URLSearchParams({
			ope: '4', cid: String(cid), sort: '2',
			rp: String(RATE.RP), page: String(page), request_locale: 'ja',
		});
		const html = await polite_fetch(`${BASE}?${params}`);
		if (html === null)
			return null;

		const { total: t, rows } = parse_list(html);
		total = t || total;
		if (!rows.length)
			break;

		const now = Date.now();
		for (const r of rows) {
			stmt_upsert_list.run(r.fid, r.question, r.updated_at, now);
			stmt_link.run(r.fid, cid);
		}
		got += rows.length;
		if (got >= total)
			break;
		if (page === RATE.MAX_PAGES && got < total) {
			// ⚠️ 沒抓完就要誠實標記。complete=false 時命令列層不准說「查無」。
			complete = false;
			console.warn(`[ruling] cid=${cid} 有 ${total} 條，只取了 ${got} 條`);
		}
	}
	stmt_mark_card.run(cid, Date.now(), total, complete ? 1 : 0);
	return { total, complete };
}

/**
 * 確保某條裁定有明細（質問／回答全文）。已經有就不重抓。
 * @param {number} fid
 * @returns {Promise<boolean>} 是否拿得到明細
 */
export async function ensure_detail(fid) {
	const row = stmt_get_ruling.get(fid);
	if (row?.answer)
		return true;

	const params = new URLSearchParams({ ope: '5', fid: String(fid), request_locale: 'ja' });
	const html = await polite_fetch(`${BASE}?${params}`);
	if (html === null)
		return false;

	const detail = parse_detail(html);
	if (!detail) {
		console.error(`[ruling] 解析失敗 fid=${fid} —— 官方頁結構可能改版了`);
		return false;
	}
	stmt_upsert_detail.run(detail.question, detail.answer, detail.updated_at, Date.now(), fid);
	// ⚠️ 這裡**故意不寫 ruling_card**。關聯只能來自清單頁，見 parse_detail 的說明。
	return true;
}
