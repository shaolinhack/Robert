#!/usr/bin/env node
/**
 * 從 Podcast 的 RSS feed 匯入單集資料。
 *
 *   node scripts/import-podcast.mjs <feed 網址或本機 xml 檔>
 *
 * RSS 才是節目資料的源頭（Apple Podcasts 只是目錄），欄位齊全又是結構化的 XML，
 * 比去爬 Apple 的頁面穩定得多。
 *
 * 產出：
 *   content/podcast-index.json     單集清單（標題、日期、長度、簡介、連結）
 *   content/assets/podcast/*.jpg   每集的封面圖（沒有單集封面的沿用節目封面）
 *
 * 找 feed 網址的方法：瀏覽器打開
 *   https://itunes.apple.com/lookup?id=1662758348&entity=podcast
 * 回傳的 JSON 裡的 feedUrl 就是。
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSET_DIR = path.join(ROOT, 'content', 'assets', 'podcast');
const INDEX = path.join(ROOT, 'content', 'podcast-index.json');

/** 取出標籤內容，CDATA 會自動剝掉 */
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m) return '';
  return decode(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim());
}

/** 取出屬性值，例如 <enclosure url="…"> */
function attr(xml, name, key) {
  const m = new RegExp(`<${name}\\b[^>]*\\b${key}=["']([^"']+)["']`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** 簡介去掉 HTML 標籤，只留純文字 */
function plain(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** itunes:duration 可能是秒數或 hh:mm:ss */
function duration(raw) {
  if (!raw) return '';
  if (/^\d+$/.test(raw)) {
    const total = Number(raw);
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    return h ? `${h} 小時 ${m} 分` : `${m} 分鐘`;
  }
  const parts = raw.split(':').map(Number);
  const [h, m] = parts.length === 3 ? parts : [0, parts[0]];
  return h ? `${h} 小時 ${m} 分` : `${m} 分鐘`;
}

async function load(source) {
  if (existsSync(source)) return readFile(source, 'utf8');
  const res = await fetch(source, { headers: { 'user-agent': 'jihwei-site-importer' } });
  if (!res.ok) throw new Error(`抓取 feed 失敗：${res.status} ${res.statusText}`);
  return res.text();
}

async function saveImage(url, slug) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = /\.(png|jpe?g|webp)(\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'jpg';
    const name = `${slug}.${ext === 'jpeg' ? 'jpg' : ext}`;
    await writeFile(path.join(ASSET_DIR, name), buf);
    return `/assets/podcast/${name}`;
  } catch {
    return null;
  }
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('用法：node scripts/import-podcast.mjs <feed 網址或本機 xml 檔>');
    process.exit(1);
  }

  const xml = await load(source);
  const channel = xml.slice(0, xml.search(/<item[\s>]/i) >>> 0);
  const showTitle = tag(channel, 'title');
  const showImage =
    attr(channel, 'itunes:image', 'href') || tag(channel, 'url');

  await mkdir(ASSET_DIR, { recursive: true });

  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  console.log(`── 匯入 Podcast ──────────────────────────`);
  console.log(`  節目：${showTitle}`);
  console.log(`  單集：${items.length} 集\n`);

  const episodes = [];
  for (const item of items) {
    const title = tag(item, 'title');
    if (!title) continue;
    const pub = tag(item, 'pubDate');
    const published = pub ? new Date(pub).toISOString() : '';
    const number = tag(item, 'itunes:episode');
    const season = tag(item, 'itunes:season');
    const slug = (number ? `ep${number}` : '') ||
      createHash('sha256').update(title).digest('hex').slice(0, 8);

    const body = tag(item, 'content:encoded') || tag(item, 'description') ||
      tag(item, 'itunes:summary');
    const art = attr(item, 'itunes:image', 'href') || showImage;
    const image = await saveImage(art, `${season ? `s${season}-` : ''}${slug}`);

    const ep = {
      slug: `${season ? `s${season}-` : ''}${slug}`,
      title,
      ...(number ? { episode: Number(number) } : {}),
      ...(season ? { season: Number(season) } : {}),
      published,
      duration: duration(tag(item, 'itunes:duration')),
      description: plain(body),
      link: tag(item, 'link') || attr(item, 'enclosure', 'url'),
      audio: attr(item, 'enclosure', 'url'),
      ...(image ? { image } : {}),
    };
    episodes.push(ep);
    console.log(`  ✓ ${(ep.published.slice(0, 10) || '—').padEnd(12)} ${title.slice(0, 44)}`);
  }

  episodes.sort((a, b) => String(b.published).localeCompare(String(a.published)));
  await writeFile(INDEX, JSON.stringify({ show: showTitle, episodes }, null, 2) + '\n');
  console.log(`\n共 ${episodes.length} 集 → content/podcast-index.json、content/assets/podcast/`);
}

main().catch((err) => {
  console.error('匯入失敗：', err.message);
  process.exit(1);
});
