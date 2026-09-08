/**
 * make-preview.mjs — 把整個網站打包成單一 HTML，可發佈成線上預覽。
 *
 *   node scripts/make-preview.mjs [輸出檔]
 *
 * Artifact 只能是一個 HTML 檔，所以圖片得內嵌成 data URI。但 13 個頁面共用
 * 同一批圖，逐頁內嵌會讓同一張圖重複十幾份、體積爆掉。所以資源只存一份，
 * 頁面仍保留 /assets/site/… 的寫法，切換頁面時才在瀏覽器端替換。
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'public');
const ASSET_DIR = path.join(SOURCE, 'assets', 'site');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'preview', 'site-preview.html'));

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4',
};

async function listFiles(dir, base = dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, base, found);
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

function routeForFile(file) {
  if (file === 'index.html') return '/';
  return `/${file.replace(/\/index\.html$/, '').replace(/\.html$/, '')}`;
}

/** 頁面標題取自 <title>，去掉站名後綴讓分頁列好讀 */
function labelFor(html, route) {
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? route;
  return title.split('|')[0].trim() || route;
}

/**
 * 嵌進 <script> 的 JSON 不能含有能提早結束標籤的字串（</script>、<!--）。
 * 一律把 < 轉成 \u003C —— 這是合法的 JSON 轉義，解析回來仍是 <。
 * （曾經用 \! 規避 <!--，但 JSON 沒有這個轉義，會解析失敗。）
 */
function embedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003C');
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error('找不到 public/，請先執行 npm run build。');
    process.exit(1);
  }

  // 資源 -> data URI，只存一份
  const assets = {};
  let assetBytes = 0;
  for (const rel of await listFiles(ASSET_DIR)) {
    const buf = await readFile(path.join(ASSET_DIR, ...rel.split('/')));
    const mime = MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
    assets[rel] = `data:${mime};base64,${buf.toString('base64')}`;
    assetBytes += buf.length;
  }

  // 頁面，依網址深度排序讓首頁排前面
  const pages = [];
  const pageFiles = (await listFiles(SOURCE)).filter(
    (f) => f.endsWith('.html') && f !== '404.html' && !f.startsWith('assets/')
  );
  for (const file of pageFiles) {
    const html = await readFile(path.join(SOURCE, ...file.split('/')), 'utf8');
    const route = routeForFile(file);
    pages.push({ route, label: labelFor(html, route), html });
  }
  pages.sort((a, b) => a.route.split('/').length - b.route.split('/').length || a.route.localeCompare(b.route));

  const shell = renderShell(pages, assets);
  await writeFile(OUT, shell, 'utf8');

  const size = (await stat(OUT)).size;
  console.log('── 線上預覽 ──────────────────────────────');
  console.log(`  ${pages.length} 頁，${Object.keys(assets).length} 個資源（原始 ${(assetBytes / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`  輸出：${path.relative(ROOT, OUT)}  ${(size / 1024 / 1024).toFixed(1)} MB / 上限 16 MB`);
  if (size > 15 * 1024 * 1024) console.log('  ⚠ 已逼近上限');
}

function renderShell(pages, assets) {
  return `<title>蘿蔔先生網站預覽</title>
<style>
  :root {
    --bg: #eceef2;
    --chrome: #ffffff;
    --fg: #191d24;
    --muted: #6b7482;
    --line: #d7dbe2;
    --accent: #cf4436;
    --accent-soft: #fdecea;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e1116;
      --chrome: #171b22;
      --fg: #e7eaf0;
      --muted: #939cab;
      --line: #272d37;
      --accent: #f4705f;
      --accent-soft: #35201d;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0e1116;
    --chrome: #171b22;
    --fg: #e7eaf0;
    --muted: #939cab;
    --line: #272d37;
    --accent: #f4705f;
    --accent-soft: #35201d;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif;
  }

  header {
    background: var(--chrome); border-bottom: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 0; flex: none;
  }
  .bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px 0; }
  .brand { font-weight: 650; letter-spacing: -0.01em; }
  .note { color: var(--muted); font-size: 12.5px; }
  .note strong { color: var(--fg); font-weight: 600; }

  nav { display: flex; gap: 2px; padding: 8px 16px 0; overflow-x: auto; scrollbar-width: thin; }
  nav button {
    flex: none; appearance: none; cursor: pointer;
    border: 1px solid transparent; border-bottom: none;
    border-radius: 7px 7px 0 0; padding: 7px 13px;
    background: transparent; color: var(--muted);
    font: inherit; font-size: 13px; white-space: nowrap;
    transition: color .12s, background-color .12s;
  }
  nav button:hover { color: var(--fg); background: var(--accent-soft); }
  nav button[aria-current="true"] {
    color: var(--accent); background: var(--bg);
    border-color: var(--line); font-weight: 600;
    margin-bottom: -1px; padding-bottom: 8px;
  }
  nav button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .route { padding: 0 16px 9px; color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  main { flex: 1; min-height: 0; padding: 12px 16px 16px; }
  iframe {
    width: 100%; height: 100%; border: 1px solid var(--line);
    border-radius: 10px; background: #fff; display: block;
  }
</style>

<header>
  <div class="bar">
    <span class="brand">蘿蔔先生網站</span>
    <span class="note">從 Wix 遷移的靜態快照 · <strong id="count"></strong></span>
  </div>
  <nav id="tabs" aria-label="頁面"></nav>
  <div class="route" id="route"></div>
</header>

<main><iframe id="view" title="網站預覽"></iframe></main>

<script type="application/json" id="pages">${embedJson(pages)}</script>
<script type="application/json" id="assets">${embedJson(assets)}</script>
<script>
  const pages = JSON.parse(document.getElementById('pages').textContent);
  const assets = JSON.parse(document.getElementById('assets').textContent);
  const tabs = document.getElementById('tabs');
  const view = document.getElementById('view');
  const routeLabel = document.getElementById('route');
  document.getElementById('count').textContent = pages.length + ' 個頁面';

  // 頁面裡的資源路徑在載入當下才換成 data URI，資源本身只存一份。
  // 用已知檔名逐一比對，而不是用正則猜網址結尾 —— 檔名可能含空白與括號
  // （例如「R 蘿蔔先生 (黑底白字)透明.png」），猜邊界一定會切錯。
  const replacements = [];
  for (const [name, uri] of Object.entries(assets)) {
    for (const form of new Set([name, encodeURI(name), encodeURIComponent(name)])) {
      replacements.push(['/assets/site/' + form, uri]);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);

  function inlineAssets(html) {
    let out = html;
    for (const [needle, uri] of replacements) {
      if (out.includes(needle)) out = out.split(needle).join(uri);
    }
    return out;
  }

  function show(route) {
    const page = pages.find(p => p.route === route) ?? pages[0];
    routeLabel.textContent = page.route;
    for (const button of tabs.children) {
      button.setAttribute('aria-current', String(button.dataset.route === page.route));
    }
    view.srcdoc = inlineAssets(page.html);
  }

  // 站內連結攔下來換頁，站外的另開分頁
  view.addEventListener('load', () => {
    const doc = view.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', event => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (pages.some(p => p.route === href)) {
        event.preventDefault();
        show(href);
      } else if (/^https?:/.test(href)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      } else {
        event.preventDefault();
      }
    });
  });

  for (const page of pages) {
    const button = document.createElement('button');
    button.textContent = page.label;
    button.dataset.route = page.route;
    button.addEventListener('click', () => show(page.route));
    tabs.appendChild(button);
  }
  show('/');
</script>
`;
}

main().catch((err) => {
  console.error(`\n產生預覽失敗：${err.message}\n`);
  process.exit(1);
});
