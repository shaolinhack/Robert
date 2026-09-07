/**
 * audit.mjs — 檢查 public/ 內是否還有指向 Wix 或第三方追蹤服務的殘留依賴。
 * 這是「真的脫離 Wix 了嗎」的驗收工具。
 *
 * 用法：npm run audit
 * 有殘留時以 exit code 1 結束，方便接進 CI。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.OUT_DIR || 'public');

const PATTERNS = [
  { name: 'Wix 靜態資源 CDN', re: /static\.wixstatic\.com/gi },
  { name: 'Wix 程式碼 CDN', re: /static\.parastorage\.com/gi },
  { name: 'Wix 網站網域', re: /\b[\w-]+\.wixsite\.com/gi },
  { name: 'Wix 應用服務', re: /\bwixapps\.net|\bwix\.com\b/gi },
  { name: 'Google Analytics', re: /google-analytics\.com|googletagmanager\.com/gi },
  { name: 'Sentry 錯誤回報', re: /sentry\.io|sentry-cdn/gi },
  { name: 'Facebook 追蹤像素', re: /connect\.facebook\.net/gi },
];

const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.webmanifest']);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  if (!existsSync(ROOT)) {
    console.error(`找不到 ${ROOT}。請先執行 \`npm run capture\`。`);
    process.exit(1);
  }

  const files = await walk(ROOT);
  const textFiles = files.filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()));

  let totalBytes = 0;
  for (const f of files) totalBytes += (await stat(f)).size;

  const findings = new Map(); // 樣式名稱 -> Map<檔案, 次數>

  for (const file of textFiles) {
    const content = await readFile(file, 'utf8');
    for (const { name, re } of PATTERNS) {
      const matches = content.match(new RegExp(re.source, re.flags));
      if (!matches?.length) continue;
      if (!findings.has(name)) findings.set(name, new Map());
      findings.get(name).set(path.relative(ROOT, file), matches.length);
    }
  }

  const pageCount = files.filter((f) => f.endsWith('.html')).length;
  console.log('── 網站盤點 ──────────────────────────────');
  console.log(`目錄：      ${ROOT}`);
  console.log(`HTML 頁面： ${pageCount}`);
  console.log(`檔案總數：  ${files.length}`);
  console.log(`總大小：    ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('');

  if (findings.size === 0) {
    console.log('✓ 沒有偵測到任何 Wix 或第三方追蹤依賴，可以安全部署到 Zeabur。');
    return;
  }

  console.log('⚠ 仍有外部依賴殘留：\n');
  for (const [name, fileCounts] of findings) {
    const total = [...fileCounts.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${name} — 共 ${total} 處，分布於 ${fileCounts.size} 個檔案`);
    for (const [file, count] of [...fileCounts].slice(0, 8)) {
      console.log(`     ${file} (${count})`);
    }
    if (fileCounts.size > 8) console.log(`     …另有 ${fileCounts.size - 8} 個檔案`);
    console.log('');
  }
  console.log('這些網址仍會在使用者瀏覽時連回 Wix，需要一併下載或移除後再部署。');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
