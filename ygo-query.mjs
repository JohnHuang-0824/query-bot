import { renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { ltable_ocg, ltable_tcg, ltable_md, pack_list, pre_release, genesys_point, setname_table, load_name_table } from './ygo-json-loader.mjs';
import { language_pack, official_name, cid_table, name_table } from './ygo-json-loader.mjs';
import { escape_wildcard, zh_collator, zh_compare } from './ygo-utility.mjs';
import { db_url1, db_url2, fetch_db } from './ygo-fetch.mjs';
import { card_types, monster_types, link_markers, rarity, CID_BLACK_LUSTER_SOLDIER, spell_types, trap_types, marker_char, card_colors } from "./ygo-constant.mjs";
import { arg_default_v2, arg_seventh, effect_filter, default_clause_v2, sql_base_v2, sql_count_v2, sql_default_v2, sql_seventh, full_tables, default_options } from './ygo-sqlite.mjs';
import { like_pattern, name_condition, list_condition, alter_db, merge_db, query_db_v2, setcode_condition, sqlite3_open } from './ygo-sqlite.mjs';

export const regexp_mention = `(?<=「)[^「」]*「?[^「」]*」?[^「」]*(?=」)`;
const RESULT_PER_PAGE = 50;

/**
 * @type {import('node:sqlite').DatabaseSync}
 */
let db = null;
/**
 * @type {import('node:sqlite').StatementSync}
 */
let stmt_name = null;
/**
 * @type {import('node:sqlite').StatementSync}
 */
let stmt_entry = null;

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
 * @typedef {object} CardData
 * @property {number} ot
 * @property {number} type
 * @property {number} atk
 * @property {number} def
 * @property {number} level
 * @property {number} race
 * @property {number} attribute
 * @property {number} scale
 * @property {number} marker
 * @property {string} setcode
 * @property {number} rule_code
 * @property {number} another_code
 * @property {number} md_rarity
 */

/**
 * @typedef {object} CardText
 * @property {string} [en_name]
 * @property {string} [jp_name]
 * @property {string} [jp_ruby]
 * @property {string} [kr_name]
 * @property {string} [md_name_en]
 * @property {string} [md_name_jp]
 * @property {string} tw_name
 * @property {string} description
 */

/**
 * @typedef {object} Card
 * @property {number} id
 * @property {number|null} cid
 * @property {CardData} data
 * @property {CardText} text
 * @property {number} artid
 * @property {number} [pack_index]
 */

/**
 * @type {Map<number, Card[]>}
 */
const multimap_seventh = new Map();

//workaround
await reload_db();


/**
 * @param {number} id 
 * @returns {Entry|null}
 */
function get_entry(id) {
	if (!stmt_entry)
		return null;
	const arg_entry = {
		...arg_default_v2,
		$id: id,
	};
	const row = stmt_entry.get(arg_entry);
	return row ?? null;
}

/**
 * @param {number} id 
 * @returns {string|null}
 */
function get_db_name(id) {
	if (!stmt_name)
		return null;
	const arg_name = {
		...arg_default_v2,
		$id: id,
	};
	const card = stmt_name.get(arg_name);
	if (!card)
		return null;
	return card.name;
}

/**
 * @param {Entry} cdata 
 * @returns {Card}
 */
function generate_card(cdata) {
	const id = cdata.alias || cdata.id;
	const artid = cdata.alias ? cdata.id : 0;
	const data = {
		__proto__: null,
		ot: cdata.ot,
		type: cdata.type,
		atk: cdata.atk,
		def: cdata.def,
		level: cdata.level,
		race: cdata.race,
		attribute: cdata.attribute,
		scale: cdata.scale,
		marker: cdata.marker,
		setcode: cdata.setcode,
		rule_code: cdata.rule_code,
		another_code: cdata.another_code,
		md_rarity: cdata.md_rarity,
	};
	const text = Object.create(null);
	if (cdata.cid) {
		if (cdata.en_name)
			text.en_name = cdata.en_name;
		else if (cdata.md_name_en)
			text.md_name_en = cdata.md_name_en;
		if (cdata.jp_name)
			text.jp_name = cdata.jp_name;
		else if (cdata.md_name_jp)
			text.md_name_jp = cdata.md_name_jp;
		if (cdata.jp_ruby)
			text.jp_ruby = cdata.jp_ruby;
		if (Object.hasOwn(name_table['ko'], cdata.cid))
			text.kr_name = name_table['ko'][cdata.cid];
	}
	text.tw_name = cdata.name;
	text.description = cdata.description;
	const card = {
		__proto__: null,
		cid: cdata.cid,
		id,
		data,
		text,
		artid,
	};
	return card;
}


// query
function is_string(str) {
	return typeof str === 'string' && str.length > 0;
}

/**
 * Parse param into sqlite statement condition.
 * @param {object} params 
 * @param {number[]} [id_list]
 * @returns {[string, object]}
 */
export function generate_condition(params, id_list) {
	let qstr = "";
	const arg = {};
	const key_condition = [];
	// primary key
	if (Number.isSafeInteger(params.id)) {
		key_condition.push('id = $id');
		arg.$id = params.id;
	}
	if (Number.isSafeInteger(params.cid)) {
		key_condition.push('cid = $cid');
		arg.$cid = params.cid;
	}
	if (key_condition.length) {
		qstr = ` AND (${key_condition.join(' OR ')})`;
		return [qstr, arg];
	}

	// number
	if (Array.isArray(id_list) && id_list.length) {
		qstr += ` AND ${list_condition('id', 'id', id_list, arg)}`;
	}
	if (Number.isSafeInteger(params.ot) && params.ot > 0) {
		qstr += " AND (ot & $ot_mask) = $ot";
		arg.$ot_mask = 0x3;
		arg.$ot = params.ot;
	}
	if (Number.isSafeInteger(params.ot_exclude) && params.ot_exclude > 0) {
		qstr += " AND (ot & $ot_mask) != $ot_exclude";
		arg.$ot_mask = 0x3;
		arg.$ot_exclude = params.ot_exclude;
	}
	if (Number.isSafeInteger(params.released) && params.released > 0) {
		qstr += " AND cid IS NOT NULL";
	}
	if (Number.isSafeInteger(params.type) && params.type > 0) {
		qstr += " AND (type & $type) != 0";
		arg.$type = params.type;
	}
	if (Number.isSafeInteger(params.monster_type) && params.monster_type > 0) {
		qstr += " AND (type & $monster) != 0";
		arg.$monster = card_types.TYPE_MONSTER;
		if (Number.isSafeInteger(params.monster_type_op) && params.monster_type_op)
			qstr += " AND (type & $monster_type) = $monster_type";
		else
			qstr += " AND (type & $monster_type) != 0";
		arg.$monster_type = params.monster_type;
	}
	if (Number.isSafeInteger(params.excluded_type) && params.excluded_type > 0) {
		qstr += " AND (type & $excluded_type) = 0";
		arg.$excluded_type = params.excluded_type;
	}
	if (Number.isSafeInteger(params.spell_type) && params.spell_type > 0) {
		let subtype = params.spell_type;
		let subtype_condition = "(type & $stype) != 0";
		if (subtype & spell_types.TYPE_NORMAL) {
			subtype_condition += " OR type = $spell";
			subtype = (subtype & ~spell_types.TYPE_NORMAL) >>> 0;
		}
		qstr += ` AND (type & $spell) != 0 AND (${subtype_condition})`;
		arg.$spell = card_types.TYPE_SPELL;
		arg.$stype = subtype;
	}
	if (Number.isSafeInteger(params.trap_type) && params.trap_type > 0) {
		let subtype = params.trap_type;
		let subtype_condition = "(type & $ttype) != 0";
		if (subtype & trap_types.TYPE_NORMAL) {
			subtype_condition += " OR type = $trap";
			subtype = (subtype & ~trap_types.TYPE_NORMAL) >>> 0;
		}
		qstr += ` AND (type & $trap) != 0 AND (${subtype_condition})`;
		arg.$trap = card_types.TYPE_TRAP;
		arg.$ttype = subtype;
	}
	if (Number.isSafeInteger(params.mention)) {
		const tw_name = get_db_name(params.mention);
		if (tw_name) {
			if (Object.hasOwn(setname_table, tw_name)) {
				qstr += `${effect_filter} AND description REGEXP $mention`;
				arg.$mention = `「${RegExp.escape(tw_name)}」(?!怪|魔|陷|卡|融合怪獸|同步怪獸|超量怪獸|連結怪獸|儀式怪獸|靈擺怪獸|通常|永續|裝備|速攻|儀式魔法|場地|反擊)`;
			}
			else {
				qstr += `${effect_filter} AND description LIKE $mention ESCAPE '$'`;
				arg.$mention = `%「${escape_wildcard(tw_name)}」%`;
			}
			arg.$normal = monster_types.TYPE_NORMAL;
			arg.$pendulum = monster_types.TYPE_PENDULUM;
		}
	}
	if (Number.isSafeInteger(params.md_rarity)) {
		qstr += " AND md_rarity = $md_rarity";
		arg.$md_rarity = params.md_rarity;
	}
	if (typeof params.pack === 'string' && Object.hasOwn(pack_list, params.pack)) {
		const pack = pack_list[params.pack].filter(x => Number.isSafeInteger(x) && x > 0);
		qstr += ` AND ${list_condition('id', 'pack', pack, arg)}`;
	}
	else if (typeof params.pack === 'string' && Object.hasOwn(pre_release, params.pack)) {
		qstr += " AND (id BETWEEN $pack_begin AND $pack_end)";
		arg.$pack_begin = pre_release[params.pack];
		arg.$pack_end = pre_release[params.pack] + 500;
	}
	else if (Number.isSafeInteger(params.limit) && params.limit > 0) {
		arg.$limit = params.limit;
		if (Number.isSafeInteger(params.offset) && params.offset >= 0) {
			arg.$offset = params.offset;
		}
		else {
			arg.$offset = 0;
		}
	}
	else if (Number.isSafeInteger(params.page) && params.page > 0) {
		arg.$limit = RESULT_PER_PAGE;
		arg.$offset = (params.page - 1) * RESULT_PER_PAGE;
		arg.$page = params.page;
	}

	// text
	if (is_string(params.keyword)) {
		qstr += ` AND (${name_condition(params.keyword, arg)} OR description LIKE $name ESCAPE '$')`;
	}
	else {
		if (is_string(params.name)) {
			qstr += ` AND ${name_condition(params.name, arg)}`;
		}
		else if (Number.isSafeInteger(params.setcode) && params.setcode > 0) {
			qstr += ` AND ${setcode_condition(params.setcode, arg)}`;
		}
		if (is_string(params.desc)) {
			qstr += ` AND description LIKE $description ESCAPE '$'`;
			arg.$description = like_pattern(params.desc);
		}
	}
	if (is_string(params.en_name)) {
		qstr += ` AND (en_name LIKE $en_name ESCAPE '$' OR md_name_en LIKE $en_name ESCAPE '$')`;
		arg.$en_name = params.en_name;
	}
	if (is_string(params.jp_name)) {
		qstr += ` AND (jp_name LIKE $jp_name ESCAPE '$' OR md_name_jp LIKE $jp_name ESCAPE '$')`;
		arg.$jp_name = params.jp_name;
	}
	if (is_string(params.jp_ruby)) {
		qstr += ` AND jp_ruby LIKE $jp_ruby ESCAPE '$'`;
		arg.$jp_ruby = params.jp_ruby;
	}

	let require_monster = false;
	if (Number.isSafeInteger(params.material)) {
		const tw_name = get_db_name(params.material);
		if (tw_name) {
			const material = escape_wildcard(tw_name);
			let material_condition = "0";
			for (let i = 0; i < 4; i += 1) {
				material_condition += ` OR description LIKE $mat${i} ESCAPE '$'`;
			}
			qstr += ` AND (${material_condition})`;
			arg.$mat0 = `「${material}」+%`;
			arg.$mat1 = `「${material}」（%）+%`;
			arg.$mat2 = `%+「${material}」%`;
			arg.$mat3 = `%「${material}」×%`;
			require_monster = true;
		}
	}

	// atk
	const atk_from = (Number.isSafeInteger(params.atk_from) && params.atk_from >= -1) ? params.atk_from : null;
	const atk_to = (Number.isSafeInteger(params.atk_to) && params.atk_to >= -1) ? params.atk_to : null;
	let atk_condition = "";
	if (atk_from === -1 || atk_to === -1) {
		atk_condition = "atk = $unknown";
		arg.$unknown = -2;
		require_monster = true;
	}
	else if (atk_to !== null && atk_to >= 0) {
		atk_condition = "(atk BETWEEN $atk_from AND $atk_to)";
		arg.$atk_from = atk_from ?? 0;
		arg.$atk_to = atk_to;
		require_monster = true;
	}
	else if (atk_from !== null && atk_from >= 0) {
		atk_condition = "atk >= $atk_from";
		arg.$atk_from = atk_from;
		require_monster = true;
	}

	// def, exclude link monsters
	let has_def = false;
	const def_from = (Number.isSafeInteger(params.def_from) && params.def_from >= -2) ? params.def_from : null;
	const def_to = (Number.isSafeInteger(params.def_to) && params.def_to >= -1) ? params.def_to : null;
	let def_condition = "";
	if (def_from === -1 || def_to === -1) {
		def_condition = "def = $unknown";
		arg.$unknown = -2;
		has_def = true;
	}
	else if (def_from === -2) {
		def_condition = "def = atk AND def >= $zero";
		arg.$zero = 0;
		has_def = true;
	}
	else if (def_to !== null && def_to >= 0) {
		def_condition = "(def BETWEEN $def_from AND $def_to)";
		arg.$def_from = def_from ?? 0;
		arg.$def_to = def_to;
		has_def = true;
	}
	else if (def_from !== null && def_from >= 0) {
		def_condition = "def >= $def_from";
		arg.$def_from = def_from;
		has_def = true;
	}
	if (atk_condition && def_condition) {
		qstr += ` AND (${atk_condition} AND ${def_condition})`;
	}
	else if (atk_condition) {
		qstr += ` AND ${atk_condition}`;
	}
	else if (def_condition) {
		qstr += ` AND ${def_condition}`;
	}
	if (Number.isSafeInteger(params.sum) && params.sum >= 0) {
		qstr += " AND atk >= $zero AND def >= $zero AND atk + def = $sum";
		arg.$zero = 0;
		arg.$sum = params.sum;
		has_def = true;
	}
	if (has_def) {
		qstr += " AND (type & $link) = 0";
		arg.$link = monster_types.TYPE_LINK;
		require_monster = true;
	}

	// lv, rank, link
	if (Array.isArray(params.level) && params.level.length) {
		qstr += ` AND ${list_condition('level', 'level', params.level, arg)}`;
		require_monster = true;
	}
	else {
		let level_from = -10;
		let level_to = -10;
		if (Number.isSafeInteger(params.level_from) && params.level_from >= 0)
			level_from = params.level_from;
		if (Number.isSafeInteger(params.level_to) && params.level_to >= 0)
			level_to = params.level_to;
		if (level_from >= 0 && level_to >= 0) {
			qstr += " AND (level BETWEEN $level_from AND $level_to)";
			arg.$level_from = level_from;
			arg.$level_to = level_to;
			require_monster = true;
		}
		else if (level_from >= 0) {
			qstr += " AND level >= $level_from";
			arg.$level_from = level_from;
			require_monster = true;
		}
		else if (level_to >= 0) {
			qstr += " AND level <= $level_to";
			arg.$level_to = level_to;
			require_monster = true;
		}
	}

	// scale, pendulum monster only
	let has_scale = false;
	if (Array.isArray(params.scale) && params.scale.length) {
		qstr += ` AND ${list_condition('scale', 'scale', params.scale, arg)}`;
		has_scale = true;
	}
	else {
		let scale_from = -10;
		let scale_to = -10;
		if (Number.isSafeInteger(params.scale_from) && params.scale_from >= 0)
			scale_from = params.scale_from;
		if (Number.isSafeInteger(params.scale_to) && params.scale_to >= 0)
			scale_to = params.scale_to;
		if (scale_from >= 0 && scale_to >= 0) {
			qstr += ` AND (scale BETWEEN $scale_from AND $scale_to)`;
			arg.$scale_from = scale_from;
			arg.$scale_to = scale_to;
			has_scale = true;
		}
		else if (scale_from >= 0) {
			qstr += ` AND scale >= $scale_from`;
			arg.$scale_from = scale_from;
			has_scale = true;
		}
		else if (scale_to >= 0) {
			qstr += ` AND scale <= $scale_to`;
			arg.$scale_to = scale_to;
			has_scale = true;
		}
	}
	if (has_scale) {
		qstr += " AND type & $pendulum";
		arg.$pendulum = monster_types.TYPE_PENDULUM;
		require_monster = true;
	}

	// attribute, race
	if (Number.isSafeInteger(params.attribute) && params.attribute > 0) {
		qstr += " AND (attribute & $attribute) != 0";
		arg.$attribute = params.attribute;
		require_monster = true;
	}
	if (Number.isSafeInteger(params.race) && params.race > 0) {
		qstr += " AND (race & $race) != 0";
		arg.$race = params.race;
		require_monster = true;
	}
	// marker
	if (Number.isSafeInteger(params.marker) && params.marker > 0) {
		qstr += " AND (type & $link) != 0";
		arg.$link = monster_types.TYPE_LINK;
		if (Number.isSafeInteger(params.marker_op) && params.marker_op)
			qstr += " AND (marker & $marker) = $marker";
		else
			qstr += " AND (marker & $marker) != 0";
		arg.$marker = params.marker;
		require_monster = true;
	}
	if (require_monster && !Object.hasOwn(arg, '$monster')) {
		qstr += " AND (type & $monster) != 0";
		arg.$monster = card_types.TYPE_MONSTER;
	}
	return [qstr, arg];
}

/**
 * @param {string[]} [files]
 */
export async function reload_db(files) {
	if (files === undefined) {
		const base = `${import.meta.dirname}/db/main.cdb`;
		const ext1 = `${import.meta.dirname}/db/pre.cdb`;
		try {
			const task1 = fetch_db(db_url1).then(data => writeFile(base, data));
			const task2 = fetch_db(db_url2).then(data => writeFile(ext1, data));
			await Promise.all([task1, task2]);
		}
		catch (error) {
			console.error(error);
			return;
		}
		files = [base, ext1];
	}
	const temp = `${import.meta.dirname}/db/temp.cdb`;
	if (!merge_db(temp, files)) {
		return;
	}
	const current = `${import.meta.dirname}/db/query.cdb`;
	const full_db = new DatabaseSync(temp, default_options);
	full_db.exec(`PRAGMA trusted_schema = OFF;`);
	alter_db(full_db);
	load_name_table(full_db);
	full_db.close();
	stmt_name?.close();
	stmt_entry?.close();
	db?.close();
	renameSync(temp, current);
	db = sqlite3_open(current);
	stmt_name = db.prepare(`SELECT id, name ${full_tables} ${default_clause_v2} AND id = $id;`);
	stmt_entry = db.prepare(`${sql_default_v2} AND id = $id;`);
	// refresh multimap of No.101 ~ No.107
	multimap_seventh.clear();
	const seventh_cards = query(sql_seventh, arg_seventh);
	seventh_cards.sort((c1, c2) => zh_collator.compare(c1.text.tw_name, c2.text.tw_name));
	for (const card of seventh_cards) {
		if (!multimap_seventh.has(card.data.level))
			multimap_seventh.set(card.data.level, []);
		multimap_seventh.get(card.data.level).push(card);
	}
}

/**
 * Check if setcode contains `value`.
 * @param {Card} card 
 * @param {number} value 
 * @returns {boolean}
 */
export function is_setcode(card, value) {
	const settype = value & 0x0fff;
	const setsubtype = value & 0xf000;
	const setcode = JSON.parse(card.data.setcode);
	for (const x of setcode) {
		if ((x & 0x0fff) === settype && (x & setsubtype) === setsubtype)
			return true;
	}
	return false;
}

/**
 * Query card from all databases with statement `qstr` and binding object `arg`.
 * @param {string} qstr 
 * @param {object} arg 
 * @returns {Card[]}
 */
export function query(qstr = sql_default_v2, arg = arg_default_v2) {
	const rows = query_db_v2(db, qstr, arg);
	const result = rows.map(generate_card);
	return result;
}

/**
 * Query card from all databases with JSON object `params`.
 * @param {object} params 
 */
export function query_card(params) {
	const meta = {
		total: 0,
		limit: 0,
		offset: 0,
	};
	const [condition, arg_condition] = generate_condition(params);
	if (Object.keys(arg_condition).length === 0) {
		return { result: [], meta };
	}
	if (Number.isSafeInteger(params.id) || Number.isSafeInteger(params.cid)) {
		const stmt = `${sql_base_v2}${condition}`;
		const arg = {
			...arg_default_v2,
			...arg_condition,
		};
		const result = query(stmt, arg);
		meta.total = result.length;
		return { result, meta };
	}
	const sql1 = `${sql_default_v2}${condition}`;
	const arg1 = {
		...arg_default_v2,
		...arg_condition,
	};
	const result = query(sql1, arg1);
	meta.total = result.length;
	if (result.length === 0) {
		return { result, meta };
	}
	if (typeof params.pack === 'string' && Object.hasOwn(pack_list, params.pack)) {
		const pack = pack_list[params.pack];
		const index_table = new Map();
		for (let i = 0; i < pack.length; i += 1) {
			if (Number.isSafeInteger(pack[i]) && pack[i] > 0) {
				index_table.set(pack[i], i);
			}
		}
		for (const card of result) {
			card.pack_index = index_table.get(card.id);
		}
		result.sort((a, b) => a.pack_index - b.pack_index);
		meta.pack = params.pack;
	}
	else if (typeof params.pack === 'string' && Object.hasOwn(pre_release, params.pack)) {
		meta.pack = params.pack;
	}
	else if (arg_condition.$limit) {
		meta.limit = arg_condition.$limit;
		meta.offset = arg_condition.$offset;
	}
	if (meta.limit > 0) {
		const command = `${sql_count_v2}${condition};`;
		const arg2 = { ...arg1 };
		delete arg2.$limit;
		delete arg2.$offset;
		using st = db.prepare(command);
		st.setReturnArrays(true);
		const rows = st.all(arg2);
		meta.total = rows[0]?.[0] ?? 0;
		return { result, meta };
	}
	return { result, meta };
}

/**
 * Get a card with id from all databases.
 * @param {number|string} id 
 * @returns {?Card}
 */
export function get_card(id) {
	if (typeof id === 'string')
		id = Number.parseInt(id, 10);
	if (!Number.isSafeInteger(id))
		return null;
	const entry = get_entry(id);
	if (!entry)
		return null;
	if (entry.alias) {
		const base_entry = get_entry(entry.alias);
		if (!base_entry)
			return null;
		const base_card = generate_card(base_entry);
		base_card.artid = entry.id;
		return base_card;
	}
	return generate_card(entry);
}

/**
 * Get the request_locale of `card` in region `locale`.
 * @param {Card} card 
 * @param {string} locale 
 * @returns {string}
 */
export function get_request_locale(card, locale) {
	if (official_name[locale] && card.text[official_name[locale]]) {
		return locale;
	}
	if (card.data.ot & 0x1) {
		return 'ja';
	}
	if (card.data.ot & 0x2) {
		return 'en';
	}
	return 'ja';
}

/**
 * Get No.101 ~ No.107 Xyz Monsters with the same race or attribute.
 * @param {Card} card 
 * @returns {Card[]}
 */
export function get_seventh_xyz(card) {
	if (!(card.data.type & card_types.TYPE_MONSTER))
		return [];
	if (card.data.type & monster_types.TYPES_EXTRA)
		return [];
	if (!multimap_seventh.has(card.data.level))
		return [];
	const result = [];
	for (const seventh of multimap_seventh.get(card.data.level)) {
		if ((seventh.data.race & card.data.race) || (seventh.data.attribute & card.data.attribute)) {
			result.push(seventh);
		}
	}
	return result;
}


// print
/**
 * Print the ATK or DEF of a card.
 * @param {number} x 
 * @returns {string}
 */
export function print_ad(x) {
	if (x === -2)
		return '?';
	else
		return `${x}`;
}

/**
 * Return the formatted lines of card data in `locale`.
 * @param {CardData} data 
 * @param {string} locale 
 * @returns {string[]}
 */
export function print_data(data, locale) {
	const strings = language_pack[locale].strings;
	const result = [];
	if (data.type & card_types.TYPE_MONSTER) {
		const mtype = strings.type_name[card_types.TYPE_MONSTER];
		let subtype = '';
		let lvstr = '\u2605';
		if (data.type & monster_types.TYPE_RITUAL) {
			subtype = `/${strings.type_name[monster_types.TYPE_RITUAL]}`;
		}
		else if (data.type & monster_types.TYPE_FUSION) {
			subtype = `/${strings.type_name[monster_types.TYPE_FUSION]}`;
		}
		else if (data.type & monster_types.TYPE_SYNCHRO) {
			subtype = `/${strings.type_name[monster_types.TYPE_SYNCHRO]}`;
		}
		else if (data.type & monster_types.TYPE_XYZ) {
			subtype = `/${strings.type_name[monster_types.TYPE_XYZ]}`;
			lvstr = `\u2606`;
		}
		else if (data.type & monster_types.TYPE_LINK) {
			subtype = `/${strings.type_name[monster_types.TYPE_LINK]}`;
			lvstr = `LINK-`;
		}
		else if (data.type & monster_types.TYPE_SPSUMMON) {
			subtype = `/${strings.type_name[monster_types.TYPE_SPSUMMON]}`;
		}
		if (data.type & monster_types.TYPE_PENDULUM) {
			subtype += `/${strings.type_name[monster_types.TYPE_PENDULUM]}`;
		}

		// extype
		if (data.type & monster_types.TYPE_NORMAL)
			subtype += `/${strings.type_name[monster_types.TYPE_NORMAL]}`;
		if (data.type & monster_types.TYPE_SPIRIT)
			subtype += `/${strings.type_name[monster_types.TYPE_SPIRIT]}`;
		if (data.type & monster_types.TYPE_UNION)
			subtype += `/${strings.type_name[monster_types.TYPE_UNION]}`;
		if (data.type & monster_types.TYPE_DUAL)
			subtype += `/${strings.type_name[monster_types.TYPE_DUAL]}`;
		if (data.type & monster_types.TYPE_TUNER)
			subtype += `/${strings.type_name[monster_types.TYPE_TUNER]}`;
		if (data.type & monster_types.TYPE_FLIP)
			subtype += `/${strings.type_name[monster_types.TYPE_FLIP]}`;
		if (data.type & monster_types.TYPE_TOON)
			subtype += `/${strings.type_name[monster_types.TYPE_TOON]}`;
		if (data.type & monster_types.TYPE_EFFECT)
			subtype += `/${strings.type_name[monster_types.TYPE_EFFECT]}`;
		result.push(`[${mtype}${subtype}]`);

		const level = `${lvstr}${data.level || '?'}`;
		const attribute = `/${strings.attribute_name[data.attribute] ?? 'null'}`;
		const race = `/${strings.race_name[data.race] ?? 'null'}`;
		const attack = `/${strings.value_name['atk']}${print_ad(data.atk)}`;
		const defense = !(data.type & monster_types.TYPE_LINK) ? `/${strings.value_name['def']}${print_ad(data.def)}` : '';
		result.push(`${level}${attribute}${race}${attack}${defense}`);

		if (data.type & monster_types.TYPE_PENDULUM) {
			const scale_left = ':small_blue_diamond:';
			const scale_right = ':small_orange_diamond:';
			result.push(`${scale_left}${data.scale}/${data.scale}${scale_right}`);
		}
		if (data.type & monster_types.TYPE_LINK) {
			let marker_text = '';
			for (let marker = link_markers.LINK_MARKER_TOP_LEFT; marker <= link_markers.LINK_MARKER_TOP_RIGHT; marker <<= 1) {
				if (data.marker & marker)
					marker_text += marker_char[marker];
				else
					marker_text += marker_char['default'];
			}
			result.push(marker_text);

			marker_text = '';
			if (data.marker & link_markers.LINK_MARKER_LEFT)
				marker_text += marker_char[link_markers.LINK_MARKER_LEFT];
			else
				marker_text += marker_char['default'];
			marker_text += marker_char.center;
			if (data.marker & link_markers.LINK_MARKER_RIGHT)
				marker_text += marker_char[link_markers.LINK_MARKER_RIGHT];
			else
				marker_text += marker_char['default'];
			result.push(marker_text);

			marker_text = '';
			for (let marker = link_markers.LINK_MARKER_BOTTOM_LEFT; marker <= link_markers.LINK_MARKER_BOTTOM_RIGHT; marker <<= 1) {
				if (data.marker & marker)
					marker_text += marker_char[marker];
				else
					marker_text += marker_char['default'];
			}
			result.push(marker_text);
		}
	}
	else if (data.type & card_types.TYPE_SPELL) {
		const extype = data.type & ~card_types.TYPE_SPELL;
		const mtype = `${strings.type_name[card_types.TYPE_SPELL]}`;
		const subtype = `/${strings.type_name[extype] ?? '???'}`;
		result.push(`[${mtype}${subtype}]`);
	}
	else if (data.type & card_types.TYPE_TRAP) {
		const extype = data.type & ~card_types.TYPE_TRAP;
		const mtype = `${strings.type_name[card_types.TYPE_TRAP]}`;
		const subtype = `/${strings.type_name[extype] ?? '???'}`;
		result.push(`[${mtype}${subtype}]`);
	}
	return result;
}

/**
 * Print `card` in language `locale`.
 * @param {Card} card 
 * @param {string} locale 
 * @returns {string}
 */
export function print_card(card, locale) {
	const strings = language_pack[locale].strings;

	let card_name = 'null';
	let other_name = '';
	let description = '';

	switch (locale) {
		case 'zh-tw':
			card_name = card.text.tw_name;
			if (card.text.jp_name)
				other_name += `${card.text.jp_name}\n`;
			else if (card.text.md_name_jp)
				other_name += `${card.text.md_name_jp}    (MD)\n`;
			if (card.text.en_name)
				other_name += `${card.text.en_name}\n`;
			else if (card.text.md_name_en)
				other_name += `${card.text.md_name_en}    (MD)\n`;
			description = `${card.text.description}\n--`;
			break;
		case 'ja':
			if (card.text.jp_name)
				card_name = card.text.jp_name;
			else if (card.text.md_name_jp)
				card_name = `${card.text.md_name_jp}    (MD)`;

			if (card.text.en_name)
				other_name = `${card.text.en_name}\n`;
			else if (card.text.md_name_en)
				other_name = `${card.text.md_name_en}    (MD)\n`;
			description = '';
			break;
		case 'ko':
			if (card.text.kr_name)
				card_name = card.text.kr_name;

			if (card.text.en_name)
				other_name = `${card.text.en_name}\n`;
			else if (card.text.md_name_en)
				other_name = `${card.text.md_name_en}    (MD)\n`;
			description = '';
			break;
		case 'en':
			if (card.text.en_name)
				card_name = card.text.en_name;
			else if (card.text.md_name_en)
				card_name = `${card.text.md_name_en}    (MD)`;

			if (card.text.jp_name)
				other_name = `${card.text.jp_name}\n`;
			else if (card.text.md_name_jp)
				other_name = `${card.text.md_name_jp}    (MD)\n`;
			description = '';
			break;
		default:
			break;
	}

	const md_status = card.data.md_rarity ? `MD：${rarity[card.data.md_rarity]}\n` : '';
	let lfstr = '';
	let lfstr_ocg;
	let lfstr_tcg;
	let lfstr_md;
	let show_lflist = false;
	if (Number.isSafeInteger(ltable_ocg[card.id])) {
		lfstr_ocg = `OCG：${strings.limit_name[ltable_ocg[card.id]]}`;
		show_lflist = true;
	}
	else {
		lfstr_ocg = `OCG：-`;
	}
	if (Number.isSafeInteger(ltable_tcg[card.id])) {
		lfstr_tcg = `TCG：${strings.limit_name[ltable_tcg[card.id]]}`;
		show_lflist = true;
	}
	else {
		lfstr_tcg = `TCG：-`;
	}
	if (Number.isSafeInteger(ltable_md[card.id])) {
		lfstr_md = `MD：${strings.limit_name[ltable_md[card.id]]}`;
		show_lflist = true;
	}
	else {
		lfstr_md = `MD：-`;
	}
	if (show_lflist)
		lfstr = `(${lfstr_ocg} / ${lfstr_tcg} / ${lfstr_md})\n`;

	let genesys_status = '';
	if (card.cid && genesys_point[card.cid]) {
		genesys_status = `Genesys：${genesys_point[card.cid]}\n`;
	}
	const card_text = `**${card_name}**\n${other_name}${md_status}${genesys_status}${lfstr}${print_data(card.data, locale).join('\n')}\n${description}\n`;
	return card_text;
}


// table
/**
 * Create the [name, id] table for pre-release cards.
 * @returns {Map<string, number>}
 */
export function create_choice_prerelease() {
	const choices = new Map();
	const sql_pre = `${sql_default_v2} AND cid IS NULL;`;
	const re_kanji = /※.*/;
	const cards = query(sql_pre);
	for (const card of cards) {
		const res = card.text.description.match(re_kanji);
		const kanji = res ? res[0] : '';
		if (choices.has(card.text.tw_name) || kanji && choices.has(kanji)) {
			console.error('choice_prerelease', card.id);
			return new Map();
		}
		choices.set(card.text.tw_name, card.id);
		if (kanji)
			choices.set(kanji, card.id);
	}
	return new Map([...choices].sort(zh_compare))
}

/**
 * Create the [name, id] table from database file.
 * @returns {Map<string, number>}
 */
export function create_choice_db() {
	const choices = new Map();
	const re_kanji = /※.*/;
	const sql_db = `${sql_default_v2} AND cid IS NOT NULL;`;
	for (const card of query(sql_db)) {
		const res = card.text.description.match(re_kanji);
		const kanji = res ? res[0] : '';
		let key = card.text.tw_name;
		if (card.cid === CID_BLACK_LUSTER_SOLDIER) {
			key += language_pack['zh-tw'].bls_postfix;
		}
		if (choices.has(key) || kanji && choices.has(kanji)) {
			console.error('choice_db', card.id);
			return new Map();
		}
		choices.set(key, card.id);
		if (kanji)
			choices.set(kanji, card.id);
	}
	return new Map([...choices].sort(zh_compare))
}

export function create_name_table() {
	const table1 = new Map();
	const sql_name = `${sql_default_v2} AND cid IS NOT NULL;`;
	for (const card of query(sql_name)) {
		table1.set(card.cid, card.text.tw_name);
	}
	table1.set(CID_BLACK_LUSTER_SOLDIER, `${table1.get(CID_BLACK_LUSTER_SOLDIER)}${language_pack['zh-tw'].bls_postfix}`);
	if (table1.size !== cid_table.size)
		console.error('invalid name_table_tw:', cid_table.size, table1.size);
	return table1;
}

export {
	card_types, monster_types, spell_types, trap_types,
	link_markers, races, attributes,
} from './ygo-constant.mjs';

export * from './ygo-json-loader.mjs';

export * from './ygo-utility.mjs';
