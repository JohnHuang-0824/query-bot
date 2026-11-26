/**
 * data/ 過期偵測。
 *
 * 卡表（cards.cdb）每次啟動都從上游下載，data/ 裡的官方編號表卻是倉庫裡的
 * 靜態檔。新卡發售後沒同步 data/ 的話，那些卡沒有編號 —— 而上游的查詢條件
 * （ygo-sqlite.mjs 的 default_clause_v2）會把沒有編號的正式卡號整個排除：
 * /card、autocomplete、/ask 全部查不到，也沒有任何錯誤訊息。
 * 2026-11 實際發生過：data/ 落後兩個多月，161 張卡查不到，是人工比對才發現的。
 *
 * ⚠️ 這裡只讀合併後的卡表，不 import ygo-query.mjs —— 那會觸發下載。
 */

import { DatabaseSync } from 'node:sqlite';
import { MAX_CARD_ID, monster_types } from './ygo-constant.mjs';

const CARD_DB = new URL('./db/query.cdb', import.meta.url).pathname;
const SHOW = 5;

/**
 * 因為沒有官方編號而查不到的卡。
 * 衍生物本來就不列、異畫（alias != 0）本來就沒有編號、先行卡的卡號大於
 * MAX_CARD_ID 不受那個條件影響 —— 三種都不算。
 * @param {string} db_path
 * @returns {{id: number, name: string}[]}
 */
export function hidden_cards(db_path = CARD_DB) {
	const db = new DatabaseSync(db_path, { readOnly: true });
	try {
		return db.prepare(`
			SELECT datas.id, texts.name
			FROM datas JOIN texts USING (id) LEFT JOIN extension USING (id)
			WHERE (datas.type & ?) = 0 AND datas.alias = 0
				AND extension.cid IS NULL AND datas.id <= ?
			ORDER BY datas.id
		`).all(monster_types.TYPE_TOKEN, MAX_CARD_ID);
	}
	finally {
		db.close();
	}
}

/**
 * 啟動時呼叫：有查不到的卡就寫一行警告。檢查本身失敗不能讓 bot 起不來。
 * @param {string} [db_path]
 * @param {(message: string) => void} [warn]
 */
export function report_hidden_cards(db_path = CARD_DB, warn = console.warn) {
	try {
		const cards = hidden_cards(db_path);
		if (!cards.length)
			return;
		const names = cards.slice(0, SHOW).map(c => c.name).join('、');
		warn(`[資料] ${cards.length} 張卡沒有官方編號、查不到（${names}${cards.length > SHOW ? '…' : ''}）。`
			+ 'data/ 可能過期了，同步方法見 README_部署.md');
	}
	catch (error) {
		warn(`[資料] 無法檢查 data/ 是否過期：${error.message}`);
	}
}
