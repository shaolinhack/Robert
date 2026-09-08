/**
 * make-offline.mjs — 從 public/ 產生可以直接雙擊開啟的離線版。
 *
 *   node scripts/make-offline.mjs [輸出目錄]
 *
 * 正式站的路徑都是絕對的（/assets/…、/blog），用 file:// 直接開會全部失效。
 * 這裡把它們改寫成相對於各頁面所在深度的路徑，並把乾淨網址補回實體檔名，
 * 這樣不需要任何伺服器也能瀏覽整站。
 */

import { readdir, readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'public');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'offline'));

async function listFiles(dir, base = dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, base, found);
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

/** 路由 -> 實體檔案，例如 /blog -> blog/index.html */
function fileForRoute(route, routes) {
  const clean = route.replace(/^\/+|\/+$/g, '');
  if (!clean) return 'index.html';
  if (routes.has(`/${clean}`)) return `${clean}/index.html`;
  return null;
}

function relativePrefix(pageFile) {
  const depth = pageFile.split('/').length - 1;
  return depth ? '../'.repeat(depth) : './';
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error('找不到 public/，請先執行 npm run build。');
    process.exit(1);
  }

  await rm(OUT, { recursive: true, force: true });
  await cp(SOURCE, OUT, { recursive: true });

  const files = await listFiles(OUT);
  const pages = files.filter((f) => f.endsWith('.html'));

  // 由實體檔案反推有哪些路由，才能把 href="/blog" 換成 blog/index.html
  const routes = new Set(
    pages.map((f) => (f === 'index.html' ? '/' : `/${f.replace(/\/index\.html$/, '').replace(/\.html$/, '')}`))
  );

  let rewritten = 0;
  for (const pageFile of pages) {
    const abs = path.join(OUT, ...pageFile.split('/'));
    const prefix = relativePrefix(pageFile);
    let html = await readFile(abs, 'utf8');

    // 1. 資源：/assets/... -> ../../assets/...
    html = html.split('"/assets/').join(`"${prefix}assets/`).split("'/assets/").join(`'${prefix}assets/`);

    // 2. 站內連結：乾淨網址補回實體檔名。長的先換，避免 /blog 咬掉 /blog/x。
    const sorted = [...routes].sort((a, b) => b.length - a.length);
    for (const route of sorted) {
      const target = fileForRoute(route, routes);
      if (!target) continue;
      const href = prefix + encodeURI(target);
      for (const form of new Set([route, encodeURI(route), `${route}/`])) {
        html = html.split(`href="${form}"`).join(`href="${href}"`);
        html = html.split(`href='${form}'`).join(`href='${href}'`);
      }
    }

    await writeFile(abs, html, 'utf8');
    rewritten++;
  }

  let bytes = 0;
  for (const f of await listFiles(OUT)) bytes += (await stat(path.join(OUT, ...f.split('/')))).size;

  console.log('── 離線版 ──────────────────────────────');
  console.log(`  ${rewritten} 個頁面，${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  輸出：${path.relative(ROOT, OUT)}/`);
  console.log('  用瀏覽器打開裡面的 index.html 即可，不需要伺服器。');
}

main().catch((err) => {
  console.error(`\n產生離線版失敗：${err.message}\n`);
  process.exit(1);
});
