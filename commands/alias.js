import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
	suggest, resolve_id, display_name,
	propose_alias, list_proposals, approve_proposal, reject_proposal,
} from '../ygo-alias.mjs';

export const module_url = import.meta.url;

// ⚠️ 跟 /ruling 一樣，開發期間只註冊到 GUILD_ID 那個測試伺服器。
export const experimental = true;

/**
 * 卡名俗稱的提案與審核。
 *
 * 這是別名表**唯一的成長來源**（架構決策第一節、第十節）。官方資料源
 * 不會有「増G」這種說法，只能靠使用者回報。
 *
 * ⚠️ 原本設計是「答錯回報按鈕」，但 bot.js 把所有按鈕互動都丟給
 *    seventh_handler，沒有依 customId 分派的擴充點 —— 要加自己的按鈕
 *    就得改 bot.js，違反 fork 規矩 2。所以改成 slash command。
 *
 * ⚠️ 但原本的用意保留了：**卡片用 autocomplete 選，不打字**。審核也是
 *    從 autocomplete 挑待審項目。把門檻壓到最低，否則老手懶得回報。
 */
export const data = new SlashCommandBuilder()
	.setName('alias')
	.setDescription('卡名俗稱：提案與審核')
	.addSubcommand(sub => sub.setName('add')
		.setDescription('提案一個俗稱（例如「増G」→ 增殖的G）')
		.addStringOption(o => o.setName('nickname')
			.setDescription('俗稱，例如 増G')
			.setRequired(true).setMaxLength(40))
		.addStringOption(o => o.setName('card')
			.setDescription('要對應到哪張卡')
			.setRequired(true).setMaxLength(50).setAutocomplete(true))
	)
	.addSubcommand(sub => sub.setName('pending')
		.setDescription('列出待審提案（管理者）')
	)
	.addSubcommand(sub => sub.setName('review')
		.setDescription('核准或退回一筆提案（管理者）')
		.addStringOption(o => o.setName('proposal')
			.setDescription('待審提案')
			.setRequired(true).setAutocomplete(true))
		.addStringOption(o => o.setName('action')
			.setDescription('怎麼處理')
			.setRequired(true)
			.addChoices(
				{ name: '核准', value: 'approve' },
				{ name: '退回', value: 'reject' },
			))
	);
data.integration_types = [0, 1];
data.contexts = [0, 1, 2];

function is_admin(interaction) {
	return interaction.user.id === process.env.ADMIN;
}

export async function autocomplete(interaction) {
	const focused = interaction.options.getFocused(true);

	if (focused.name === 'card') {
		await interaction.respond(suggest(focused.value));
		return;
	}
	if (focused.name === 'proposal') {
		if (!is_admin(interaction)) {
			await interaction.respond([]);
			return;
		}
		// 待審清單直接當候選 —— 管理者不必記 id，也不必重打俗稱。
		const q = focused.value.trim().toLowerCase();
		const rows = list_proposals(25)
			.filter(r => !q || r.raw.toLowerCase().includes(q))
			.map(r => ({
				name: `${r.raw} → ${display_name(r.card_id)}`.slice(0, 100),
				value: String(r.rowid),
			}));
		await interaction.respond(rows);
		return;
	}
	await interaction.respond([]);
}

export async function execute(interaction) {
	const sub = interaction.options.getSubcommand();

	if (sub === 'add') {
		const nickname = interaction.options.getString('nickname').trim();
		const card_id = resolve_id(interaction.options.getString('card'));
		if (card_id === null) {
			await interaction.reply({ content: '卡片認不出來，請從候選清單裡選。', flags: MessageFlags.Ephemeral });
			return;
		}
		const name = display_name(card_id);
		const result = propose_alias(nickname, card_id, interaction.user.id);

		const msg = {
			ok: `已收到提案：**${nickname}** → **${name}**\n-# 審核通過後才會生效`,
			exists: `**${nickname}** → **${name}** 已經有人提過了，等審核中。`,
			approved: `**${nickname}** → **${name}** 已經生效了，不用再提。`,
			quota: '今天的提案數量到上限了，明天請早。',
			invalid: '俗稱是空的，或卡片認不出來。',
		}[result];
		// 提案是給維護者看的，不必洗版 —— 用 ephemeral 只回給提案的人。
		await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
		return;
	}

	if (!is_admin(interaction)) {
		await interaction.reply({ content: '這個子指令限管理者使用。', flags: MessageFlags.Ephemeral });
		return;
	}

	if (sub === 'pending') {
		const rows = list_proposals(15);
		const body = rows.length
			? rows.map(r => `・**${r.raw}** → ${display_name(r.card_id)}　-# <@${r.proposed_by}>`).join('\n')
			: '目前沒有待審提案。';
		await interaction.reply({ content: body.slice(0, 1950), flags: MessageFlags.Ephemeral });
		return;
	}

	if (sub === 'review') {
		const rowid = Number(interaction.options.getString('proposal'));
		const action = interaction.options.getString('action');
		if (!Number.isInteger(rowid)) {
			await interaction.reply({ content: '請從候選清單裡選一筆待審提案。', flags: MessageFlags.Ephemeral });
			return;
		}
		const row = action === 'approve' ? approve_proposal(rowid) : reject_proposal(rowid);
		if (!row) {
			await interaction.reply({ content: '找不到這筆提案，可能已經處理過了。', flags: MessageFlags.Ephemeral });
			return;
		}
		const verb = action === 'approve' ? '已核准並生效' : '已退回';
		await interaction.reply({
			content: `${verb}：**${row.raw}** → **${display_name(row.card_id)}**`,
			flags: MessageFlags.Ephemeral,
		});
	}
}
