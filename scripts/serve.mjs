/**
 * serve.mjs — 零相依的本機預覽伺服器，行為對齊正式環境的 Caddy 設定
 * （支援乾淨網址：/about -> about/index.html）。
 *
 * 用法：npm run preview   然後開 http://localhost:4173
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.env.OUT_DIR || 'public');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const base = path.join(ROOT, safe);

  // 依序嘗試：原路徑 → 目錄下的 index.html → 加上 .html → 全站 fallback
  for (const candidate of [base, path.join(base, 'index.html'), `${base}.html`]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {}
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  let status = 200;
  let file = await resolveFile(req.url);

  // 跟 Caddy 的 handle_errors 一致：找不到就回 404 頁面，且狀態碼是 404
  if (!file) {
    status = 404;
    file = await resolveFile('/404.html');
  }

  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found — public/ 是空的嗎？先執行 npm run build');
    return;
  }

  res.writeHead(status, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`預覽網站：http://localhost:${PORT}  (根目錄 ${ROOT})`);
});
