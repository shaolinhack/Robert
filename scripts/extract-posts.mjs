/**
 * extract-posts.mjs — 把快照裡的文章轉成 content/pages/ 底下可編輯的 JSON。
 *
 *   node scripts/extract-posts.mjs
 *
 * 這是一次性的搬遷工具。跑完之後 content/ 就是內容的唯一來源，快照只留作對照。
 *
 * Wix 的富文本把每個區塊包成 <div type="paragraph|heading|image|…">，
 * 這裡照那個結構逐塊取出，轉成 { t: 'p' | 'h2' | 'ul' | 'img' … } 的節點陣列。
 * 保留粗體、斜體與連結，其餘樣式（顏色、字級）一律丟掉 —— 那些交給設計系統。
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// 來源固定為 snapshot/：public/ 是建置產物，重寫過的頁面已經在裡面，
// 從那裡抽會變成拿自己的輸出當輸入，內容只會愈抽愈少。
const POSTS_DIR = path.join(ROOT, 'snapshot', 'post');
const OUT_DIR = path.join(ROOT, 'content', 'pages');

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));

/** 行內內容轉成極簡 Markdown，其餘標籤與樣式一律去掉 */
function inline(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
        const label = inline(text).trim();
        return label ? `[${label}](${href})` : '';
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => {
        const inner = inline(t).trim();
        return inner ? `**${inner}**` : '';
      })
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => {
        const inner = inline(t).trim();
        return inner ? `*${inner}*` : '';
      })
      .replace(/<[^>]+>/g, '')
  )
    .replace(/​/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 取出與起始標籤配對的整段 HTML */
function sliceElement(html, start) {
  const tag = html.slice(start).match(/^<(\w+)/)?.[1];
  if (!tag) return null;
  if (/^(img|br|hr)$/i.test(tag)) return html.slice(start, html.indexOf('>', start) + 1);

  const scanner = new RegExp(`<${tag}\\b|</${tag}>`, 'gi');
  scanner.lastIndex = start;
  let depth = 0;
  let hit;
  while ((hit = scanner.exec(html))) {
    depth += hit[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, hit.index + hit[0].length);
  }
  return null;
}

function listItems(block) {
  return [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => inline(m[1]))
    .filter(Boolean);
}

function extractImage(block) {
  const src = block.match(/<img\b[^>]*src="([^"]*)"/i)?.[1];
  if (!src) return null;
  const alt = block.match(/<img\b[^>]*alt="([^"]*)"/i)?.[1] ?? '';
  const caption = inline(block.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] ?? '');
  return { t: 'img', src, alt: decode(alt), ...(caption ? { caption } : {}) };
}

/**
 * 依文件順序掃描內文標籤。
 *
 * Wix 的 <div type="paragraph"> 其實是空的標記元素，真正的內容放在旁邊的
 * <div data-breakout> 裡，所以不能照那個結構取。改成直接找 p / h2 / h3 /
 * ul / ol / blockquote / figure，取完一個就把游標跳到它的結尾，巢狀在裡面的
 * 同名標籤（例如 <li> 內的 <p>）就不會被重複取到。
 */
function parseBody(html) {
  const nodes = [];
  const opener = /<(p|h2|h3|ul|ol|blockquote|figure)\b[^>]*>|<div\s+type="divider"/gi;
  let cursor = 0;

  for (;;) {
    opener.lastIndex = cursor;
    const match = opener.exec(html);
    if (!match) break;

    if (match[0].startsWith('<div')) {
      nodes.push({ t: 'hr' });
      cursor = match.index + match[0].length;
      continue;
    }

    const tag = match[1].toLowerCase();
    const block = sliceElement(html, match.index);
    cursor = block ? match.index + block.length : match.index + match[0].length;
    if (!block) continue;

    if (tag === 'figure') {
      // 只有真的帶圖的 figure 才算內容，其餘是操作介面（放大鈕之類）
      const image = extractImage(block);
      if (image) nodes.push(image);
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = listItems(block);
      if (items.length) nodes.push({ t: tag, items });
      continue;
    }

    if (tag === 'blockquote') {
      const text = inline(block);
      if (text) nodes.push({ t: 'quote', text });
      continue;
    }

    const text = inline(block);
    if (!text) continue;

    if (tag === 'p') {
      nodes.push({ t: 'p', text });
      continue;
    }

    // Wix 會把只是「想放大加粗」的整段文字也包成 <h3>。標題應該短而具結構性，
    // 長段落掛成標題會讓大綱失去意義，對 SEO 與螢幕閱讀器都是雜訊。
    // 超過這個長度就當段落，並保留原本的粗體。
    const looksLikeHeading = text.replace(/\*/g, '').length <= 48;
    if (looksLikeHeading) {
      nodes.push({ t: tag, text: text.replace(/^\*\*([\s\S]*)\*\*$/, '$1') });
    } else {
      nodes.push({ t: 'p', text });
    }
  }

  return nodes;
}

function meta(html, property, attr = 'content') {
  const tag = html.match(new RegExp(`<meta[^>]*property="${property}"[^>]*>`, 'i'))?.[0];
  return tag?.match(new RegExp(`${attr}="([^"]*)"`, 'i'))?.[1] ?? null;
}

async function main() {
  if (!existsSync(POSTS_DIR)) {
    console.error('找不到 snapshot/post/，請先匯入快照（npm run import）。');
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const slugs = (await readdir(POSTS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  console.log('── 抽取文章 ──────────────────────────────');
  const index = [];

  for (const slug of slugs) {
    const file = path.join(POSTS_DIR, slug, 'index.html');
    if (!existsSync(file)) continue;
    const html = await readFile(file, 'utf8');

    const start = html.indexOf('data-hook="post-description"');
    if (start < 0) {
      console.log(`  ✗ ${slug}（找不到內文容器）`);
      continue;
    }
    const body = sliceElement(html, html.lastIndexOf('<', start)) ?? '';
    const nodes = parseBody(body);

    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? slug;
    const published = meta(html, 'article:published_time');
    const updated = meta(html, 'article:modified_time');
    const cover = meta(html, 'og:image');
    const readTime = html.match(/data-hook="time-to-read"[^>]*>([^<]*)/i)?.[1]?.trim() ?? null;
    const description = meta(html, 'og:description');

    // 內文第一張圖若就是封面，去掉它 —— 否則同一張圖會連續出現兩次
    if (cover && nodes[0]?.t === 'img' && nodes[0].src === cover) nodes.shift();

    const page = {
      title,
      description: description ? decode(description).slice(0, 155) : '',
      route: `/post/${slug}`,
      layout: 'post',
      published,
      updated,
      readTime,
      cover: cover ? { src: cover, alt: title } : null,
      body: nodes,
    };

    const name = `post-${slug}.json`;
    await writeFile(path.join(OUT_DIR, name), JSON.stringify(page, null, 2) + '\n', 'utf8');

    const counts = nodes.reduce((acc, n) => ({ ...acc, [n.t]: (acc[n.t] ?? 0) + 1 }), {});
    console.log(
      `  ✓ ${slug.padEnd(22)} ${nodes.length} 節點  ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' ')}`
    );
    index.push({ slug, title, published, cover, description: page.description, readTime });
  }

  await writeFile(
    path.join(ROOT, 'content', 'posts-index.json'),
    JSON.stringify(index, null, 2) + '\n',
    'utf8'
  );
  console.log(`\n共 ${index.length} 篇 → content/pages/post-*.json、content/posts-index.json`);
}

main().catch((err) => {
  console.error(`\n抽取失敗：${err.message}\n`);
  process.exit(1);
});
