/**
 * 卡名解析：把使用者打的任何東西變成卡片 id。
 *
 * 上游的 choice_table 已經有官方名稱（zh-tw / ja / en / ko），這個模組
 * 做兩件它沒做的事：
 *
 *   1. **把多個 locale 併成同一個候選來源** —— 老手問裁定時中日混用，
 *      「灰流麗」和「うらら」應該都查得到。上游是一個指令一個 locale
 *      （另有 card-jp），對 /card 合理，對 /ruling 不夠。
 *   2. **社群俗稱** —— 「増G」「大宇宙」這種不是任何官方名稱子字串的
 *      說法，哪個官方資料源都沒有，只能自己累積。
 *
 * ⚠️ 這裡**不改上游的比對邏輯**，只是自己另外建一份索引（fork 規矩 5）。
 *    /card 的行為維持原樣，否則使用者會覺得同一個指令在兩個 bot 上表現
 *    不一樣。
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { choice_table } from './common_all.js';

const DB_PATH = new URL('./db/ruling.db', import.meta.url).pathname;
const db = new DatabaseSync(DB_PATH);

const SCHEMA_VERSION = 3;
{
	const v = db.prepare('PRAGMA user_version').get().user_version;
	if (v < 2) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS card_alias (
				norm    TEXT    NOT NULL,
				card_id INTEGER NOT NULL,
				raw     TEXT    NOT NULL,
				kind    TEXT    NOT NULL,
				weight  INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (norm, card_id)
			);
			CREATE INDEX IF NOT EXISTS idx_card_alias_norm ON card_alias (norm);
		`);
	}
	if (v < 3) {
		// v3：提案流程。status 決定這條別名算不算數 ——
		// 'proposed' 只存著不進索引，'approved' 才會被 suggest 看到。
		for (const [col, ddl] of [
			['status', "TEXT NOT NULL DEFAULT 'approved'"],
			['proposed_by', 'TEXT'],
			['created_at', 'INTEGER'],
		]) {
			if (!db.prepare('PRAGMA table_info(card_alias)').all().some(c => c.name === col))
				db.exec(`ALTER TABLE card_alias ADD COLUMN ${col} ${ddl}`);
		}
		db.exec('CREATE INDEX IF NOT EXISTS idx_card_alias_status ON card_alias (status)');
	}
	if (v < SCHEMA_VERSION) {
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		console.log(`[alias] schema 遷移 ${v} -> ${SCHEMA_VERSION}`);
	}
}

// ⚠️ 只撈 approved。提案不進索引 —— 沒審過的俗稱指錯卡的話，使用者
//    看到的是「查了某張卡的裁定」卻拿到另一張卡的結果，比查不到更糟。
const stmt_all_alias = db.prepare("SELECT norm, card_id, raw, kind, weight FROM card_alias WHERE status = 'approved'");
const stmt_put_alias = db.prepare(`
	INSERT INTO card_alias (norm, card_id, raw, kind, weight) VALUES (?, ?, ?, ?, ?)
	ON CONFLICT(norm, card_id) DO UPDATE SET raw = excluded.raw, kind = excluded.kind, weight = excluded.weight
`);

/**
 * 正規化。目標是讓「同一個意思的不同打法」落到同一個鍵。
 *
 * - NFKC：全形英數 → 半形、半形片假名 → 全形。這一步就吃掉大半變異。
 * - 片假名 → 平假名：使用者打「ウララ」或「うらら」都該中。
 *   ⚠️ 只折這一個方向，不要連漢字一起動 —— 那會把不同的卡混在一起。
 * - 去掉空白與常見分隔符：「灰流 麗」「灰流・麗」都算同一個。
 */
export function normalize(s) {
	return (s ?? '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
		.replace(/[\s・･·‧、,，.。\-ー—–_"'"'「」『』()（）]/g, '');
}

/** norm -> Set<card_id> */
const index = new Map();
/** card_id -> 顯示用的繁中名 */
const display = new Map();
/**
 * norm -> 這個鍵是怎麼來的（顯示時標註用）。
 * 複合鍵用 \u0000 當分隔符 —— 卡名不可能含它，所以不會撞。
 * ⚠️ 一定要寫成跳脫序列，不要打原始的 NUL：那會讓整個檔案在 git 與
 *    grep 眼裡變成二進位檔，diff 直接報廢。
 */
const origin = new Map();

function add(norm, id, raw, kind) {
	if (!norm || !Number.isInteger(id))
		return;
	let set = index.get(norm);
	if (!set)
		index.set(norm, set = new Set());
	set.add(id);
	if (!origin.has(`${norm}\u0000${id}`))
		origin.set(`${norm}\u0000${id}`, { raw, kind });
}

/** 從 choice_table 與 card_alias 重建索引。啟動時做一次。 */
export function build_index() {
	index.clear();
	display.clear();
	origin.clear();

	// 顯示名以繁中為準
	for (const [name, id] of choice_table['zh-tw'] ?? []) {
		if (!display.has(id))
			display.set(id, name);
	}
	for (const [locale, kind] of [['full', 'zh-tw'], ['zh-tw', 'zh-tw'], ['ja', 'ja'], ['en', 'en']]) {
		const table = choice_table[locale];
		if (!table?.entries)
			continue;
		for (const [name, id] of table) {
			add(normalize(name), id, name, kind);
			if (!display.has(id))
				display.set(id, name);
		}
	}
	for (const row of stmt_all_alias.all())
		add(row.norm, row.card_id, row.raw, row.kind);

	return { keys: index.size, cards: display.size };
}

/**
 * 新增一條別名。
 * @param {string} raw 使用者打的俗稱
 * @param {number} card_id
 * @param {string} kind 'seed' | 'community' | 'official'
 * @param {number} weight 越大越前面
 */
export function put_alias(raw, card_id, kind = 'community', weight = 0) {
	const norm = normalize(raw);
	if (!norm)
		return false;
	stmt_put_alias.run(norm, card_id, raw, kind, weight);
	add(norm, card_id, raw, kind);
	return true;
}

const MAX_CHOICE = 25;

/**
 * autocomplete 候選。
 *
 * ⚠️ 這裡**不解決歧義，只呈現歧義**。「墓穴」可能是「墓穴」也可能是
 *    「墓穴の指名者」—— 在訊息式介面這是難題，但 Discord 一次能列 25 個
 *    候選，所以讓使用者自己選就好。權重只決定排序。
 *
 * ⚠️ 必須是純本地查詢。autocomplete 有 3 秒等級的時限，而且每打一個字
 *    就觸發一次 —— 不能經過 LLM，也不能打外部 API。
 *
 * @param {string} query
 * @returns {{name: string, value: string}[]}
 */
export function suggest(query) {
	const q = normalize(query);
	if (!q)
		return [];

	const prefix = [];
	const contains = [];
	for (const [norm, ids] of index) {
		if (norm.startsWith(q))
			prefix.push([norm, ids]);
		else if (norm.includes(q))
			contains.push([norm, ids]);
		if (prefix.length >= MAX_CHOICE * 3)
			break;
	}

	const seen = new Set();
	const out = [];
	for (const [norm, ids] of [...prefix, ...contains]) {
		for (const id of ids) {
			if (seen.has(id))
				continue;
			seen.add(id);
			const name = display.get(id) ?? String(id);
			const src = origin.get(`${norm}\u0000${id}`);
			// 靠俗稱或日文命中的時候，把命中的字串也顯示出來 ——
			// 否則使用者不知道自己選的是不是對的那張。
			const label = src && normalize(name) !== norm ? `${name} ← ${src.raw}` : name;
			out.push({ name: label.slice(0, 100), value: String(id) });
			if (out.length >= MAX_CHOICE)
				return out;
		}
	}
	return out;
}

/**
 * 把 autocomplete 的 value（卡片 id）或使用者硬打的字轉成 card_id。
 * @param {string} input
 * @returns {number | null}
 */
export function resolve_id(input) {
	const raw = (input ?? '').trim();
	if (!raw)
		return null;
	if (/^\d+$/.test(raw))
		return Number(raw);

	// 先試精確命中（正規化之後完全相同）
	const ids = index.get(normalize(raw));
	if (ids?.size === 1)
		return [...ids][0];
	if (ids?.size > 1)
		return null;

	// 再退回模糊比對。使用者常常只打一半（「灰流」而不是「灰流麗」），
	// 而且不一定會從 autocomplete 選 —— 唯一命中就認，多於一個就回 null
	// 讓上層請他重選。⚠️ 這跟 suggest 是同一條原則：不解決歧義，只呈現。
	const cands = suggest(raw);
	return cands.length === 1 ? Number(cands[0].value) : null;
}

/**
 * 卡片 id → 顯示用名稱。
 *
 * ⚠️ **`card.text.name` 不存在**（實測），真正的欄位是 `tw_name` /
 *    `jp_name` / `en_name`。用錯的話畫面上會出現卡片編號而不是卡名，
 *    而且只有在真的渲染出來時才看得到 —— 評測集就是這樣抓到的。
 * @param {number} id
 */
export function display_name(id) {
	return display.get(id) ?? String(id);
}

/**
 * 從 alias-seed.json 載入種子別名。
 *
 * 檔案格式是「俗稱 → 官方卡名」，因為手工維護時沒人記得卡片 id：
 *
 *   { "増G": "増殖するG" }
 *
 * ⚠️ 右邊那個官方名必須在索引裡找得到且唯一，否則整筆略過並印出警告 ——
 *    寧可少一條別名，也不要靜靜地把俗稱指到錯的卡。
 */
export function load_seed() {
	let raw;
	try {
		raw = readFileSync(new URL('./alias-seed.json', import.meta.url), 'utf8');
	}
	catch {
		return { loaded: 0, skipped: 0 };
	}
	let loaded = 0, skipped = 0;
	for (const [alias, official] of Object.entries(JSON.parse(raw))) {
		if (alias.startsWith('_'))
			continue;
		const id = resolve_id(official);
		if (id === null) {
			console.warn(`[alias] 種子跳過：「${official}」在索引裡找不到或不唯一`);
			skipped++;
			continue;
		}
		put_alias(alias, id, 'seed', 10);
		loaded++;
	}
	return { loaded, skipped };
}

// 模組載入時就建好索引。common_all.js 在它自己的 module scope 就把
// choice_table 準備好了，所以這裡拿得到完整資料。
//
// ⚠️ 如果之後 bot 會在執行中重載卡表，記得再呼叫一次 build_index()，
//    否則新卡在 /ruling 的候選裡不會出現。
const stats = build_index();
const seed = load_seed();
console.log(`[alias] 索引 ${stats.keys} 鍵 / ${stats.cards} 張卡，種子 +${seed.loaded}（跳過 ${seed.skipped}）`);

// ---------------------------------------------------------------- 提案流程

const stmt_propose = db.prepare(`
	INSERT INTO card_alias (norm, card_id, raw, kind, weight, status, proposed_by, created_at)
	VALUES (?, ?, ?, 'community', 0, 'proposed', ?, ?)
	ON CONFLICT(norm, card_id) DO NOTHING
`);
const stmt_status = db.prepare('SELECT status FROM card_alias WHERE norm = ? AND card_id = ?');
const stmt_list_proposed = db.prepare(`
	SELECT rowid, norm, card_id, raw, proposed_by, created_at FROM card_alias
	WHERE status = 'proposed' ORDER BY created_at LIMIT ?
`);
const stmt_by_rowid = db.prepare('SELECT rowid, norm, card_id, raw, status FROM card_alias WHERE rowid = ?');
const stmt_set_status_rowid = db.prepare("UPDATE card_alias SET status = 'approved' WHERE rowid = ?");
const stmt_delete_rowid = db.prepare('DELETE FROM card_alias WHERE rowid = ?');
const stmt_set_status = db.prepare('UPDATE card_alias SET status = ? WHERE norm = ? AND card_id = ?');

/** 每人每日最多幾筆提案。防的是灌水，不是惡意 —— 惡意要靠審核擋。 */
const PROPOSE_PER_DAY = 10;
const propose_count = new Map();

function quota_ok(user_id) {
	const today = new Date().toISOString().slice(0, 10);
	const key = `${user_id}\u0000${today}`;
	const n = (propose_count.get(key) ?? 0) + 1;
	propose_count.set(key, n);
	return n <= PROPOSE_PER_DAY;
}

/**
 * 提出一條別名。**不會進索引**，要等 approve。
 * @returns {'ok'|'exists'|'approved'|'quota'|'invalid'}
 */
export function propose_alias(raw, card_id, user_id) {
	const norm = normalize(raw);
	if (!norm || !Number.isInteger(card_id))
		return 'invalid';

	const existing = stmt_status.get(norm, card_id);
	if (existing?.status === 'approved')
		return 'approved';
	if (existing?.status === 'proposed')
		return 'exists';
	if (!quota_ok(user_id))
		return 'quota';

	stmt_propose.run(norm, card_id, raw, String(user_id), Date.now());
	return 'ok';
}

/** 待審提案。 */
export function list_proposals(limit = 15) {
	return stmt_list_proposed.all(limit);
}

/** 核准一條提案，並立刻進索引。 */
export function approve_proposal(rowid) {
	const row = stmt_by_rowid.get(rowid);
	if (!row || row.status !== 'proposed')
		return null;
	stmt_set_status_rowid.run(rowid);
	add(row.norm, row.card_id, row.raw, 'community');
	return row;
}

/** 退掉一條提案。直接刪 —— 這張表是索引，不是稽核軌跡。 */
export function reject_proposal(rowid) {
	const row = stmt_by_rowid.get(rowid);
	if (!row || row.status !== 'proposed')
		return null;
	stmt_delete_rowid.run(rowid);
	return row;
}
