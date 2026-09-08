/**
 * unpack-zip.mjs — 解開 inbox/ 裡的 ZIP，正確處理 Windows 的中文檔名。
 *
 *   node scripts/unpack-zip.mjs [來源目錄]
 *
 * Windows 內建的壓縮功能會用系統編碼（繁中是 CP950/Big5）存檔名，而且不會設定
 * UTF-8 旗標。一般的解壓工具會把它當成 CP437 解讀，中文檔名就變成亂碼。
 * 這裡依旗標判斷：有設就用 UTF-8，沒設就用 Big5。
 *
 * 零相依，只用 node:zlib 解 deflate。
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INBOX = path.resolve(process.argv[2] || path.join(ROOT, 'inbox'));
const FALLBACK_ENCODING = process.env.ZIP_ENCODING || 'big5';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const UTF8_FLAG = 0x800;

/** 從檔尾往回找中央目錄結尾標記（後面可能跟著最多 64KB 的註解） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('這不是有效的 ZIP 檔（找不到中央目錄）');
}

function decodeName(bytes, flags) {
  if (flags & UTF8_FLAG) return new TextDecoder('utf-8').decode(bytes);
  // 純 ASCII 兩種編碼結果一樣，直接用 UTF-8 省事
  if (bytes.every((b) => b < 0x80)) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder(FALLBACK_ENCODING).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** 擋掉 zip slip：解出來的路徑不能跑到目標目錄外面 */
function safeJoin(base, name) {
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`ZIP 內含可疑路徑，已中止：${name}`);
  }
  return target;
}

function* entries(buf) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  if (offset === 0xffffffff) throw new Error('這是 ZIP64 格式，本工具不支援');

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error('中央目錄結構損毀');

    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const nameBytes = buf.subarray(offset + 46, offset + 46 + nameLen);

    yield { name: decodeName(nameBytes, flags), method, compressedSize, localOffset };
    offset += 46 + nameLen + extraLen + commentLen;
  }
}

function readData(buf, entry) {
  if (buf.readUInt32LE(entry.localOffset) !== LOCAL_SIG) throw new Error(`區域檔頭損毀：${entry.name}`);

  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`不支援的壓縮方式 ${entry.method}：${entry.name}`);
}

async function unpack(zipPath) {
  const buf = await readFile(zipPath);
  const outDir = path.join(path.dirname(zipPath), path.basename(zipPath).replace(/\.zip$/i, ''));

  let files = 0;
  let bytes = 0;

  for (const entry of entries(buf)) {
    if (entry.name.endsWith('/')) {
      await mkdir(safeJoin(outDir, entry.name), { recursive: true });
      continue;
    }
    const target = safeJoin(outDir, entry.name);
    const data = readData(buf, entry);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    files++;
    bytes += data.length;
  }

  return { outDir, files, bytes };
}

async function main() {
  if (!existsSync(INBOX)) {
    console.error(`找不到 ${path.relative(ROOT, INBOX)}/。`);
    process.exit(1);
  }

  const zips = (await readdir(INBOX)).filter((n) => n.toLowerCase().endsWith('.zip'));
  if (!zips.length) {
    console.log(`${path.relative(ROOT, INBOX)}/ 裡沒有 ZIP 檔，不需要解壓。`);
    return;
  }

  console.log('── 解壓縮 ──────────────────────────────');
  for (const name of zips) {
    const { outDir, files, bytes } = await unpack(path.join(INBOX, name));
    console.log(`  ✓ ${name}`);
    console.log(`     → ${path.relative(ROOT, outDir)}/  ${files} 個檔案，${(bytes / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log('\n接著執行 `npm run import`。');
}

main().catch((err) => {
  console.error(`\n解壓失敗：${err.message}\n`);
  process.exit(1);
});
