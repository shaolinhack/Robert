/**
 * build.mjs — 產生 public/（部署目標）。
 *
 *   snapshot/        階段一：Wix 靜態快照，尚未重寫的頁面由這裡提供
 *   content/         階段二：已重寫成乾淨結構的頁面，會覆蓋掉同路徑的快照
 *   src/styles.css   重寫版的設計系統
 *        ↓
 *   public/
 *
 * 這樣就能逐頁重寫：寫好一頁 content/pages/xxx.json，該頁就換成乾淨版，
 * 其餘頁面繼續用快照，網站隨時保持完整可用。
 *
 * 零相依，Docker 建置階段不需要 npm install。
 */

import { mkdir, readdir, readFile, writeFile, rm, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { renderPage, escapeHtml } from '../src/render.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshot');
const CONTENT_DIR = path.join(ROOT, 'content');
const PAGES_DIR = path.join(CONTENT_DIR, 'pages');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_DIR = path.join(ROOT, process.env.OUT_DIR || 'public');

const DEFAULT_SITE = {
  title: 'Robert',
  lang: 'zh-Hant',
  description: '',
  baseUrl: '',
  nav: [],
  social: [],
};

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${path.relative(ROOT, file)} 解析失敗：${err.message}`);
  }
}

async function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false;
  const entries = await readdir(dir);
  return entries.some((name) => name !== '.gitkeep');
}

/** 檔名 -> 路由：index.json -> /，about.json -> /about */
function routeFromFilename(filename) {
  const slug = path.basename(filename, '.json');
  return slug === 'index' ? '/' : `/${slug}`;
}

/** 路由 -> 輸出檔：/ -> index.html，/about -> about/index.html（乾淨網址） */
function fileFromRoute(route) {
  const slug = route.replace(/^\/+|\/+$/g, '');
  return slug ? path.join(slug, 'index.html') : 'index.html';
}

async function write(relPath, content) {
  const abs = path.join(OUT_DIR, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function loadPages() {
  if (!existsSync(PAGES_DIR)) return [];

  const files = (await readdir(PAGES_DIR))
    .filter((name) => name.endsWith('.json') && !name.startsWith('_')) // _ 開頭是範例／草稿
    .sort();

  const pages = [];
  for (const name of files) {
    const data = await readJson(path.join(PAGES_DIR, name));
    if (!data) continue;
    const route = data.route ?? routeFromFilename(name);
    pages.push({ ...data, route, source: name });
  }
  return pages;
}

function render404(site) {
  return renderPage({
    site,
    page: {
      route: '/404',
      title: '找不到頁面',
      description: '',
      blocks: [
        {
          type: 'prose',
          align: 'center',
          title: '404 — 找不到這個頁面',
          body: ['網址可能輸入錯誤，或這個頁面已經移除。'],
          actions: [{ label: '回到首頁', href: '/' }],
        },
      ],
    },
  });
}

function renderPlaceholder(site) {
  return renderPage({
    site,
    page: {
      route: '/',
      title: site.title,
      blocks: [
        {
          type: 'prose',
          align: 'center',
          eyebrow: 'Zeabur · 部署成功',
          title: '容器已上線，網站內容尚未匯入',
          body: [
            '這是佔位頁面。Caddy 已正常服務 `public/`，代表部署管線本身沒有問題。',
            '接下來執行 `npm run capture` 抓取 Wix 網站到 `snapshot/`，再執行 `npm run build`。',
            '詳細步驟見專案根目錄的 `README.md`。',
          ],
        },
      ],
    },
  });
}

/**
 * 掃描實際產出的 HTML 得到全站路由 —— 快照頁與重寫頁都要進 sitemap，
 * 遷移期間讓搜尋引擎能重新索引整站。
 */
async function collectRoutes() {
  const entries = await readdir(OUT_DIR, { recursive: true });
  const routes = new Set();

  for (const entry of entries) {
    if (!entry.endsWith('.html')) continue;
    const rel = entry.split(path.sep).join('/');
    if (rel === '404.html') continue;

    if (rel === 'index.html') routes.add('/');
    else if (rel.endsWith('/index.html')) routes.add(`/${rel.slice(0, -'/index.html'.length)}`);
    else routes.add(`/${rel.slice(0, -'.html'.length)}`);
  }

  return [...routes].sort();
}

function renderSitemap(site, routes) {
  if (!site.baseUrl) return null;
  const today = new Date().toISOString().slice(0, 10);
  const urls = routes
    .map(
      (route) => `  <url>
    <loc>${escapeHtml(new URL(route, site.baseUrl).toString())}</loc>
    <lastmod>${today}</lastmod>
  </url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const site = { ...DEFAULT_SITE, ...((await readJson(path.join(CONTENT_DIR, 'site.json'))) ?? {}) };

  // 1. 快照打底
  const hasSnapshot = await isNonEmptyDir(SNAPSHOT_DIR);
  let snapshotPages = 0;
  if (hasSnapshot) {
    await cp(SNAPSHOT_DIR, OUT_DIR, { recursive: true, filter: (src) => !src.endsWith('.gitkeep') });
    snapshotPages = (await readdir(OUT_DIR, { recursive: true })).filter((f) => f.endsWith('.html')).length;
  }

  // 2. 重寫版覆蓋
  const pages = await loadPages();
  for (const page of pages) {
    await write(fileFromRoute(page.route), renderPage({ site, page }));
  }

  // 3. 設計系統與自備素材
  await mkdir(path.join(OUT_DIR, 'assets'), { recursive: true });
  await cp(path.join(SRC_DIR, 'styles.css'), path.join(OUT_DIR, 'assets', 'styles.css'));

  const contentAssets = path.join(CONTENT_DIR, 'assets');
  if (await isNonEmptyDir(contentAssets)) {
    await cp(contentAssets, path.join(OUT_DIR, 'assets'), { recursive: true });
  }

  // 4. 兜底：完全沒內容時給佔位頁
  const indexPath = path.join(OUT_DIR, 'index.html');
  if (!existsSync(indexPath)) {
    await write('index.html', renderPlaceholder(site));
  }

  // 5. 404、sitemap、robots
  if (!existsSync(path.join(OUT_DIR, '404.html'))) {
    await write('404.html', render404(site));
  }

  const routes = await collectRoutes();
  const sitemap = renderSitemap(site, routes);
  if (sitemap) {
    await write('sitemap.xml', sitemap);
    await write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${new URL('/sitemap.xml', site.baseUrl)}\n`);
  } else {
    await write('robots.txt', 'User-agent: *\nAllow: /\n');
  }

  // 報告
  const allFiles = await readdir(OUT_DIR, { recursive: true });
  let bytes = 0;
  for (const f of allFiles) {
    const info = await stat(path.join(OUT_DIR, f));
    if (info.isFile()) bytes += info.size;
  }

  console.log('── 建置完成 ──────────────────────────────');
  console.log(`快照頁面：  ${hasSnapshot ? snapshotPages : 0}${hasSnapshot ? '' : '（尚未執行 npm run capture）'}`);
  console.log(`重寫頁面：  ${pages.length}${pages.length ? ` → ${pages.map((p) => p.route).join(', ')}` : ''}`);
  console.log(`輸出大小：  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`輸出目錄：  ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`\n建置失敗：${err.message}\n`);
  process.exit(1);
});
