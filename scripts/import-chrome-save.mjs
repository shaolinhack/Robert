/**
 * import-chrome-save.mjs — 把 Chrome「網頁，完整」存檔轉成專案的 snapshot/ 格式。
 *
 *   node scripts/import-chrome-save.mjs [來源目錄]
 *
 * inbox/ 底下可以有任意層資料夾（解壓 ZIP 常會多包一層），會遞迴尋找所有 HTML；
 * 資源資料夾以「與該 HTML 同一層的同名資料夾」為準。
 *
 * 路由對應放 inbox/routes.json，鍵可用檔名或相對路徑：
 *   { "首頁.html": "/", "文章.html": "/post/文章" }
 * 建議照原網站的網址設定，既有連結與搜尋引擎索引才不會失效。
 *
 * 所有頁面的資源會合併到 /assets/site/ 並依內容去重 —— Wix 每頁存檔都會帶一整
 * 份相同的字型與樣式，不去重的話同樣的檔案會重複十幾份。
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const INBOX = path.resolve(process.argv[2] || path.join(ROOT, 'inbox'));
const SNAPSHOT = path.join(ROOT, 'snapshot');
const ASSET_ROOT = path.join(SNAPSHOT, 'assets', 'site');
const ASSET_PREFIX = '/assets/site';

const HTML_EXT = /\.x?html?$/i;

/** Chrome 在不同語系用不同的資料夾後綴 */
const KNOWN_SUFFIXES = ['_files', '_檔案', '_文件', '_fichiers', '_Dateien', '_archivos', '_file'];

/**
 * 要排除的腳本檔。所有 <script> 都會被移除，這些檔案不會被載入，
 * 而 Wix 的 bundle 動輒數十 MB。Chrome 會在下載的 JS 後面加語系後綴
 * （中文是 `.下載`），所以副檔名後面再容許一段。
 */
const JS_LIKE = /\.m?js(\.[^.]+)?$/i;

/** HTML 裡引用資源資料夾的樣子，用來判斷「該有資料夾卻找不到」 */
const ASSET_DIR_REF = /["'(](?:\.\/)?([^"'()/]+?(?:_files|_檔案|_文件|_fichiers|_Dateien|_archivos))\//g;

function slugify(name) {
  return name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function routeFromName(basename) {
  if (/^(index|home|首頁|首页)$/i.test(basename)) return '/';
  const slug = slugify(basename);
  return slug ? `/${slug}` : null;
}

function fileFromRoute(route) {
  const slug = route.replace(/^\/+|\/+$/g, '');
  return slug ? path.join(...slug.split('/'), 'index.html') : 'index.html';
}

/** 遞迴找出所有頁面 HTML，但不進入資源資料夾（那裡面的 HTML 是小工具，不是頁面） */
async function findHtmlFiles(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (KNOWN_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      await findHtmlFiles(full, found);
    } else if (HTML_EXT.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** 找出與 HTML 同一層、同名的資源資料夾 */
async function findAssetDir(htmlPath) {
  const dir = path.dirname(htmlPath);
  const basename = path.basename(htmlPath).replace(HTML_EXT, '');
  const dirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);

  for (const suffix of KNOWN_SUFFIXES) {
    if (dirs.includes(`${basename}${suffix}`)) return `${basename}${suffix}`;
  }
  return dirs.find((name) => name !== basename && name.startsWith(basename)) ?? null;
}

/** 列出資料夾內所有檔案，回傳相對於該資料夾的路徑 */
async function listFiles(dir, base = dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, base, found);
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

/** 移除 Wix 的執行期腳本與追蹤碼，保留 JSON-LD */
function stripScripts(html) {
  return html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs) =>
      /application\/ld\+json/i.test(attrs) ? m : ''
    )
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<link\b[^>]*rel=["'](?:preload|prefetch|modulepreload)["'][^>]*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

/** 依序套用替換 */
function applyReplacements(text, replacements) {
  let out = text;
  for (const [needle, value] of replacements) {
    if (needle && out.includes(needle)) out = out.split(needle).join(value);
  }
  return out;
}

/** 長的優先，避免 `./X_files/` 被 `X_files/` 咬掉一半 */
function sortedByLength(pairs) {
  return [...pairs].sort((a, b) => b[0].length - a[0].length);
}

/** 從 HTML 取出原始網址（canonical 優先，其次 og:url） */
function extractOriginalUrl(html) {
  const canonical = html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  const fromCanonical = canonical?.match(/href=["']([^"']+)["']/i)?.[1];
  if (fromCanonical) return fromCanonical;
  const og = html.match(/<meta[^>]*property=["']og:url["'][^>]*>/i)?.[0];
  return og?.match(/content=["']([^"']+)["']/i)?.[1] ?? null;
}

/**
 * 把指向原站的絕對網址換成本站路由。只替換帶引號的完整屬性值 ——
 * 首頁網址是其他頁網址的前綴，直接做子字串替換會把長網址咬掉一段。
 */
function pageUrlReplacements(originalUrl, route) {
  const forms = new Set([originalUrl, originalUrl.replace(/\/$/, '')]);
  try {
    forms.add(decodeURI(originalUrl));
  } catch {}

  const pairs = [];
  for (const form of forms) {
    for (const url of [form, `${form}/`]) {
      pairs.push([`"${url}"`, `"${route}"`], [`'${url}'`, `'${route}'`]);
    }
  }
  return pairs;
}

/**
 * 個別檔案的路徑覆寫。必須連 `./` 前綴的寫法一起產生：覆寫的字串比資料夾前綴長，
 * 會先被套用，若只處理無前綴的形式，`./X_files/a.png` 會只被換掉後半段而留下
 * `.//assets/...`。
 */
function pushOverride(item, rel, publicPath) {
  item.overrides.push([`./${item.assetDirName}/${rel}`, publicPath], [`${item.assetDirName}/${rel}`, publicPath]);
}

/**
 * Wix 的圖片網址長這樣：
 *   https://static.wixstatic.com/media/<檔名>/v1/fill/w_792,h_526,…/<顯示名稱>
 * `/media/` 後面那一段就是 Chrome 存到本機的檔名，所以只要查得到本地檔案，
 * 整段網址都能換成本地路徑 —— og:image、<source srcset>、JSON-LD 裡的圖片
 * 一次全部處理掉，不必逐一刪除。
 *
 * 本地檔是某個特定尺寸的算圖，拿來對應所有尺寸沒有問題，瀏覽器會自行縮放。
 */
function rewriteWixMediaUrls(html, mediaMap) {
  // 只用空白、引號與角括號斷句：
  //   - 不能用右括號，圖片的顯示名稱會出現在網址結尾且可能含括號
  //     （例如「R 蘿蔔先生 (黑底白字)透明.png」）
  //   - 不能用逗號，裁切參數本身就帶逗號（.../v1/crop/x_474,y_51,w_1821/...）
  // srcset 以「逗號加空白」分隔，所以逗號只會黏在結尾，單獨處理即可。
  // 這些網址只出現在 srcset 清單與引號屬性裡，不會出現在 CSS 的 url() 內。
  return html.replace(/https?:\/\/static\.wixstatic\.com\/media\/[^"'\s<>]+/gi, (match) => {
    const trailing = match.match(/[,;]+$/)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    const [mediaId, ...rest] = url.slice(url.indexOf('/media/') + '/media/'.length).split('/');

    // 網址開頭是媒體 ID，結尾則是顯示名稱。Chrome 存檔時用的可能是任一種
    // （logo 就是存成顯示名稱），兩個都試。
    const candidates = [mediaId, rest.at(-1), safeDecode(rest.at(-1) ?? '')];
    for (const candidate of candidates) {
      const hit = candidate && mediaMap.get(candidate);
      if (hit) return hit + trailing;
    }
    return match;
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 移除指向 Wix 的 srcset —— Chrome 只會把當下顯示的那一張存到本機，
 * srcset 裡其餘尺寸仍指向 Wix。瀏覽器有 srcset 就會優先採用，
 * 等於圖片還是從 Wix 載入，Wix 一停就全破。src 已是本地檔案時直接拿掉。
 */
function stripRemoteSrcset(html) {
  // <picture> 裡的 <source> 優先於 <img>，仍指向 Wix 的就整個拿掉，
  // 讓瀏覽器退回使用 <img> 的本地 src。
  const withoutSources = html.replace(/<source\b[^>]*>/gi, (tag) =>
    /wixstatic|parastorage/i.test(tag) ? '' : tag
  );

  return withoutSources.replace(/<img\b[^>]*>/gi, (tag) => {
    if (!/\ssrc=["']\/assets\//i.test(tag)) return tag;
    if (!/wixstatic|parastorage/i.test(tag)) return tag;
    return tag.replace(/\s(?:srcset|sizes)=["'][^"']*["']/gi, '');
  });
}

/**
 * 移除 Wix 小工具的 iframe（例如 Wix Chat）—— 這些功能遷移後不可能運作。
 * 同時移除指向不存在檔案的 iframe：頁面沒附資源資料夾時，小工具的 HTML
 * 也不會在資源庫裡，留著只會是一個 404 的空框。
 */
function stripWidgetIframes(html, widgetPaths, availableAssets) {
  return html.replace(/<iframe\b[^>]*>(?:[\s\S]*?<\/iframe>)?/gi, (tag) => {
    const src = tag.match(/src=["']([^"']+)["']/i)?.[1];
    if (!src) return tag;

    const normalized = src.replace(/^\.\//, '');
    if (widgetPaths.has(normalized)) return '';

    // 指向本站但檔案不存在
    if (normalized.startsWith(`${ASSET_PREFIX}/`)) {
      const rel = safeDecode(normalized.slice(ASSET_PREFIX.length + 1));
      if (!availableAssets.has(rel)) return '';
    }
    return tag;
  });
}

/**
 * 清掉不會產生網路請求、但會讓「還連著 Wix 嗎」的檢查誤報的殘留字串：
 *   <style data-href="https://static.parastorage.com/…">  CSS 本身是內嵌的，
 *                                                         這個屬性只是來源註記
 *   /*# sourceMappingURL=https://… *\/                   只有開發工具會用到
 */
function stripDeadMetadata(html) {
  return html
    .replace(
      /\s+data-(?:url|href)=["']https?:\/\/(?:static\.parastorage\.com|static\.wixstatic\.com)[^"']*["']/gi,
      ''
    )
    .replace(/\/\*#\s*sourceMappingURL=[^*]*\*\//gi, '');
}

/**
 * 依 id 移除整個元素，含巢狀內容。用計數配對結束標籤，
 * 因為 Wix 的橫幅裡面還有好幾層 div，用正規表示式會切在錯的地方。
 */
function removeElementById(html, id, tag = 'div') {
  const openRe = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const match = html.match(openRe);
  if (!match) return html;

  const start = match.index;
  const scanner = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
  scanner.lastIndex = start + match[0].length;

  let depth = 1;
  let hit;
  while ((hit = scanner.exec(html))) {
    depth += hit[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + html.slice(hit.index + hit[0].length);
  }
  return html; // 沒配對到就別亂動
}

/**
 * 清掉會把訪客或搜尋引擎導回 Wix 的殘留。這些不像圖片那樣看得見，
 * 但影響更實際：
 *   - JSON-LD 的 SearchAction 會告訴搜尋引擎「這個站的搜尋在 Wix 上」
 *   - rel="alternate" 的 RSS 指向 Wix，對方一停就是死的 feed
 *   - 搜尋框的 form action 會讓訪客一按就跳去 Wix
 *   - Chrome 存檔留下的 <!-- saved from url --> 註解
 */
function stripWixEndpoints(html) {
  const cleaned = html
    .replace(/<!--\s*saved from url=[^>]*-->/gi, '')
    .replace(/<link\b[^>]*rel=["']alternate["'][^>]*(?:wixsite\.com|wixapps\.net)[^>]*>/gi, '')
    // 搜尋框沒有後端可接，拿掉 action 讓它停在原地，而不是把人送去 Wix
    .replace(
      /(<form\b[^>]*)\saction=["'][^"']*(?:wixsite\.com|wixapps\.net|wix\.com)[^"']*["']/gi,
      '$1'
    );

  return removeJsonKey(cleaned, 'potentialAction', /wixsite\.com|wixapps\.net/i);
}

/**
 * 從 JSON-LD 移除某個鍵及其整個物件值，只在該物件符合 predicate 時才動手。
 *
 * 這裡不能用正規表示式：Wix 的搜尋網址含有 {search_term} 這種佔位字串，
 * 括號會被算進巢狀層數而配對錯誤。改成逐字掃描並略過字串內容。
 */
function removeJsonKey(text, key, predicate) {
  const marker = `"${key}":`;
  let out = '';
  let cursor = 0;

  for (;;) {
    const at = text.indexOf(marker, cursor);
    if (at < 0) break;

    const braceAt = text.indexOf('{', at + marker.length);
    const braceEnd = braceAt < 0 ? -1 : matchingBrace(text, braceAt);
    if (braceEnd < 0) break;

    if (!predicate.test(text.slice(braceAt, braceEnd))) {
      out += text.slice(cursor, braceEnd);
      cursor = braceEnd;
      continue;
    }

    // 連同前面的逗號一起刪掉，否則會留下 {"a":1,,"b":2} 這種壞掉的 JSON
    let from = at;
    while (from > 0 && /\s/.test(text[from - 1])) from--;
    if (text[from - 1] === ',') from--;

    out += text.slice(cursor, from);
    cursor = braceEnd;
    // 若這個鍵原本排在第一個，刪掉後會留下開頭的逗號
    if (text[cursor] === ',' && /\{\s*$/.test(out)) cursor++;
  }

  return out + text.slice(cursor);
}

/** 從左大括號往後找到配對的右大括號，掃描時略過字串內容 */
function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** 移除 Wix 免費版在頁面頂端插入的推廣橫幅 */
function stripWixAds(html) {
  return removeElementById(html, 'WIX_ADS');
}

/**
 * 免費版的 Wix 站沒有自己的圖示，favicon 直接指向 wix.com —— 留著的話
 * 瀏覽器分頁上會顯示 Wix 的商標。一併移除，之後可在 content/site.json 指定自己的。
 */
function stripWixFavicon(html) {
  return html.replace(
    /<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']https?:\/\/(?:www\.)?wix\.com\/[^"']*["'][^>]*>/gi,
    ''
  );
}

/**
 * 字型替換。原站的 Avenir / DIN Next / Futura / Helvetica 是 Wix 為平台上的
 * 網站購買的商業授權字型，自行託管很可能不在授權範圍內，所以不下載、改替換。
 *
 * 做三件事：
 *   1. 移除所有從 Wix 載入字型的 @font-face —— 這是最後一個連向 Wix 的東西
 *   2. 把 --font_N 變數的粗細改成替代字型對應的字重（原本一律是 normal，
 *      粗細是靠「heavy」「light」這種字體名稱表達的，只換名稱會弄丟）
 *   3. 把 CSS 裡的字型名稱換成替代字型加上中文系統字型的堆疊
 */
function replaceFonts(html, config) {
  if (!config) return html;

  const { substitutions = {}, chineseStack = 'sans-serif', googleFontsUrl } = config;
  const names = Object.keys(substitutions).sort((a, b) => b.length - a.length);

  // 1. 移除指向 Wix 的 @font-face
  let out = html.replace(/@font-face\s*\{[^}]*\}/gi, (block) =>
    /parastorage\.com|wixstatic\.com/i.test(block) ? '' : block
  );

  // 2. --font_N 的字重。字體名稱決定粗細，所以要先看原本用的是哪一個。
  out = out.replace(/(--font_\d+:\s*)([^;}]+)/gi, (whole, prefix, value) => {
    const matched = names.find((name) => value.toLowerCase().includes(name));
    if (!matched) return whole;
    const { weight } = substitutions[matched];
    // 簡寫格式：font-style font-variant font-weight size/line-height family
    return prefix + value.replace(/^(\s*\S+\s+\S+\s+)\S+/, `$1${weight}`);
  });

  // 3. 名稱替換。長的先換，避免 futura-lt-w01-book 被 futura-lt-w01 之類的前綴咬掉。
  for (const name of names) {
    const stack = `"${substitutions[name].family}", ${chineseStack}`;
    out = out.replace(new RegExp(`(["'])${escapeRegExp(name)}\\1`, 'gi'), stack);
    out = out.replace(new RegExp(escapeRegExp(name), 'gi'), stack);
  }

  // 4. 載入替代字型
  if (googleFontsUrl) {
    const link =
      `<link rel="preconnect" href="https://fonts.googleapis.com">` +
      `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
      `<link rel="stylesheet" href="${googleFontsUrl}">`;
    out = out.replace(/<\/head>/i, `${link}</head>`);
  }

  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 存檔頁面之間互相連結時用的是檔名 */
function fileLinkReplacements(filename, route) {
  const forms = new Set([filename, `./${filename}`, encodeURI(filename), `./${encodeURI(filename)}`]);
  const pairs = [];
  for (const form of forms) {
    pairs.push([`href="${form}"`, `href="${route}"`], [`href='${form}'`, `href='${route}'`]);
  }
  return pairs;
}

/**
 * 刪除沒有被任何頁面或樣式引用的資源。以檔名比對，因為 CSS 內多半用
 * 同層相對路徑引用（url(x.jpg)），不會出現完整公開路徑。
 */
async function pruneUnreferenced(pagePaths) {
  const cssPaths = (await listFiles(ASSET_ROOT)).filter((rel) => rel.endsWith('.css'));

  let corpus = '';
  for (const p of pagePaths) corpus += await readFile(p, 'utf8');
  for (const rel of cssPaths) corpus += await readFile(path.join(ASSET_ROOT, ...rel.split('/')), 'utf8');

  let count = 0;
  let bytes = 0;
  for (const rel of await listFiles(ASSET_ROOT)) {
    const basename = rel.split('/').pop();
    if (corpus.includes(basename)) continue;
    const full = path.join(ASSET_ROOT, ...rel.split('/'));
    bytes += (await readFile(full)).length;
    await rm(full);
    count++;
  }
  return { count, bytes };
}

/** 列出頁面中仍指向 Wix 網域的資源，依網址歸類 */
async function reportRemoteRefs(pagePaths) {
  const counts = new Map();
  const pattern = /https?:\/\/(?:static\.wixstatic\.com|static\.parastorage\.com|[\w-]+\.wixapps\.net)\/[^\s"'()<>\\]+/gi;

  for (const p of pagePaths) {
    const html = await readFile(p, 'utf8');
    for (const m of html.matchAll(pattern)) {
      const url = m[0].length > 110 ? `${m[0].slice(0, 110)}…` : m[0];
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

async function main() {
  if (!existsSync(INBOX)) {
    console.error(`找不到 ${path.relative(ROOT, INBOX)}/。`);
    process.exit(1);
  }

  const htmlPaths = (await findHtmlFiles(INBOX)).sort();
  if (!htmlPaths.length) {
    console.error(`${path.relative(ROOT, INBOX)}/ 裡（含子資料夾）沒有找到任何 .html 檔案。`);
    process.exit(1);
  }

  const fontsFile = path.join(ROOT, 'content', 'fonts.json');
  const fontConfig = existsSync(fontsFile) ? JSON.parse(await readFile(fontsFile, 'utf8')) : null;

  const routesFile = path.join(INBOX, 'routes.json');
  const routeMap = existsSync(routesFile) ? JSON.parse(await readFile(routesFile, 'utf8')) : {};

  const warnings = [];
  const plan = [];

  for (const absPath of htmlPaths) {
    const filename = path.basename(absPath);
    const relPath = path.relative(INBOX, absPath).split(path.sep).join('/');
    const basename = filename.replace(HTML_EXT, '');
    const html = await readFile(absPath, 'utf8');

    let route = routeMap[relPath] ?? routeMap[filename] ?? routeFromName(basename);
    if (!route) {
      route = `/page-${plan.length + 1}`;
      warnings.push(`「${relPath}」的檔名無法轉成網址，暫定為 ${route}。請用 routes.json 指定。`);
    }

    plan.push({ absPath, relPath, filename, basename, route, html, originalUrl: extractOriginalUrl(html) });
  }

  if (plan.length === 1 && plan[0].route !== '/') {
    warnings.push(`只有一個頁面，視為首頁（原本推斷為 ${plan[0].route}）。`);
    plan[0].route = '/';
  }

  const dupes = plan.map((p) => p.route).filter((r, i, all) => all.indexOf(r) !== i);
  if (dupes.length) {
    console.error(`\n有多個頁面對應到同一個網址：${[...new Set(dupes)].join(', ')}`);
    console.error('請用 inbox/routes.json 指定各自的路由後再執行一次。\n');
    process.exit(1);
  }

  await rm(SNAPSHOT, { recursive: true, force: true });
  await mkdir(ASSET_ROOT, { recursive: true });
  await writeFile(path.join(SNAPSHOT, '.gitkeep'), '');

  // ── 合併並去重所有頁面的資源 ────────────────────────────────
  const storedByName = new Map(); // 已使用的存放路徑
  const pathByHash = new Map(); // 內容雜湊 -> 公開路徑
  const widgetPaths = new Set(); // 內嵌 Wix 執行期的小工具頁
  const stats = { copied: 0, deduped: 0, skippedJs: 0, bytes: 0, renamed: 0 };

  for (const item of plan) {
    item.assetDirName = await findAssetDir(item.absPath);
    item.overrides = [];
    if (!item.assetDirName) continue;

    const sourceDir = path.join(path.dirname(item.absPath), item.assetDirName);

    for (const rel of await listFiles(sourceDir)) {
      if (JS_LIKE.test(rel)) {
        stats.skippedJs++;
        continue;
      }

      const buffer = await readFile(path.join(sourceDir, rel));
      const hash = crypto.createHash('sha1').update(buffer).digest('hex');

      // 同內容已經存過了，直接指過去
      if (pathByHash.has(hash)) {
        stats.deduped++;
        // 同一份小工具在多個頁面重複出現，去重後仍要保留標記
        const existing = pathByHash.get(hash);
        if (existing !== `${ASSET_PREFIX}/${rel}`) {
          pushOverride(item, rel, existing);
        }
        continue;
      }

      // 同檔名但內容不同（Wix 同一張圖在不同頁面會有不同尺寸），
      // 補上內容雜湊避免互相覆蓋
      let storedRel = rel;
      if (storedByName.has(rel)) {
        const ext = path.extname(rel);
        storedRel = `${rel.slice(0, rel.length - ext.length)}.${hash.slice(0, 8)}${ext}`;
        stats.renamed++;
        pushOverride(item, rel, `${ASSET_PREFIX}/${storedRel}`);
      }

      const target = path.join(ASSET_ROOT, ...storedRel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);

      const publicPath = `${ASSET_PREFIX}/${storedRel}`;
      storedByName.set(storedRel, hash);
      pathByHash.set(hash, publicPath);
      stats.copied++;
      stats.bytes += buffer.length;

      // 小工具頁（Wix Chat 之類）本身就是一份會載入 Wix 執行期的 HTML，
      // 記下來，稍後把引用它們的 iframe 一併移除。
      if (HTML_EXT.test(storedRel) && /parastorage|wixapps|wix\.com/i.test(buffer.toString('utf8'))) {
        widgetPaths.add(publicPath);
      }
    }
  }

  // ── 改寫並輸出頁面 ──────────────────────────────────────────
  const linkReplacements = [];
  for (const item of plan) {
    linkReplacements.push(...fileLinkReplacements(item.filename, item.route));
    if (item.originalUrl) linkReplacements.push(...pageUrlReplacements(item.originalUrl, item.route));
  }
  const sortedLinks = sortedByLength(linkReplacements);

  // Wix 圖片檔名 -> 本地路徑
  const mediaMap = new Map();
  const availableAssets = new Set(await listFiles(ASSET_ROOT));
  for (const rel of availableAssets) {
    mediaMap.set(rel.split('/').pop(), `${ASSET_PREFIX}/${rel}`);
  }

  console.log('── 匯入 Chrome 存檔 ──────────────────────');

  for (const item of plan) {
    // 個別檔案的覆寫要排在資料夾前綴之前（長度排序會處理），
    // 前綴替換負責其餘所有沒有更名的資源。
    // 沒有一起上傳資源資料夾的頁面，同樣套用前綴改寫：資源庫是全站共用的，
    // 只要同一個檔案曾出現在別的頁面就已經在庫裡了，不必重傳。
    const referencedDirs = new Set(item.assetDirName ? [item.assetDirName] : []);
    for (const m of item.html.matchAll(ASSET_DIR_REF)) referencedDirs.add(m[1]);

    const assetReplacements = sortedByLength([
      ...item.overrides,
      ...[...referencedDirs].flatMap((dir) => [
        [`./${dir}/`, `${ASSET_PREFIX}/`],
        [`${dir}/`, `${ASSET_PREFIX}/`],
        [`./${encodeURI(dir)}/`, `${ASSET_PREFIX}/`],
        [`${encodeURI(dir)}/`, `${ASSET_PREFIX}/`],
      ]),
    ]);

    let html = stripScripts(item.html);
    html = applyReplacements(html, sortedLinks);
    html = applyReplacements(html, assetReplacements);
    html = rewriteWixMediaUrls(html, mediaMap);
    html = stripRemoteSrcset(html);
    html = stripWidgetIframes(html, widgetPaths, availableAssets);
    html = stripDeadMetadata(html);
    html = stripWixAds(html);
    html = stripWixFavicon(html);
    html = stripWixEndpoints(html);
    html = replaceFonts(html, fontConfig);

    const outFile = path.join(SNAPSHOT, fileFromRoute(item.route));
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, html, 'utf8');

    // 只有在改寫之後還留著 Wix 圖片網址時才示警。少了資源資料夾不必然是問題 ——
    // 資源是全站共用的，同一張圖只要出現在其他頁面就已經在庫裡了。
    const orphaned = html.match(/https?:\/\/static\.wixstatic\.com\/media\//gi)?.length ?? 0;
    if (orphaned && !item.assetDirName) {
      warnings.push(
        `「${item.relPath}」少了資源資料夾，且有 ${orphaned} 張圖在共用資源庫裡也找不到，` +
          '會是破圖。請把該頁的 _files 資料夾一併上傳。'
      );
    }

    console.log(
      `  ✓ ${item.route.padEnd(26)} ← ${item.filename}${item.assetDirName ? '' : '（無資源資料夾，圖片取自共用庫）'}`
    );
  }

  // 資源全部平移到同一層，CSS 的同層相對路徑（url(x.jpg)）仍然成立，不需改寫。

  // ── 清掉沒有被引用的資源 ────────────────────────────────────
  // 移除小工具 iframe 後，它的 HTML 與樣式（Wix Chat 的 CSS 就有 1.3 MB）
  // 都成了孤兒；同理，被拿掉的 srcset 也可能讓某些圖片失去引用。
  const pruned = await pruneUnreferenced(plan.map((i) => path.join(SNAPSHOT, fileFromRoute(i.route))));

  console.log('\n── 資源 ──');
  console.log(`  保留 ${stats.copied} 個（${(stats.bytes / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`  去重省下 ${stats.deduped} 個重複檔案`);
  console.log(`  排除 ${stats.skippedJs} 個 JS`);
  if (stats.renamed) console.log(`  ${stats.renamed} 個同名不同內容，已加上雜湊區分`);
  if (pruned.count) {
    console.log(`  清掉 ${pruned.count} 個未被引用的檔案（${(pruned.bytes / 1024 / 1024).toFixed(1)} MB）`);
  }

  // ── 還連著 Wix 的地方 ───────────────────────────────────────
  const remaining = await reportRemoteRefs(plan.map((i) => path.join(SNAPSHOT, fileFromRoute(i.route))));
  if (remaining.length) {
    console.log('\n── 仍指向 Wix 的資源 ──');
    for (const { url, count } of remaining) console.log(`  ${count} 處  ${url}`);
    console.log('  Wix 停用後這些會失效，需要另外取得檔案或改用替代方案。');
  } else {
    console.log('\n✓ 頁面中已無任何指向 Wix 的資源。');
  }

  if (warnings.length) {
    console.log('\n⚠ 提醒：');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  console.log('\n接著執行 `npm run build`，再用 `npm run audit` 驗收。');
}

main().catch((err) => {
  console.error(`\n匯入失敗：${err.message}\n`);
  process.exit(1);
});
