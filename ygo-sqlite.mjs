import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MAX_CARD_ID, monster_types } from "./ygo-constant.mjs";
import { escape_wildcard, inverse_mapping } from "./ygo-utility.mjs";
import { id_to_cid, extra_setcodes, setname_table } from "./ygo-json-loader.mjs";
import { update_schema } from "./schema/update-schema.mjs";

export {
	CID_BLACK_LUSTER_SOLDIER,
	MAX_CARD_ID,
	card_types,
	monster_types,
	spell_types,
	trap_types,
	races,
	attributes,
	link_markers,
} from './ygo-constant.mjs';

export const CARD_ARTWORK_VERSIONS_OFFSET = 20;
export const ID_BLACK_LUSTER_SOLDIER = 5405695;
export const ID_TIMAEUS = 10000050;
export const ID_CRITIAS = 10000060;
export const ID_HERMOS = 10000070;
export const ALT_DARK_MAGICIAN = 36996508;
export const ALT_POLYMERIZATION = 27847700;

// excluded cards
const ID_TYLER_THE_GREAT_WARRIOR = 68811206;
const ID_DECOY = 20240828;

// old schema tables
export const basic_columns = `id, datas.ot, datas.alias, CAST(datas.setcode AS TEXT) AS setcode, datas.type, datas.atk, datas.def, datas.level, datas.race, datas.attribute, texts.name, texts."desc"`;
export const basic_tables = `FROM datas JOIN texts USING (id)`;

export const default_clause_v1 = `WHERE id NOT IN ($tyler, $decoy) AND (type & $token) = 0 AND (id = $luster OR abs(id - alias) >= $artwork_offset)`;
export const sql_default_v1 = `SELECT ${basic_columns} ${basic_tables} ${default_clause_v1}`;
export const sql_count_v1 = `SELECT count(*) ${basic_tables} ${default_clause_v1}`;
export const arg_default_v1 = {
	$tyler: ID_TYLER_THE_GREAT_WARRIOR,
	$decoy: ID_DECOY,
	$token: monster_types.TYPE_TOKEN,
	$luster: ID_BLACK_LUSTER_SOLDIER,
	$artwork_offset: CARD_ARTWORK_VERSIONS_OFFSET,
};

export const base_clause_v1 = `WHERE id NOT IN ($tyler, $decoy) AND (type & $token) = 0`;
export const sql_base_v1 = `SELECT ${basic_columns} ${basic_tables} ${base_clause_v1}`;
export const arg_base_v1 = {
	$tyler: ID_TYLER_THE_GREAT_WARRIOR,
	$decoy: ID_DECOY,
	$token: monster_types.TYPE_TOKEN,
};


// schema v2 tables
export const full_columns = `id, datas.ot, datas.alias, datas.rule_code, datas.another_code, datas.type, datas.atk, datas.def, datas.level, datas.race, datas.attribute,
datas.scale, datas.marker, datas.setcode, texts.name, texts.description,
extension.cid, extension.en_name, extension.jp_name, extension.jp_ruby, extension.md_name_en, extension.md_name_jp, coalesce(extension.md_rarity, 0) AS md_rarity`;
export const full_tables = `FROM datas JOIN texts USING (id) LEFT JOIN extension USING (id)`;

export const default_clause_v2 = `WHERE (type & $token) = 0 AND (cid IS NOT NULL OR id > ${MAX_CARD_ID})`;
export const sql_default_v2 = `SELECT ${full_columns} ${full_tables} ${default_clause_v2}`;
export const sql_count_v2 = `SELECT count(*) ${full_tables} ${default_clause_v2}`;
export const arg_default_v2 = {
	$token: monster_types.TYPE_TOKEN,
};

export const base_clause_v2 = `WHERE (type & $token) = 0`;
export const sql_base_v2 = `SELECT ${full_columns} ${full_tables} ${base_clause_v2}`;
export const effect_filter = ` AND ((type & $normal) = 0 OR (type & $pendulum) != 0)`;

const over_hundred = ` AND (name like $n101 OR name like $n102 OR name like $n103 OR name like $n104 OR name like $n105 OR name like $n106 OR name like $n107)`;
export const sql_seventh = `${sql_default_v2} AND cid IS NOT NULL AND (type & $xyz) != 0${over_hundred}`;
export const arg_seventh = {
	...arg_default_v2,
	$xyz: monster_types.TYPE_XYZ,
	$n101: '%No.101%',
	$n102: '%No.102%',
	$n103: '%No.103%',
	$n104: '%No.104%',
	$n105: '%No.105%',
	$n106: '%No.106%',
	$n107: '%No.107%',
};

export const default_options = {
	allowExtension: false,
	defensive: true,
};

const sql_delete = `BEGIN TRANSACTION;
DELETE FROM datas WHERE id = ${ID_TYLER_THE_GREAT_WARRIOR};
DELETE FROM texts WHERE id = ${ID_TYLER_THE_GREAT_WARRIOR};
DELETE FROM datas WHERE id = ${ID_DECOY};
DELETE FROM texts WHERE id = ${ID_DECOY};
COMMIT;`;

const sql_color = `ALTER TABLE datas ADD COLUMN color INTEGER
GENERATED ALWAYS AS (
    CASE (type & 0x59f60d7)
        WHEN 0x4000 THEN 0x0
        WHEN 0x4011 THEN 0x0
        WHEN 0x11   THEN 0x1
        WHEN 0x1000011 THEN 0x2
        WHEN 0x81   THEN 0x3
        WHEN 0x1000081 THEN 0x4
        WHEN 0x41   THEN 0x5
        WHEN 0x1000041 THEN 0x6
        WHEN 0x2001 THEN 0x7
        WHEN 0x1002001 THEN 0x8
        WHEN 0x800001 THEN 0x9
        WHEN 0x1800001 THEN 0xa
        WHEN 0x4000001 THEN 0xb
        WHEN 0x2 THEN 0x10
        WHEN 0x10002 THEN 0x11
        WHEN 0x20002 THEN 0x12
        WHEN 0x40002 THEN 0x13
        WHEN 0x82 THEN 0x14
        WHEN 0x80002 THEN 0x15
        WHEN 0x4 THEN 0x20
        WHEN 0x20004 THEN 0x21
        WHEN 0x100004 THEN 0x22
        ELSE CASE
            WHEN (type & 0x21) = 0x21 THEN 0xc
            ELSE -1
        END
    END
);`;

export const re_wildcard = /(?<!\$)[%_]/;
const replace_dollar = /\$(?![%_])/g;

const normalized_setname_table = Object.create(null);
for (const name of Object.keys(setname_table)) {
	normalized_setname_table[name.toLowerCase()] = setname_table[name];
}

/**
 * @typedef {object} Entry
 * @property {number} id
 * @property {number|null} cid
 * @property {number} ot
 * @property {number} alias
 * @property {number} rule_code
 * @property {number} another_code
 * @property {number} type
 * @property {number} atk
 * @property {number} def
 * @property {number} level
 * @property {number} race
 * @property {number} attribute
 * @property {number} scale
 * @property {number} marker
 * @property {string} setcode
 * @property {number} md_rarity
 * 
 * @property {string} name
 * @property {string|null} en_name
 * @property {string|null} jp_name
 * @property {string|null} jp_ruby
 * @property {string|null} md_name_en
 * @property {string|null} md_name_jp
 * @property {string} description
 */

/**
 * @param {string} pattern 
 * @param {string} str 
 * @returns 
 */
function regexp_test(pattern, str) {
	try {
		const re = new RegExp(pattern, 'u');
		return re.test(str) ? 1 : 0;
	}
	catch {
		return 0;
	}
}

/**
 * Open a database file and add custom functions `regexp`.
 * @param {string} filename 
 * @returns {DatabaseSync}
 */
export function sqlite3_open(filename) {
	const db_option = {
		...default_options,
		readOnly: true,
	};
	const regexp_option = {
		deterministic: true,
		directOnly: true,
	};
	const db = new DatabaseSync(filename, db_option);
	db.exec(`PRAGMA trusted_schema = OFF;`);
	db.function('regexp', regexp_option, regexp_test);
	return db;
}

/**
 * Merge databases into a new file `output_file`.
 * @param {string} output_file
 * @param {string[]} db_list
 * @returns {boolean}
 */
export function merge_db(output_file, db_list) {
	if (db_list.length === 0) {
		return false;
	}
	copyFileSync(db_list[0], output_file);
	using base = new DatabaseSync(output_file, default_options);
	base.exec(`PRAGMA trusted_schema = OFF;`);
	using stmt_attach = base.prepare(`ATTACH DATABASE ? AS sub;`);
	const sql_merge = `BEGIN TRANSACTION;
	INSERT OR REPLACE INTO datas SELECT * FROM sub.datas;
	INSERT OR REPLACE INTO texts SELECT * FROM sub.texts;
	COMMIT;`;
	for (let i = 1; i < db_list.length; i++) {
		try {
			stmt_attach.run(db_list[i]);
			base.exec(sql_merge);
			base.exec(`DETACH DATABASE sub;`);
		}
		catch (error) {
			console.error('Failed to merge database:', db_list[i]);
			console.error(error);
			return false;
		}
	}
	return true;
}

/**
 * Update the database to the new schema.
 * @param {DatabaseSync} db 
 */
export function alter_db(db) {
	db.exec(sql_delete);
	update_schema(db);
	db.exec(sql_color);
}

/**
 * Query cards from `db` with schema v2 using statement `qstr` and binding object `arg`.
 * @param {DatabaseSync} db 
 * @param {string} sql 
 * @param {object} arg 
 * @returns {Entry[]}
 */
export function query_db_v2(db, sql = sql_default_v2, arg = arg_default_v2) {
	let page_filter = '';
	if (Number.isSafeInteger(arg.$limit)) {
		page_filter = `LIMIT $limit`;
		if (Number.isSafeInteger(arg.$offset)) {
			page_filter += ` OFFSET $offset`;
		}
	}
	const order_filter = arg.$page ? `ORDER BY color, level DESC, name` : `ORDER BY id`;
	const full_sql = `${sql} ${order_filter} ${page_filter}`;
	delete arg.$page;
	using stmt = db.prepare(full_sql);
	return stmt.all(arg);
}

/**
 * The sqlite condition of setcode.
 * @param {number} setcode
 * @param {object} arg
 * @returns {string}
 */
export function setcode_condition(setcode, arg) {
	const condition = "EXISTS (SELECT 1 FROM json_each(setcode) WHERE (value & $mask) = $setcode)";
	arg.$mask = 0x0fff | setcode;
	arg.$setcode = setcode;
	return condition;
}

/**
 * The sqlite condition for a list.
 * @param {string} column 
 * @param {string} prefix 
 * @param {number[]} list 
 * @param {object} arg 
 * @returns {string}
 */
export function list_condition(column, prefix, list, arg) {
	const set1 = new Set(list);
	const tokens = [];
	let index = 0;
	for (const value of set1) {
		if (!Number.isSafeInteger(value)) {
			continue;
		}
		tokens.push(`@${prefix}${index}`);
		arg[`@${prefix}${index}`] = value;
		index += 1;
	}
	return `${column} IN (${tokens.join(', ')})`;
}

/**
 * Convert a string to a LIKE pattern.
 * @param {string} str 
 * @returns {string}
 */
export function like_pattern(str) {
	if (!str)
		return '';
	if (re_wildcard.test(str))
		return str;
	return `%${str.replace(replace_dollar, '$$$&')}%`;
}

/**
 * Generate the name condition of a statement.
 * @param {string} input
 * @param {object} arg
 * @returns {string}
 */
export function name_condition(input, arg) {
	const condition = `name LIKE $name ESCAPE '$' OR description LIKE $kanji ESCAPE '$' OR rule_code IN (SELECT id ${full_tables} ${default_clause_v2} AND name LIKE $name ESCAPE '$')`;
	arg.$name = `%${escape_wildcard(input)}%`;
	arg.$kanji = `%※%${escape_wildcard(input)}%`;
	const keyword = input.toLowerCase();
	const setcode = Object.hasOwn(normalized_setname_table, keyword) ? ` OR ${setcode_condition(normalized_setname_table[keyword], arg)}` : '';
	return `(${condition}${setcode})`;
}


// database tool
/**
 * Write int64 `setcode` to an array.
 * @param {number[]} list 
 * @param {bigint} setcode 
 */
export function write_setcode(list, setcode) {
	if (!setcode) {
		return;
	}
	for (let i = 0; i < 4; i += 1) {
		const section = (setcode >> BigInt(i * 16)) & 0xffffn;
		if (!section) {
			return;
		}
		list.push(Number(section));
	}
}

/**
 * Query cards from `db` using statement `qstr` and binding object `arg`.
 * @param {DatabaseSync} db 
 * @param {string} sql 
 * @param {object} arg 
 * @returns {object[]}
 */
export function query_db(db, sql = sql_default_v1, arg = arg_default_v1) {
	let page_filter = '';
	if (Number.isSafeInteger(arg.$limit)) {
		page_filter = ` LIMIT $limit`;
		if (Number.isSafeInteger(arg.$offset)) {
			page_filter += ` OFFSET $offset`;
		}
	}
	const full_sql = `${sql} ORDER BY id${page_filter}`;
	using stmt = db.prepare(full_sql);
	const rows = stmt.all(arg);
	return rows.map(row => {
		const { setcode, ...rest } = row;
		const card = {
			__proto__: null,
			...rest,
		};
		if (Object.hasOwn(card, 'level')) {
			const value = card.level;
			card.level = value & 0xffff;
			card.scale = value >>> 24;
		}
		if (typeof setcode === 'string') {
			const setcode_list = [];
			const value = BigInt(setcode);
			if (extra_setcodes[card.id])
				setcode_list.push(...extra_setcodes[card.id]);
			else
				write_setcode(setcode_list, value);
			card.setcode = setcode_list;
		}
		return card;
	});
}

/**
 * Get cards from databases file at `path` using statement `sql` and binding object `arg`.
 * @param {string} path
 * @param {string} sql 
 * @param {object} arg 
 * @returns 
 */
export function read_db(path, sql = sql_default_v1, arg = arg_default_v1) {
	using db = sqlite3_open(path);
	const rows = query_db(db, sql, arg);
	return rows;
}

/**
 * Check if the card name is unique in the database file.
 * @param {string} path 
 * @param {number} id_luster
 * @returns 
 */
export function check_uniqueness(path, id_luster = ID_BLACK_LUSTER_SOLDIER) {
	const condition = `WHERE ((type & $token) = 0 OR alias = $none) AND ((type & $token) != 0 OR id = $luster OR abs(id - alias) >= $artwork_offset)`;
	const stmt1 = `SELECT id, texts.name ${basic_tables} ${condition}`;
	const arg1 = {
		$token: monster_types.TYPE_TOKEN,
		$luster: id_luster,
		$artwork_offset: CARD_ARTWORK_VERSIONS_OFFSET,
		$none: 0,
	};
	const cards = read_db(path, stmt1, arg1);
	if (cards.length === 0) {
		console.error('No cards found in the database:', path);
		return false;
	}
	const table1 = new Map();
	const postfix = 'N';
	for (const card of cards) {
		table1.set(card.id, card.name)
	}
	if (table1.has(id_luster)) {
		table1.set(id_luster, `${table1.get(id_luster)}${postfix}`);
	}
	if (table1.has(ALT_POLYMERIZATION)) {
		console.log('alternative Polymerization');
		table1.delete(ALT_POLYMERIZATION);
	}
	if (table1.has(ALT_DARK_MAGICIAN)) {
		console.log('alternative Dark Magician');
		table1.delete(ALT_DARK_MAGICIAN);
	}
	console.log('total:', table1.size);
	const inv1 = inverse_mapping(table1);
	return inv1.size === table1.size;
}

/**
 * @param {number} id 
 * @returns {number}
 */
export function get_source_cid(id) {
	for (let i = id; i > id - CARD_ARTWORK_VERSIONS_OFFSET; i -= 1) {
		if (id_to_cid.has(i))
			return id_to_cid.get(i);
	}
	return 0;
}
