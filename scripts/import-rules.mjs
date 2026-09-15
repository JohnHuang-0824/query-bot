/**
 * 把 OCG Rule 的規則語料匯入本地資料庫。
 *
 *   docker compose -f docker-compose.dev.yml exec -T bot node scripts/import-rules.mjs
 *
 * ⚠️ **手動執行，不要排程。** 規則文件更新得不頻繁（維護者每週加幾條
 *    FAQ 引用），沒必要自動抓。而且這支下載的是整包 tarball，跑一次
 *    就夠了。
 *
 * ⚠️ 一次請求抓整包，而不是 41 次抓個別檔案 —— 對別人的站永遠選請求
 *    數少的那條路。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse_rst, import_sections, corpus_state, build_toc } from '../ygo-rules.mjs';

const TARBALL = 'https://codeload.github.com/lucays/OCG-Rule-documentation/tar.gz/refs/heads/main';
const USER_AGENT = 'ygo-ruling-bot/0.1 (+https://github.com/JohnHuang-0824/query-bot)';

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory())
			walk(p, out);
		else if (name.endsWith('.rst'))
			out.push(p);
	}
	return out;
}

const work = mkdtempSync(join(tmpdir(), 'ocg-'));
try {
	console.log('下載語料…');
	const res = await fetch(TARBALL, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok)
		throw new Error(`HTTP ${res.status}`);
	const tar = join(work, 'ocg.tar.gz');
	writeFileSync(tar, Buffer.from(await res.arrayBuffer()));
	console.log(`  ${(statSync(tar).size / 1024 / 1024).toFixed(1)} MB`);

	execFileSync('tar', ['xzf', tar, '-C', work]);

	const root = readdirSync(work).find(n => n.startsWith('OCG-Rule-documentation'));
	const docs = join(work, root, 'docs');
	const files = walk(docs);
	console.log(`解析 ${files.length} 個 .rst…`);

	const sections = [];
	for (const f of files) {
		const rel = f.slice(docs.length + 1).replaceAll('\\', '/');
		sections.push(...parse_rst(readFileSync(f, 'utf8'), rel));
	}

	const state = import_sections(sections);
	console.log(`匯入完成：${state.sections} 節 / ${(state.chars / 1000).toFixed(0)} 千字`);
	console.log(`目錄大小：${build_toc().length} 字（這是每次問答第一段要送進模型的量）`);
}
finally {
	rmSync(work, { recursive: true, force: true });
}
