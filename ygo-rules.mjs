/**
 * 規則語料（OCG Rule）的本地儲存與章節檢索。
 *
 * 來源：https://ocg-rule.readthedocs.io
 * 原始碼：https://github.com/lucays/OCG-Rule-documentation
 *
 * ✅ 授權：站上明文寫著「本站内容可以随意引用原文，是否标明出处也随意」。
 *    跟卡片資料不同，這一格不用等授權。
 *
 * ⚠️ 但同一段也寫了「不要把自己的理解說成是本站說的」—— 那跟架構決策
 *    第二節的「禁止組合推論」是同一條規則。引用原文，不要改寫。
 *
 * ⚠️ 語料是**簡體中文**，而使用者的問題是繁中或日文。所以檢索不能用
 *    關鍵字比對 —— 「連鎖」與「连锁」是不同的字，字面比對一條都中不了。
 *    改用兩段式：先把目錄給模型選章，再取全文。見 build_toc()。
 */

import { DatabaseSync } from 'node:sqlite';

// YGO_RULES_DB 是給測試換掉語料用的（':memory:'），部署不要設。
const DB_PATH = process.env.YGO_RULES_DB || new URL('./db/ruling.db', import.meta.url).pathname;
const db = new DatabaseSync(DB_PATH);

// 這個檔好幾個模組共用，PRAGMA user_version 只有一個，所以不用它（見
// ygo-alias-schema.mjs）。
db.exec(`
	CREATE TABLE IF NOT EXISTS rule_section (
		id        INTEGER PRIMARY KEY,
		file      TEXT    NOT NULL,
		title     TEXT    NOT NULL,
		path      TEXT    NOT NULL,
		level     INTEGER NOT NULL,
		body      TEXT    NOT NULL,
		chars     INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_rule_section_file ON rule_section (file);
	CREATE TABLE IF NOT EXISTS rule_meta (
		key   TEXT PRIMARY KEY,
		value TEXT
	);
`);

const stmt_insert = db.prepare(
	'INSERT INTO rule_section (id, file, title, path, level, body, chars) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmt_clear = db.prepare('DELETE FROM rule_section');
const stmt_toc = db.prepare('SELECT id, path, chars FROM rule_section ORDER BY id');
const stmt_get = db.prepare('SELECT id, file, title, path, body, chars FROM rule_section WHERE id = ?');
const stmt_count = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(chars), 0) c FROM rule_section');
const stmt_meta_get = db.prepare('SELECT value FROM rule_meta WHERE key = ?');
const stmt_meta_set = db.prepare(
	'INSERT INTO rule_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

/** 語料現況。沒匯入過時 n = 0。 */
export function corpus_state() {
	const { n, c } = stmt_count.get();
	return { sections: n, chars: c, imported_at: stmt_meta_get.get('imported_at')?.value ?? null };
}

/**
 * 清掉標題裡的 reStructuredText 行內標記。
 *
 * ⚠️ 原始標題長這樣：
 *     「`禁忌的圣杯`_」「`魁炎星王-宋虎`_」等，只\ **在发动的那1次…**\ 的效果
 *    那些反引號、底線、反斜線、星號對模型只是雜訊，而目錄是要送進
 *    prompt 的東西 —— 雜訊佔的是每一次問答的預算。
 */
function clean_title(t) {
	return t
		.replace(/`([^`]*)`_?/g, '$1')
		.replace(/\\\s?/g, '')
		.replace(/\*\*([^*]*)\*\*/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}


/**
 * 清掉內文的 reStructuredText 標記。
 *
 * ⚠️ 內文會**原樣送進模型、也會出現在使用者看到的回答裡**，所以標記
 *    不只是雜訊，是會漏到畫面上的東西。實測第一版就出現過
 *    「`大宇宙`_」這種東西直接印在回答中。
 *
 * 保守處理：只拆連結語法與跳脫，不動內容本身。
 */
function clean_body(t) {
	return t
		.replace(/`([^`]*)`_?/g, '$1')
		.replace(/\\s?/g, '')
		.replace(/\*\*([^*]*)\*\*/g, '$1')
		.replace(/^[ \t]*\|[ \t]?/gm, '')
		.replace(/^\.\.[ \t]+\w+::[ \t]*/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * 把一份 .rst 切成章節。
 *
 * reStructuredText 的標題是「一行文字 + 一行重複的標點」，標點的種類決定
 * 階層（第一次出現的字元是第 1 層，以此類推）。這裡按檔案各自計算階層，
 * 因為每個檔的慣例可能不同。
 *
 * @param {string} text
 * @param {string} file 檔名，只用來標示出處
 */
export function parse_rst(text, file) {
	const lines = text.split('\n');
	const marks = [];
	const order = [];
	for (let i = 0; i < lines.length - 1; i++) {
		const t = lines[i].trim();
		const u = lines[i + 1].trim();
		if (!t || !u || t.startsWith('..'))
			continue;
		if (new Set(u).size !== 1 || !'=-~^"+*#'.includes(u[0]))
			continue;
		if (u.length < Math.max(3, t.length))
			continue;
		if (!order.includes(u[0]))
			order.push(u[0]);
		marks.push({ line: i, title: clean_title(t), level: order.indexOf(u[0]) + 1 });
	}

	const out = [];
	const stack = [];
	for (let k = 0; k < marks.length; k++) {
		const m = marks[k];
		const end = k + 1 < marks.length ? marks[k + 1].line : lines.length;
		const body = clean_body(lines.slice(m.line + 2, end).join('\n'));

		stack.length = m.level - 1;
		stack[m.level - 1] = m.title;
		const path = stack.filter(Boolean).join(' › ');

		// 只有標題沒內容的章節（純目錄節點）不值得單獨收 —— 它們會讓
		// 目錄變長卻選不出東西。
		if (body.length >= 40)
			out.push({ file, title: m.title, path, level: m.level, body, chars: body.length });
	}
	return out;
}

/** 新語料的節數或字數低於現有的這個比例就不覆蓋 */
const MIN_KEEP = 0.8;

/**
 * 整批匯入。會先清空舊資料 —— 語料是可重建的，不做增量。
 *
 * ⚠️ 來源是別人的倉庫，改個版面就可能解析出空的、或缺一大塊。照樣覆蓋的話
 *    /ask 會整個不能用，或只剩一部分依據而沒人發現。所以解析結果不對勁就
 *    中止、保留原本的語料。清空和寫入在同一個交易裡，半途失敗不會留下半套。
 *
 * @param {{file:string,title:string,path:string,level:number,body:string,chars:number}[]} sections
 * @param {{force?: boolean}} [opts] force：確認過來源沒問題，跳過縮水檢查
 *   （0 節一律拒絕）
 */
export function import_sections(sections, { force = false } = {}) {
	if (!sections.length)
		throw new Error('解析結果是 0 節，保留原本的語料。來源的格式可能改了。');
	const old = corpus_state();
	const chars = sections.reduce((n, s) => n + s.chars, 0);
	if (!force && (sections.length < old.sections * MIN_KEEP || chars < old.chars * MIN_KEEP)) {
		throw new Error(`新語料只有 ${sections.length} 節／${chars} 字，現有 ${old.sections} 節／${old.chars} 字，`
			+ '少太多，保留原本的語料。確認來源沒問題再加 --force。');
	}

	db.exec('BEGIN IMMEDIATE');
	try {
		stmt_clear.run();
		let id = 1;
		for (const s of sections)
			stmt_insert.run(id++, s.file, s.title, s.path, s.level, s.body, s.chars);
		stmt_meta_set.run('imported_at', new Date().toISOString());
		db.exec('COMMIT');
	}
	catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
	return corpus_state();
}

/**
 * 目錄，給模型選章用。
 *
 * ⚠️ 這是兩段式檢索的第一段。實測 385 節、標題總長 3,296 字 —— 整份
 *    目錄塞進 prompt 只要 3K 出頭，比任何本地比對都可靠，而且自動處理
 *    簡繁與日文的落差。
 *
 * @returns {string} 每行一節：`id\tpath`
 */
export function build_toc() {
	return stmt_toc.all().map(r => `${r.id}\t${r.path}`).join('\n');
}

/**
 * 選到「空殼母章節」時，把它的子章節一起帶上。
 *
 * ⚠️ 有些母章節只有一兩行導言，內容全在子章節（例如「进行回合的优先权」201 字，
 *    「› 特定阶段·步骤的优先权转移」才是答案）。第一段模型常只挑到母章節，
 *    結果作答時手上只有導言。字數小於 stub 的才展開，大章節不動。
 *
 * @param {number[]} ids 原本挑的章節（順序保留，新增的排在後面）
 * @param {{id:number,path:string,chars:number}[]} rows 目錄
 * @param {number} stub 小於這個字數視為空殼
 * @param {number} limit 展開後的總數上限
 */
export function expand_stubs(ids, rows, stub = 400, limit = 8) {
	const out = [...ids];
	const by_id = new Map(rows.map(r => [r.id, r]));
	for (const id of ids) {
		const p = by_id.get(id);
		if (!p || p.chars >= stub)
			continue;
		for (const r of rows) {
			if (out.length >= limit)
				return out;
			if (r.path.startsWith(`${p.path} › `) && !out.includes(r.id))
				out.push(r.id);
		}
	}
	return out;
}

/** 目錄（含字數），給 expand_stubs 用。 */
export function toc_rows() {
	return stmt_toc.all();
}

/** 取章節全文。 */
export function get_section(id) {
	return stmt_get.get(id) ?? null;
}

/**
 * 取多節並組成給模型的依據區塊。
 *
 * ⚠️ 原文照貼。對方的使用條款允許引用原文，但明確反對「把自己的理解
 *    說成是本站說的」—— 所以送進去的必須是原文，回答時也要標出處。
 *
 * @param {number[]} ids
 * @param {number} budget 字數上限，避免選到超大章節時塞爆
 */
export function collect_sections(ids, budget = 24000) {
	const out = [];
	let used = 0;
	for (const id of ids) {
		const s = get_section(id);
		if (!s)
			continue;
		const body = used + s.chars > budget ? s.body.slice(0, Math.max(0, budget - used)) : s.body;
		if (!body)
			break;
		out.push({ id: s.id, path: s.path, body });
		used += body.length;
	}
	return out;
}

/**
 * 章節在 Read the Docs 上的網址。
 *
 * 檔名 `c02/基本用语.rst` 對應 `…/zh-cn/latest/c02/基本用语.html`。
 * ⚠️ 不加錨點 —— Sphinx 給中文標題產生的 anchor 規則不穩定，連錯比不連更糟。
 */
export function section_url(file) {
	const path = String(file).replace(/[.]rst$/, '.html');
	return `https://ocg-rule.readthedocs.io/zh-cn/latest/${path.split('/').map(encodeURIComponent).join('/')}`;
}
