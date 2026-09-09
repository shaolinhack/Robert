#!/usr/bin/env node
/**
 * 掃描全站內容，把提到過的書整理成 content/books.json。
 *
 *   node scripts/extract-books.mjs
 *
 * 來源：Podcast 單集（標題與內容）、書聚時間軸、部落格文章。
 * 書名以《》辨識，但《》在文章裡也拿來當段落標題，所以要濾掉。
 *
 * 已存在的 books.json 會被「合併」而不是覆蓋 —— 你手動補的簡介、
 * 連結、分類都會保留，只更新出處清單。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(CONTENT, 'books.json');

/** 這些是文章的段落標題或活動主題，不是書 */
const NOT_BOOKS = [
  /^先講結論$/, /^本篇文章/, /^QA目錄/, /^FAQ$/, /保險FAQ\d+問/,
  /^投保前/, /^保險業務員/, /^保險小撇步/, /^開團前後/, /^書聚旁聽篇$/,
  /^書聚狀況篇$/, /^關於讀書會$/, /主題式閱讀$/, /^月讀$/, /^\s*$/,
];

const readJson = async (p) => (existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null);

function isBook(name) {
  if (name.length > 40) return false;
  return !NOT_BOOKS.some((re) => re.test(name));
}

/** 把「聽，傷痕在說話」與「聽，傷痕在說話：呂立的…」視為同一本，取短的當正式名稱*/
function canonicalise(names) {
  const sorted = [...names].sort((a, b) => a.length - b.length);
  const canon = new Map();
  for (const n of sorted) {
    const base = sorted.find((s) => s !== n && n.startsWith(s));
    canon.set(n, base ?? n);
  }
  return canon;
}

async function main() {
  const found = new Map(); // 書名 -> 出處陣列

  const record = (name, source) => {
    if (!isBook(name)) return;
    if (!found.has(name)) found.set(name, []);
    const list = found.get(name);
    if (!list.some((s) => s.href === source.href)) list.push(source);
  };

  const titles = (text) => [...String(text).matchAll(/《([^》]{1,40})》/g)].map((m) => m[1].trim());

  // Podcast
  const podcast = (await readJson(path.join(CONTENT, 'podcast-index.json'))) ?? { episodes: [] };
  for (const ep of podcast.episodes) {
    for (const b of titles(`${ep.title}\n${ep.notes ?? ''}`)) {
      record(b, { kind: 'Podcast', label: ep.title, href: `/podcast/${ep.slug}` });
    }
  }

  // 書聚時間軸
  const milestones = (await readJson(path.join(CONTENT, 'milestones.json'))) ?? {};
  for (const item of milestones['書聚'] ?? []) {
    for (const b of titles(item.title)) {
      record(b, { kind: '書聚', label: `${item.date}　${item.title}`, href: '/bookclub' });
    }
  }

  // 部落格文章
  const pagesDir = path.join(CONTENT, 'pages');
  for (const name of await readdir(pagesDir)) {
    if (!name.startsWith('post-') || !name.endsWith('.json')) continue;
    const page = await readJson(path.join(pagesDir, name));
    if (!page) continue;
    for (const b of titles(JSON.stringify(page))) {
      record(b, { kind: '文章', label: page.title, href: page.route });
    }
  }

  // 合併長短標題
  const canon = canonicalise(found.keys());
  const merged = new Map();
  for (const [name, sources] of found) {
    const key = canon.get(name);
    if (!merged.has(key)) merged.set(key, { title: key, aliases: [], sources: [] });
    const entry = merged.get(key);
    if (name !== key && !entry.aliases.includes(name)) entry.aliases.push(name);
    for (const s of sources) {
      if (!entry.sources.some((x) => x.href === s.href)) entry.sources.push(s);
    }
  }

  // 保留手動補的欄位
  const existing = (await readJson(OUT)) ?? { books: [] };
  const byTitle = new Map((existing.books ?? []).map((b) => [b.title, b]));

  const books = [...merged.values()]
    .map((b) => {
      const prev = byTitle.get(b.title) ?? {};
      return {
        title: b.title,
        ...(b.aliases.length ? { aliases: b.aliases } : {}),
        ...(prev.note ? { note: prev.note } : {}),
        ...(prev.link ? { link: prev.link } : {}),
        sources: b.sources,
      };
    })
    .sort((a, b) => b.sources.length - a.sources.length || a.title.localeCompare(b.title, 'zh-Hant'));

  await writeFile(OUT, JSON.stringify({ books }, null, 2) + '\n');

  console.log('── 整理書單 ──────────────────────────────');
  for (const b of books) {
    const kinds = [...new Set(b.sources.map((s) => s.kind))].join('、');
    console.log(`  ${b.title.padEnd(30)} ${String(b.sources.length).padStart(2)} 處　${kinds}`);
  }
  console.log(`\n共 ${books.length} 本 → content/books.json`);
}

main().catch((e) => { console.error('整理失敗：', e.message); process.exit(1); });
