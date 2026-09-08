/**
 * import-chrome-save.mjs — 把 Chrome「網頁，完整」存檔轉成專案的 snapshot/ 格式。
 *
 * 給不方便跑 capture.mjs 的情況用：在 Chrome 按 Ctrl+S 選「網頁，完整」，
 * 會得到 `頁面.html` 加一個 `頁面_files/` 資料夾。把這些放進 inbox/ 後執行：
 *
 *   node scripts/import-chrome-save.mjs [來源目錄]
 *
 * inbox/ 底下可以有任意層資料夾 —— 解壓 ZIP 常常會多包一層，這裡會遞迴尋找
 * 所有 HTML，資源資料夾則以「與該 HTML 同一層的同名資料夾」為準。
 *
 * 路由對應可放 inbox/routes.json，鍵可用檔名或相對路徑：
 *   { "Robert.html": "/", "關於我.html": "/about" }
 * 沒有這個檔就依檔名自動推斷，無法安全轉成網址時會提出警告。
 */

import { readdir, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INBOX = path.resolve(process.argv[2] || path.join(ROOT, 'inbox'));
const SNAPSHOT = path.join(ROOT, 'snapshot');

const HTML_EXT = /\.x?html?$/i;

/** Chrome 在不同語系用不同的資料夾後綴 */
const KNOWN_SUFFIXES = ['_files', '_檔案', '_文件', '_fichiers', '_Dateien', '_archivos', '_file'];

/** HTML 裡引用資源資料夾的樣子，用來判斷「該有資料夾卻找不到」 */
const ASSET_DIR_REF = /["'(](?:\.\/)?([^"'()/]+?(?:_files|_檔案|_文件|_fichiers|_Dateien|_archivos))\//g;

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function routeFromName(basename) {
  if (/^(index|home|首頁|首页)$/i.test(basename)) return '/';
  const slug = slugify(basename);
  return slug ? `/${slug}` : null;
}

function fileFromRoute(route) {
  const slug = route.replace(/^\/+|\/+$/g, '');
  return slug ? path.join(slug, 'index.html') : 'index.html';
}

/** 遞迴找出所有 HTML，但不進入資源資料夾（那裡面的 HTML 不是頁面） */
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
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const suffix of KNOWN_SUFFIXES) {
    if (dirs.includes(`${basename}${suffix}`)) return `${basename}${suffix}`;
  }
  // 退而求其次：任何以檔名開頭的資料夾
  return dirs.find((name) => name !== basename && name.startsWith(basename)) ?? null;
}

/**
 * 把 `頁面_files/xxx.jpg` 這類相對路徑改寫成 `/assets/<slug>/xxx.jpg`。
 *
 * dirMap 一次帶入所有頁面的資料夾，因為 Chrome 存下的 CSS/HTML 有可能引用到
 * 另一個頁面存檔的資料夾。變體由長到短排序，否則 `./X_files/` 會先被 `X_files/`
 * 咬掉一半，留下 `.//assets/...`。
 */
function rewriteAssetPaths(text, dirMap) {
  const replacements = [];

  for (const [dirName, publicPrefix] of dirMap) {
    for (const variant of new Set([
      `./${dirName}/`,
      `${dirName}/`,
      `./${encodeURIComponent(dirName)}/`,
      `${encodeURIComponent(dirName)}/`,
      `${dirName.replace(/ /g, '%20')}/`,
    ])) {
      replacements.push([variant, `${publicPrefix}/`]);
    }
  }

  replacements.sort((a, b) => b[0].length - a[0].length);

  let out = text;
  for (const [needle, value] of replacements) {
    if (out.includes(needle)) out = out.split(needle).join(value);
  }
  return out;
}

/** 移除 Wix 的執行期腳本與追蹤碼，保留 JSON-LD */
function stripScripts(html) {
  return html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs) =>
      /application\/ld\+json/i.test(attrs) ? match : ''
    )
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<link\b[^>]*rel=["'](?:preload|prefetch|modulepreload)["'][^>]*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

/** 把指向其他存檔頁面的連結改成本站路由 */
function rewritePageLinks(html, pageRoutes) {
  let out = html;
  for (const [filename, route] of pageRoutes) {
    for (const variant of [filename, `./${filename}`, encodeURIComponent(filename)]) {
      out = out.split(`href="${variant}"`).join(`href="${route}"`);
      out = out.split(`href='${variant}'`).join(`href='${route}'`);
    }
  }
  return out;
}

/**
 * Chrome 存下的 CSS 多半用同層相對路徑（url(hero.jpg)），檔案搬到
 * /assets/<slug>/ 後仍然解析得到，不用動；這裡只處理指名資料夾的寫法。
 */
async function rewriteCssIn(dir, dirMap) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await rewriteCssIn(full, dirMap);
    else if (/\.css$/i.test(entry.name)) {
      const css = await readFile(full, 'utf8');
      const rewritten = rewriteAssetPaths(css, dirMap);
      if (rewritten !== css) await writeFile(full, rewritten, 'utf8');
    }
  }
}

async function main() {
  if (!existsSync(INBOX)) {
    console.error(`找不到 ${path.relative(ROOT, INBOX)}/。請先建立這個資料夾，把 Chrome 存下的檔案放進去。`);
    process.exit(1);
  }

  const htmlPaths = await findHtmlFiles(INBOX);
  if (!htmlPaths.length) {
    console.error(`${path.relative(ROOT, INBOX)}/ 裡（含子資料夾）沒有找到任何 .html 檔案。`);
    process.exit(1);
  }

  const routesFile = path.join(INBOX, 'routes.json');
  const routeMap = existsSync(routesFile) ? JSON.parse(await readFile(routesFile, 'utf8')) : {};

  // 先決定每個檔案的路由，才能改寫頁面之間的連結
  const plan = [];
  const warnings = [];

  for (const absPath of htmlPaths.sort()) {
    const filename = path.basename(absPath);
    const relPath = path.relative(INBOX, absPath).split(path.sep).join('/');
    const basename = filename.replace(HTML_EXT, '');

    let route = routeMap[relPath] ?? routeMap[filename] ?? routeFromName(basename);
    if (!route) {
      route = `/page-${plan.length + 1}`;
      warnings.push(`「${relPath}」的檔名無法轉成網址，暫定為 ${route}。請用 routes.json 指定正確路由。`);
    }
    plan.push({ absPath, relPath, filename, basename, route });
  }

  // 只有一頁時，它就是首頁
  if (plan.length === 1 && plan[0].route !== '/') {
    warnings.push(`只有一個頁面，視為首頁（原本推斷為 ${plan[0].route}）。`);
    plan[0].route = '/';
  }

  const duplicates = plan
    .map((p) => p.route)
    .filter((route, i, all) => all.indexOf(route) !== i);
  if (duplicates.length) {
    console.error(`\n有多個頁面對應到同一個網址：${[...new Set(duplicates)].join(', ')}`);
    console.error('請用 inbox/routes.json 指定各自的路由後再執行一次。\n');
    process.exit(1);
  }

  const pageRoutes = plan.map((p) => [p.filename, p.route]);

  await rm(SNAPSHOT, { recursive: true, force: true });
  await mkdir(SNAPSHOT, { recursive: true });
  await writeFile(path.join(SNAPSHOT, '.gitkeep'), '');

  console.log('── 匯入 Chrome 存檔 ──────────────────────');

  // 先把每個頁面的資源資料夾都搬好，建立完整對照表，
  // 才有辦法處理跨頁面互相引用的路徑。
  const dirMap = new Map();
  for (const item of plan) {
    item.slug = item.route === '/' ? 'home' : item.route.replace(/^\//, '').replace(/\//g, '-');
    item.assetDirName = await findAssetDir(item.absPath);
    item.assetCount = 0;

    if (!item.assetDirName) continue;

    // 所有 <script> 都已移除，.js 檔案不會被載入 —— Wix 的 bundle 動輒數 MB，
    // 一併排除，避免快照塞進大量永遠用不到的死重量。
    const target = path.join(SNAPSHOT, 'assets', item.slug);
    await cp(path.join(path.dirname(item.absPath), item.assetDirName), target, {
      recursive: true,
      filter: (src) => !/\.m?js$/i.test(src),
    });
    item.assetCount = (await readdir(target, { recursive: true })).length;
    dirMap.set(item.assetDirName, `/assets/${item.slug}`);
  }

  for (const item of plan) {
    if (item.assetDirName) {
      await rewriteCssIn(path.join(SNAPSHOT, 'assets', item.slug), dirMap);
    }

    const original = await readFile(item.absPath, 'utf8');

    // HTML 明明引用了資源資料夾，卻找不到對應的資料夾 —— 多半是上傳時
    // 只傳了 .html 沒傳資料夾，或拖曳時結構被壓平。這會做出滿是破圖的網站，
    // 寧可講清楚也不要安靜地產出壞結果。
    if (!item.assetDirName) {
      const referenced = new Set();
      for (const match of original.matchAll(ASSET_DIR_REF)) referenced.add(match[1]);
      if (referenced.size) {
        warnings.push(
          `「${item.relPath}」引用了資源資料夾 ${[...referenced].join('、')}，但同一層找不到。` +
            ' 圖片會全部破掉 —— 請確認資料夾有一起上傳，且和 .html 在同一層。'
        );
      }
    }

    let html = stripScripts(original);
    html = rewriteAssetPaths(html, dirMap);
    html = rewritePageLinks(html, pageRoutes);

    const outFile = path.join(SNAPSHOT, fileFromRoute(item.route));
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, html, 'utf8');

    console.log(
      `  ✓ ${item.relPath}  →  ${item.route}  (${item.assetCount} 個資源${
        item.assetDirName ? '' : '，無資源資料夾 ⚠'
      })`
    );
  }

  if (warnings.length) {
    console.log('\n⚠ 提醒：');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  console.log('\n接著執行 `npm run build`，再用 `npm run audit` 檢查殘留的 Wix 依賴。');
}

main().catch((err) => {
  console.error(`\n匯入失敗：${err.message}\n`);
  process.exit(1);
});
