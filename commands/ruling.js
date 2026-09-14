import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { autocomplete_default, choice_table } from '../common_all.js';
import { get_card } from '../ygo-query.mjs';
import {
	cache_state, get_rulings, get_common_rulings,
	fetch_rulings, ensure_detail, qa_link, breaker_state,
} from '../ygo-ruling.mjs';

export const module_url = import.meta.url;

// ⚠️ 開發期間一律掛 experimental —— deploy-commands.js 會把它**只**註冊到
//    GUILD_ID 那一個測試伺服器，不會全域公開。
//    等 salix5/cdb#1 回覆、確定可以公開之後，才拿掉這一行。
export const experimental = true;

/** 一次最多展開幾條裁定的全文。其餘只列標題。 */
const MAX_DETAIL = 2;

/**
 * 每條答案顯示到多少字。
 *
 * ⚠️ 這不只是 Discord 2000 字上限的技術妥協 —— **摘錄 + 連回原頁正是
 *    「不轉散布全文」那條承諾的樣子**（架構決策第七節）。實測有答案
 *    長到 2452 字，整段貼上來就不是引用了。
 */
const ANSWER_BUDGET = 600;

export const data = new SlashCommandBuilder()
	.setName('ruling')
	.setDescription('查官方裁定（Q&A）')
	.addStringOption(option => option.setName('card1')
		.setDescription('卡名')
		.setRequired(true)
		.setMaxLength(50)
		.setAutocomplete(true)
	)
	.addStringOption(option => option.setName('card2')
		.setDescription('第二張卡（只看同時提到這兩張卡的裁定）')
		.setRequired(false)
		.setMaxLength(50)
		.setAutocomplete(true)
	);
data.integration_types = [0, 1];
data.contexts = [0, 1, 2];

// autocomplete_default 吃的是「目前聚焦的那個選項」，所以 card1 / card2
// 共用同一個 handler，不必分辨是哪一個。
export async function autocomplete(interaction) {
	await autocomplete_default(interaction, 'full');
}

function resolve_card(input) {
	if (!input)
		return null;
	const table = choice_table['full'];
	if (!table || !table.has(input))
		return null;
	return get_card(table.get(input)) ?? null;
}

function faq_url(fid) {
	return `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=5&fid=${fid}&request_locale=ja`;
}

function clip(text, budget) {
	if (!text)
		return '';
	return text.length <= budget ? text : `${text.slice(0, budget)}…`;
}

/**
 * 一條裁定的呈現。
 *
 * ⚠️ 原文照貼，不改寫、不翻譯、不摘要 —— 裁定的日文原文是唯一有效力的
 *    版本（架構決策第一節）。太長時只截斷並連回原頁，不做濃縮。
 */
function format_ruling(r) {
	const q = clip(r.question, 180);
	const a = r.answer ? clip(r.answer, ANSWER_BUDGET) : '（尚未取得全文）';
	return [
		`**Q.** ${q}`,
		`**A.** ${a}`,
		`-# Q&A ${r.fid}・更新 ${r.updated_at ?? '—'}・<${faq_url(r.fid)}>`,
	].join('\n');
}

function qa_buttons(cards) {
	const row = new ActionRowBuilder();
	for (const card of cards) {
		row.addComponents(new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel(`官方 Q&A：${clip(card.text?.name ?? String(card.id), 60)}`)
			.setURL(qa_link(card.cid))
		);
	}
	return [row];
}

export async function execute(interaction) {
	// ⚠️ defer 必須在任何 I/O 之前。先查資料庫或抓網頁再 defer 是 Discord
	//    bot 最常見的初學錯誤：低負載時正常，一慢就整批互動失效。
	await interaction.deferReply();

	const raw2 = interaction.options.getString('card2');
	const card1 = resolve_card(interaction.options.getString('card1'));
	const card2 = resolve_card(raw2);

	if (!card1 || (raw2 && !card2)) {
		await interaction.editReply('沒有符合條件的卡片。');
		return;
	}
	const cards = card2 ? [card1, card2] : [card1];
	if (cards.some(c => !c.cid)) {
		await interaction.editReply('這張卡在官方資料庫裡沒有對應編號，查不到裁定。');
		return;
	}

	// 快取沒有或過期才抓。⚠️ 第一次查某張卡會明顯變慢（實測 6～14 秒），
	// 那是 on-demand 的代價 —— 不做預抓是合規要求，不是效能取捨。
	for (const card of cards) {
		const state = cache_state(card.cid);
		if (!state.fetched || !state.fresh)
			await fetch_rulings(card.cid);
	}

	const rulings = card2
		? get_common_rulings(card1.cid, card2.cid)
		: get_rulings(card1.cid);

	if (rulings.length) {
		const shown = rulings.slice(0, MAX_DETAIL);
		for (const r of shown)
			await ensure_detail(r.fid);
		// ensure_detail 寫回資料庫，所以重讀一次拿到 answer
		const fresh = card2
			? get_common_rulings(card1.cid, card2.cid)
			: get_rulings(card1.cid);
		const by_fid = new Map(fresh.map(r => [r.fid, r]));

		const body = shown.map(r => format_ruling(by_fid.get(r.fid) ?? r)).join('\n\n');
		const rest = rulings.slice(MAX_DETAIL);
		const more = rest.length
			? `\n\n**另有 ${rest.length} 條**\n` + rest.slice(0, 5).map(r => `・${clip(r.question, 70)} <${faq_url(r.fid)}>`).join('\n')
			: '';
		await interaction.editReply({
			content: clip(`${body}${more}\n-# 內容取自 Konami 官方資料庫，非官方裁定`, 1950),
			components: qa_buttons(cards),
		});
		return;
	}

	// ⚠️ 降級模式 —— 一級功能，不是錯誤處理。零內文重製，而且對老手仍然
	//    有用：他們要的往往就是「幫我翻到那一頁」。
	//
	// ⚠️ 而「查無官方裁定」只有在真的查完的時候才說得出口。沒抓過、抓不完
	//    整、或熔斷中都不算 —— 那樣講就是另一種形式的編造。
	const states = cards.map(c => cache_state(c.cid));
	const looked = states.every(s => s.fetched && s.complete);
	const breaker = breaker_state();

	let msg;
	if (breaker.tripped)
		msg = '目前暫停抓取官方資料（已達今日上限），可以直接開官方 Q&A 頁：';
	else if (!looked)
		msg = '尚未取得完整的裁定清單，可以直接開官方 Q&A 頁：';
	else if (card2)
		msg = '**查無同時提到這兩張卡的官方裁定。**\n這不代表可以自行推論結果 —— 請洽裁判或官方事務局。';
	else
		msg = '**這張卡目前查無官方裁定。**';

	await interaction.editReply({
		content: `${msg}\n-# 本回覆非官方裁定`,
		components: qa_buttons(cards),
	});
}
