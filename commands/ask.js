import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { answer_question } from '../ygo-answer.mjs';
import { get_section, section_url } from '../ygo-rules.mjs';
import { get_ruling } from '../ygo-ruling.mjs';
import { blocked_reason, record } from '../ygo-throttle.mjs';

export const module_url = import.meta.url;

// ⚠️ 開發期間只註冊到 GUILD_ID 那個測試伺服器。
export const experimental = true;

/**
 * 每人每日提問上限（架構決策第十二節）。
 *
 * ⚠️ 這不是防濫用的客套話 —— 一題要兩次 Gemini 呼叫，而免費層是每日
 *    1500 次。一個人手滑連問幾十題就能把大家的額度吃掉，而且症狀是
 *    「bot 壞了」不是「你問太多了」。
 */
const PER_USER_PER_DAY = 20;

export const data = new SlashCommandBuilder()
	.setName('ask')
	.setDescription('問規則或裁定問題（會引用出處，查不到就說查不到）')
	.addStringOption(o => o.setName('question')
		.setDescription('例如：大宇宙適用中可以從手牌發動増殖するG嗎？')
		.setRequired(true)
		.setMaxLength(300));
data.integration_types = [0, 1];
data.contexts = [0, 1, 2];

function clip(t, n) {
	if (!t)
		return '';
	return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function source_lines(r) {
	const out = [];
	for (const id of r.rule_ids) {
		const s = get_section(id);
		if (s)
			out.push(`・規則：${clip(s.path, 60)} <${section_url(s.file)}>`);
	}
	for (const fid of r.ruling_fids) {
		const g = get_ruling(fid);
		out.push(`・官方 Q&A ${fid}${g?.updated_at ? `（${g.updated_at}）` : ''} <https://www.db.yugioh-card.com/yugiohdb/faq_search.action?ope=5&fid=${fid}&request_locale=ja>`);
	}
	return out;
}

export async function execute(interaction) {
	// ⚠️ defer 一定在任何 I/O 之前。這條路要 20-35 秒，沒 defer 必死。
	await interaction.deferReply();

	const key = `user:${interaction.user.id}`;
	const over = blocked_reason(key, { per_minute: 3, per_day: PER_USER_PER_DAY });
	if (over) {
		await interaction.editReply(`你問得有點快（${over}）。稍後再試。`);
		return;
	}
	const question = interaction.options.getString('question').trim();
	record(key);

	const r = await answer_question(question);

	if (r.error && !r.answer) {
		await interaction.editReply(`目前無法查詢：${r.error}`);
		return;
	}

	const sources = source_lines(r);
	const head = r.refused ? '🔸 **查無足夠依據**' : '';
	// 把問題一起顯示。slash command 的參數在不同客戶端顯示方式不一，長問題
	// 還會被截斷 —— 而這種回答常常被截圖轉貼，沒有問題就看不懂在答什麼。
	const asked = `> ${clip(question, 260).split(String.fromCharCode(10)).join(' ')}`;
	const body = [
		asked,
		head,
		r.answer,
		sources.length ? `\n**出處**\n${sources.join('\n')}` : '',
		`-# 非官方裁定，僅供參考｜規則出自 OCG Rule，裁定出自 Konami 官方資料庫｜${r.model}`,
	].filter(Boolean).join('\n');

	const rows = [];
	if (!r.refused || sources.length) {
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setStyle(ButtonStyle.Link)
				.setLabel('回報這個回答有問題')
				.setURL('https://github.com/JohnHuang-0824/query-bot/issues/new'),
		);
		rows.push(row);
	}

	await interaction.editReply({ content: clip(body, 1950), components: rows });

	// ⚠️ 模型編造引用時留下痕跡。管線已經把它丟掉了，但這件事發生過本身
	//    就值得記一筆 —— 它是判斷 prompt 要不要再收緊的唯一訊號。
	if (r.dropped?.length)
		console.warn(`[ask] 模型編造引用 ${JSON.stringify(r.dropped)}｜問題：${question}`);
}
