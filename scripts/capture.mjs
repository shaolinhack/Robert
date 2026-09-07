/**
 * capture.mjs — 把 Wix 網站完整抓下來，變成不依賴 Wix 的靜態網站。
 *
 * 用法（在有對外網路的機器上執行，例如你自己的電腦）：
 *   npm install
 *   npx playwright install chromium
 *   npm run capture
 *
 * 可用環境變數：
 *   START_URL   起始網址（預設 https://shaolinhack.wixsite.com/robert）
 *   OUT_DIR     輸出目錄（預設 public）
 *   MAX_PAGES   最多抓幾頁（預設 100）
 *   KEEP_SCRIPTS=1  保留原始 JS（除錯用，正式輸出不建議）
 *
 * 做法：用真實瀏覽器把每一頁「跑完」再存下渲染後的 DOM，
 * 同時攔截所有圖片 / 字型 / CSS 回應存到本機，最後把所有
 * 指向 wix 的網址改寫成本地相對路徑。
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const START_URL = process.env.START_URL || 'https://shaolinhack.wixsite.com/robert';
const OUT_DIR = path.resolve(process.env.OUT_DIR || 'public');
const MAX_PAGES = Number(process.env.MAX_PAGES || 100);
const KEEP_SCRIPTS = process.env.KEEP_SCRIPTS === '1';

const start = new URL(START_URL);
// 免費 wixsite 網址是 /<site>，站內頁面都在這個前綴底下
const BASE_PATH = start.pathname.replace(/\/+$/, '');

/** 原始資源網址 -> 本站絕對路徑（例如 /assets/static.wixstatic.com/media/xxx.jpg） */
const assetMap = new Map();
/** 已抓過或排隊中的頁面網址 */
const seen = new Set();
const queue = [];
const pages = [];
const skippedAssets = [];

const IMAGE_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);

function sanitizeSegment(seg) {
  return seg.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || '_';
}

/** 把任意資源網址轉成穩定、安全的本機路徑 */
function assetPathFor(rawUrl) {
  const u = new URL(rawUrl);
  const segments = u.pathname.split('/').filter(Boolean).map(sanitizeSegment);
  let file = segments.pop() || 'index';
  const dir = segments.join('/');

  // 帶 query 的資源（Wix 常用 ?w=&h=）加上短雜湊避免互相覆蓋
  if (u.search) {
    const hash = crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 8);
    const dot = file.lastIndexOf('.');
    file = dot > 0 ? `${file.slice(0, dot)}.${hash}${file.slice(dot)}` : `${file}.${hash}`;
  }
  if (!path.extname(file)) file += '.bin';

  return `/assets/${sanitizeSegment(u.host)}/${dir ? dir + '/' : ''}${file}`;
}

/** 頁面網址 -> 本機輸出檔（首頁 index.html，其他頁 <slug>/index.html 以支援乾淨網址） */
function pageTargetFor(rawUrl) {
  const u = new URL(rawUrl);
  let rel = u.pathname;
  if (BASE_PATH && rel.startsWith(BASE_PATH)) rel = rel.slice(BASE_PATH.length);
  rel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return { file: 'index.html', route: '/' };
  const slug = rel.split('/').map(sanitizeSegment).join('/');
  return { file: `${slug}/index.html`, route: `/${slug}/` };
}

/** 是否為需要抓取的站內頁面連結 */
function isInternalPage(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.host !== start.host) return false;
  if (BASE_PATH && !u.pathname.startsWith(BASE_PATH)) return false;
  if (/\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|docx?|xlsx?)$/i.test(u.pathname)) return false;
  return true;
}

function normalizePageUrl(rawUrl) {
  const u = new URL(rawUrl);
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

async function saveBuffer(localPath, buffer) {
  const abs = path.join(OUT_DIR, localPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buffer);
}

/** 慢慢捲到底，觸發 Wix 的 lazy-load 圖片 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight + window.innerHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 120);
    });
  });
  await page.waitForTimeout(1200);
}

async function capturePage(context, url) {
  const page = await context.newPage();

  page.on('response', async (response) => {
    const request = response.request();
    if (!IMAGE_TYPES.has(request.resourceType())) return;
    const rawUrl = response.url();
    if (!/^https?:/.test(rawUrl)) return;
    if (assetMap.has(rawUrl)) return;

    try {
      const body = await response.body();
      const localPath = assetPathFor(rawUrl);
      assetMap.set(rawUrl, localPath);
      await saveBuffer(localPath, body);
    } catch (err) {
      skippedAssets.push({ url: rawUrl, reason: err.message });
    }
  });

  console.log(`  → 開啟 ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await autoScroll(page);

  const html = await page.content();
  const title = await page.title();
  const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href));

  await page.close();
  return { html, title, links };
}

async function main() {
  if (existsSync(OUT_DIR)) {
    console.log(`清空舊的輸出目錄 ${OUT_DIR}`);
    await rm(OUT_DIR, { recursive: true, force: true });
  }
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    locale: 'zh-TW',
  });

  queue.push(normalizePageUrl(START_URL));
  seen.add(normalizePageUrl(START_URL));

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    console.log(`[${pages.length + 1}] ${url}`);
    try {
      const { html, title, links } = await capturePage(context, url);
      const target = pageTargetFor(url);
      pages.push({ url, ...target, title, html });

      for (const link of links) {
        if (!isInternalPage(link)) continue;
        const normalized = normalizePageUrl(link);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        queue.push(normalized);
      }
    } catch (err) {
      console.error(`  ✗ 抓取失敗：${err.message}`);
    }
  }

  await browser.close();

  // 頁面網址 -> 本站路由，用來改寫站內連結
  const routeMap = new Map(pages.map((p) => [p.url, p.route]));

  console.log(`\n改寫 ${pages.length} 個頁面的資源與連結…`);
  for (const p of pages) {
    const html = rewriteHtml(p.html, routeMap);
    const abs = path.join(OUT_DIR, p.file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, html, 'utf8');
    console.log(`  ✓ ${p.route}  →  ${p.file}  (${p.title})`);
  }

  // CSS 檔案裡的 url(...) 也要改寫
  await rewriteCssFiles();

  const report = {
    capturedAt: new Date().toISOString(),
    startUrl: START_URL,
    pages: pages.map(({ url, route, file, title }) => ({ url, route, file, title })),
    assetCount: assetMap.size,
    skippedAssets,
  };
  await writeFile('capture-report.json', JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n完成：${pages.length} 頁、${assetMap.size} 個資源 → ${OUT_DIR}`);
  console.log('接著執行 `npm run audit` 檢查是否還有殘留的 Wix 外部依賴。');
}

/** 把 HTML 內所有已下載的資源網址改成本地路徑，並移除 Wix 的執行期腳本 */
function rewriteHtml(html, routeMap) {
  let out = html;

  if (!KEEP_SCRIPTS) {
    // 移除所有 <script>，但保留 JSON-LD 結構化資料（SEO 用）
    out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs) =>
      /application\/ld\+json/i.test(attrs) ? match : ''
    );
    out = out.replace(/<script\b[^>]*\/>/gi, '');
    // 移除只為了載入 JS 的 preload / prefetch
    out = out.replace(/<link\b[^>]*rel=["'](?:preload|prefetch|modulepreload)["'][^>]*>/gi, '');
    // 移除 <noscript> 追蹤像素
    out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  }

  out = rewriteUrls(out, routeMap);
  out = out.replace(/<\/head>/i, `${CAPTURE_NOTE}\n</head>`);
  return out;
}

const CAPTURE_NOTE = '<!-- 由 scripts/capture.mjs 產生的靜態快照，部署於 Zeabur -->';

/** 共用的網址改寫：資源 + 站內連結，涵蓋原始與 HTML 轉義兩種寫法 */
function rewriteUrls(text, routeMap) {
  let out = text;

  for (const [rawUrl, localPath] of assetMap) {
    out = replaceAll(out, rawUrl, localPath);
    out = replaceAll(out, escapeHtmlEntities(rawUrl), localPath);
    out = replaceAll(out, rawUrl.replace(/^https?:/, ''), localPath); // protocol-relative
  }

  if (routeMap) {
    for (const [pageUrl, route] of routeMap) {
      const u = new URL(pageUrl);
      out = replaceAll(out, pageUrl, route);
      out = replaceAll(out, escapeHtmlEntities(pageUrl), route);
      out = replaceAll(out, `href="${u.pathname}"`, `href="${route}"`);
      out = replaceAll(out, `href="${u.pathname}/"`, `href="${route}"`);
    }
  }

  return out;
}

function replaceAll(haystack, needle, replacement) {
  if (!needle || !haystack.includes(needle)) return haystack;
  return haystack.split(needle).join(replacement);
}

function escapeHtmlEntities(url) {
  return url.replace(/&/g, '&amp;');
}

async function rewriteCssFiles() {
  const { readdir, readFile } = await import('node:fs/promises');
  const assetsRoot = path.join(OUT_DIR, 'assets');
  if (!existsSync(assetsRoot)) return;

  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.css')) {
        const css = await readFile(full, 'utf8');
        const rewritten = rewriteUrls(css, null);
        if (rewritten !== css) await writeFile(full, rewritten, 'utf8');
      }
    }
  };
  await walk(assetsRoot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
