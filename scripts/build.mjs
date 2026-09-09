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
import { createHash } from 'node:crypto';
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

/**
 * 把區塊裡的 source 換成 content/ 底下的實際資料。
 * 時間軸這種會一直長的內容獨立成資料檔，頁面只要指名要哪一份就好。
 */
function resolveData(page, { milestones, posts, podcast, books }) {
  // 文章頁在 content 裡是「一篇文章」的形狀（標題、日期、內文節點），
  // 而不是區塊陣列 —— 寫文章的人不該去組版面。這裡把它展開成區塊。
  if (page.layout === 'post') {
    page = {
      ...page,
      blocks: [
        {
          type: 'post-header',
          title: page.title,
          published: page.published,
          updated: page.updated,
          readTime: page.readTime,
          cover: page.cover,
        },
        { type: 'article', nodes: page.body },
      ],
    };
  }

  const blocks = (page.blocks ?? []).map((block) => {
    // 文章列表由 posts-index.json 產生，新增文章時列表自動跟著更新
    if (block.type === 'cards' && block.source === 'posts') {
      // 半年內發布的自動標「最新」。用日期判斷而不是固定標第一篇，
      // 站放久了才不會把三年前的文章一直掛著「最新」。
      const FRESH_DAYS = 180;
      const now = Date.now();
      const items = [...posts]
        .sort((a, b) => String(b.published).localeCompare(String(a.published)))
        .map((post) => {
          const at = Date.parse(post.published ?? '');
          const fresh = Number.isFinite(at) && (now - at) / 86400000 <= FRESH_DAYS;
          return {
            title: post.title,
            body: post.description,
            href: `/post/${post.slug}`,
            image: post.cover ? { src: post.cover.src ?? post.cover, alt: post.title } : undefined,
            meta: [post.published?.slice(0, 10).replace(/-/g, '.'), post.readTime].filter(Boolean).join('　·　'),
            // until 交給前端再校正一次；沒有 badgeDone，過期就整顆消失
            ...(Number.isFinite(at)
              ? { until: new Date(at + FRESH_DAYS * 86400000).toISOString() }
              : {}),
            ...(fresh ? { badge: '最新' } : {}),
          };
        });
      return { ...block, items };
    }

    // 書單由 books.json 產生（跑 scripts/extract-books.mjs 重新整理）
    if (block.type === 'books' && !block.items) {
      return { ...block, items: books.books ?? [] };
    }

    // 單集清單由 podcast-index.json 產生（跑 scripts/import-podcast.mjs 更新）
    if (block.type === 'cards' && block.source === 'podcast') {
      const items = (podcast.episodes ?? []).map((ep) => ({
        title: ep.title,
        body: ep.summary ?? '',
        href: `/podcast/${ep.slug}`,
        image: ep.image ? { src: ep.image, alt: ep.title } : undefined,
        meta: [ep.published?.slice(0, 10).replace(/-/g, '.'), ep.duration].filter(Boolean).join('　·　'),
      }));
      return { ...block, items };
    }

    if (block.type !== 'timeline' || !block.source) return block;
    const items = milestones[block.source];
    if (!items) {
      throw new Error(`頁面 ${page.route} 的時間軸找不到資料「${block.source}」，` +
        `content/milestones.json 裡有：${Object.keys(milestones).filter((k) => !k.startsWith('_')).join('、')}`);
    }
    return { ...block, items };
  });
  return { ...page, blocks };
}

/**
 * 每一集各自一頁。內容（標題、簡介、時間軸、書單）放在自己的網域上，
 * 音檔與收聽平台則連出去——文字留給搜尋引擎，訂閱留給 Apple。
 * 頁面直接從 podcast-index.json 生成，重新匯入後新集數會自動出現。
 */
function episodePages(podcast) {
  const show = podcast.show ?? '讀癮';
  return (podcast.episodes ?? []).map((ep) => {
    const listen = [
      ep.appleUrl && { label: '在 Apple Podcasts 收聽', href: ep.appleUrl, variant: 'primary' },
      ep.link && { label: '在 Firstory 收聽', href: ep.link, variant: 'secondary' },
    ].filter(Boolean);

    return {
      route: `/podcast/${ep.slug}`,
      title: ep.title,
      description: (ep.summary || ep.description || '').replace(/\s+/g, ' ').slice(0, 160),
      episode: {
        show,
        published: ep.published,
        number: ep.episode,
        image: ep.image,
        audio: ep.audio,
      },
      blocks: [
        {
          type: 'post-header',
          title: ep.title,
          published: ep.published,
          readTime: ep.duration,
          cover: ep.image ? { src: ep.image, alt: ep.title } : null,
          coverSize: 'small',
          backHref: '/podcast',
          backLabel: '回 Podcast',
        },
        {
          type: 'audio',
          src: ep.audio,
          note: '音檔由 Firstory 提供。想訂閱、收藏或在手機上聽，用下面的連結。',
          actions: listen,
        },
        ...(ep.notes
          ? [{ type: 'prose', title: '本集內容', body: ep.notes.split(/\n{2,}/) }]
          : []),
      ],
    };
  });
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
    // assets/ 底下的 HTML 是小工具的殘留，不是頁面 —— 放進 sitemap 會被搜尋引擎收錄
    if (rel.startsWith('assets/')) continue;

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

  // 樣式表檔名帶內容雜湊。/assets/* 是以 immutable 快取一年的，若檔名固定，
  // 瀏覽器整年都不會回來問，改了樣式使用者也看不到（要手動清快取）。
  // 內容一變檔名就變，等於換一個新網址，瀏覽器自然會抓新的。
  const cssSource = await readFile(path.join(SRC_DIR, 'styles.css'));
  const cssHash = createHash('sha256').update(cssSource).digest('hex').slice(0, 8);
  site.stylesheet = `/assets/styles.${cssHash}.css`;
  const milestones = (await readJson(path.join(CONTENT_DIR, 'milestones.json'))) ?? {};
  const posts = (await readJson(path.join(CONTENT_DIR, 'posts-index.json'))) ?? [];
  const podcast = (await readJson(path.join(CONTENT_DIR, 'podcast-index.json'))) ?? { episodes: [] };
  const books = (await readJson(path.join(CONTENT_DIR, 'books.json'))) ?? { books: [] };

  // 1. 快照打底
  const hasSnapshot = await isNonEmptyDir(SNAPSHOT_DIR);
  let snapshotPages = 0;
  if (hasSnapshot) {
    await cp(SNAPSHOT_DIR, OUT_DIR, { recursive: true, filter: (src) => !src.endsWith('.gitkeep') });
    snapshotPages = (await readdir(OUT_DIR, { recursive: true })).filter((f) => f.endsWith('.html')).length;
  }

  // 2. 重寫版覆蓋（含由 podcast-index.json 自動產生的單集頁）
  const pages = [...(await loadPages()), ...episodePages(podcast)];
  for (const page of pages) {
    await write(fileFromRoute(page.route), renderPage({ site, page: resolveData(page, { milestones, posts, podcast, books }) }));
  }

  // 3. 設計系統與自備素材
  await mkdir(path.join(OUT_DIR, 'assets'), { recursive: true });
  await writeFile(path.join(OUT_DIR, 'assets', `styles.${cssHash}.css`), cssSource);

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
