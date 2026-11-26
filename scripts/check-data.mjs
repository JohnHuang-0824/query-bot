/**
 * data/ 過期檢查：下載最新卡表、套上倉庫裡的 data/，只要有卡因為沒有官方
 * 編號而查不到就以非零結束。每週由 .github/workflows/data-check.yml 跑一次。
 *
 *   node scripts/check-data.mjs
 *
 * 不需要安裝套件。
 * ⚠️ 載入卡表會重寫 db/query.cdb，不要跟 bot 或測試同時跑。下載失敗時如果
 *    本機有舊的卡表，檢查的是舊的（上面會印出下載錯誤）。
 */

import { hidden_cards } from '../ygo-datacheck.mjs';

const SHOW = 30;

/** 在 GitHub Actions 上讓訊息出現在執行結果頁 */
function fail(message) {
	console.error(process.env.GITHUB_ACTIONS ? `::error title=data/ 過期檢查::${message}` : message);
	process.exitCode = 1;
}

let cards;
try {
	// 載入時下載卡表、合併出 db/query.cdb
	await import('../ygo-query.mjs');
	cards = hidden_cards();
}
catch (error) {
	console.error(error);
	fail('沒辦法檢查：卡表載入失敗（下載不到？）');
}

if (cards?.length) {
	fail(`${cards.length} 張卡沒有官方編號、查不到。到開發機同步 data/ 和 pack/（步驟見 README_部署.md）；`
		+ '同步後還是紅的，代表上游也還沒補上編號。');
	for (const c of cards.slice(0, SHOW))
		console.log(`  ${c.id} ${c.name}`);
	if (cards.length > SHOW)
		console.log(`  …還有 ${cards.length - SHOW} 張`);
}
else if (cards) {
	console.log('沒有查不到的卡，data/ 沒有過期。');
}
