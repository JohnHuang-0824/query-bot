import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { autocomplete_default, choice_table } from '../common_all.js';
import { get_card } from '../ygo-query.mjs';
import { cache_state, get_rulings, get_common_rulings, fetch_rulings, qa_link } from '../ygo-ruling.mjs';

export const module_url = import.meta.url;

// ⚠️ 開發期間一律掛 experimental —— deploy-commands.js 會把它**只**註冊到
//    GUILD_ID 那一個測試伺服器，不會全域公開。
//    等 salix5/cdb#1 回覆、確定可以公開之後，才拿掉這一行。
export const experimental = true;

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

/**
 * 卡名 → card（含 cid）。查不到回 null。
 * @param {string} input
 */
function resolve_card(input) {
	if (!input)
		return null;
	const table = choice_table['full'];
	if (!table || !table.has(input))
		return null;
	return get_card(table.get(input)) ?? null;
}

/**
 * 一條裁定的呈現。
 *
 * ⚠️ 原文照貼，不改寫、不翻譯、不摘要。裁定的日文原文是唯一有效力的
 *    版本，中文譯本沒有裁定效力（見 架構決策.md 第一節）。
 * @param {{fid: number, question: string, answer: string, updated_at: string}} r
 */
function format_ruling(r) {
	const url = `https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=5&fid=${r.fid}&request_locale=ja`;
	return [
		`**Q.** ${r.question}`,
		`**A.** ${r.answer}`,
		`-# 官方 Q&A ${r.fid}・更新 ${r.updated_at ?? '—'}・<${url}>`,
	].join('\n');
}

/** 給每張卡一顆連到官方 Q&A 頁的按鈕。 */
function qa_buttons(cards) {
	const row = new ActionRowBuilder();
	for (const card of cards) {
		row.addComponents(new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel(`Q&A：${card.text?.name ?? card.id}`)
			.setURL(qa_link(card.cid))
		);
	}
	return [row];
}

export async function execute(interaction) {
	// ⚠️ defer 必須在任何 I/O 之前。
	//    先查資料庫再 defer 是 Discord bot 最常見的初學錯誤，症狀很陰險：
	//    低負載時一切正常，資料庫一慢就整批互動失效。
	await interaction.deferReply();

	const card1 = resolve_card(interaction.options.getString('card1'));
	const card2 = resolve_card(interaction.options.getString('card2'));

	if (!card1 || (interaction.options.getString('card2') && !card2)) {
		await interaction.editReply('沒有符合條件的卡片。');
		return;
	}
	const cards = card2 ? [card1, card2] : [card1];
	if (cards.some(c => !c.cid)) {
		await interaction.editReply('這張卡在官方資料庫裡沒有對應編號，查不到裁定。');
		return;
	}

	// 快取沒有或過期就抓一次。第 2 階段實作前 fetch_rulings 一律回 null，
	// 於是自然落到下面的降級模式。
	for (const card of cards) {
		const state = cache_state(card.cid);
		if (!state.fetched || !state.fresh)
			await fetch_rulings(card.cid);
	}

	const rulings = card2
		? get_common_rulings(card1.cid, card2.cid)
		: get_rulings(card1.cid);

	if (rulings.length) {
		const shown = rulings.slice(0, 3);
		const more = rulings.length - shown.length;
		const body = shown.map(format_ruling).join('\n\n');
		const tail = more > 0 ? `\n\n-# 另有 ${more} 條，請從按鈕開啟官方頁` : '';
		await interaction.editReply({
			content: `${body}${tail}\n-# 非官方裁定整理，內容取自 Konami 官方資料庫`,
			components: qa_buttons(cards),
		});
		return;
	}

	// ⚠️ 降級模式 —— 這不是錯誤處理，是一級功能。
	//
	//    它零內文重製，而且對老手仍然有用：他們要的往往就是「幫我翻到
	//    那一頁」。熔斷觸發時、或第 2 階段還沒做時，走的都是這條路。
	//
	// ⚠️ 而且「查無官方裁定」只有在真的查過的時候才說得出口。沒查過就
	//    說沒有，那是另一種形式的編造。
	const looked = cards.every(c => cache_state(c.cid).fetched);
	const msg = looked
		? (card2
			? '**查無同時提到這兩張卡的官方裁定。**\n這不代表可以自行推論結果 —— 請洽裁判或官方事務局。'
			: '**這張卡目前查無官方裁定。**')
		: '尚未取得裁定內容，可以直接開官方 Q&A 頁：';

	await interaction.editReply({
		content: `${msg}\n-# 本回覆非官方裁定`,
		components: qa_buttons(cards),
	});
}
