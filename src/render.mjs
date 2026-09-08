/**
 * render.mjs — 把 content/ 的 JSON 內容渲染成語意化的 HTML。
 * 零相依，所以 Docker 建置階段不需要 npm install。
 */

import { icon } from './icons.mjs';

/* ── 工具 ─────────────────────────────────────────────────── */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 極簡行內 Markdown：**粗體**、*斜體*、[文字](網址)、`程式碼`。
 * 一律先做 HTML 轉義，所以內容不可能注入標籤。
 */
export function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
      const external = /^https?:\/\//.test(href);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`;
    });
}

const paragraphs = (body) =>
  toArray(body).map((line) => `<p>${inline(line)}</p>`).join('\n');

const toArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

function image(img, extra = '') {
  if (!img?.src) return '';
  const dims = [
    img.width ? ` width="${escapeHtml(img.width)}"` : '',
    img.height ? ` height="${escapeHtml(img.height)}"` : '',
  ].join('');
  return `<img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt ?? '')}"${dims} loading="${
    img.eager ? 'eager' : 'lazy'
  }" decoding="async"${extra}>`;
}

function actions(list) {
  const items = toArray(list).filter((a) => a?.href && a?.label);
  if (!items.length) return '';
  const buttons = items
    .map((a) => {
      const variant = a.variant === 'secondary' ? 'secondary' : 'primary';
      const external = /^https?:\/\//.test(a.href);
      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a class="btn btn--${variant}" href="${escapeHtml(a.href)}"${attrs}>${escapeHtml(a.label)}</a>`;
    })
    .join('\n      ');
  return `<div class="actions">\n      ${buttons}\n    </div>`;
}

const heading = (text, level = 2) =>
  text ? `<h${level}>${inline(text)}</h${level}>` : '';

const eyebrow = (text) => (text ? `<p class="eyebrow">${escapeHtml(text)}</p>` : '');

/* ── 區塊 ─────────────────────────────────────────────────── */

const blocks = {
  /** 首屏主視覺 */
  hero(b) {
    const copy = `
      ${eyebrow(b.eyebrow)}
      ${heading(b.title, 1)}
      ${b.subtitle ? `<p class="lead">${inline(b.subtitle)}</p>` : ''}
      ${actions(b.actions)}`;

    if (!b.image?.src) {
      return `<section class="hero">
  <div class="container">
    <div class="prose${b.align === 'center' ? ' prose--center' : ''}">${copy}
    </div>
  </div>
</section>`;
    }

    return `<section class="hero hero--with-image">
  <div class="container">
    <div class="hero__grid">
      <div class="prose">${copy}
      </div>
      <div class="hero__media">${image({ ...b.image, eager: true })}</div>
    </div>
  </div>
</section>`;
  },

  /** 純文字段落 */
  prose(b) {
    return `<section class="section${b.background === 'subtle' ? ' section--subtle' : ''}">
  <div class="container">
    <div class="prose${b.align === 'center' ? ' prose--center' : ''}">
      ${eyebrow(b.eyebrow)}
      ${heading(b.title)}
      ${paragraphs(b.body)}
      ${actions(b.actions)}
    </div>
  </div>
</section>`;
  },

  /** 圖文並排 */
  split(b) {
    return `<section class="section split${b.mediaPosition === 'right' ? ' split--media-right' : ''}${
      b.background === 'subtle' ? ' section--subtle' : ''
    }">
  <div class="container">
    <div class="split__grid">
      <div class="split__media">${image(b.image)}</div>
      <div class="prose">
        ${eyebrow(b.eyebrow)}
        ${heading(b.title)}
        ${paragraphs(b.body)}
        ${actions(b.actions)}
      </div>
    </div>
  </div>
</section>`;
  },

  /** 卡片列表（服務項目、作品集、文章…） */
  cards(b) {
    const items = toArray(b.items)
      .map((item) => {
        const inner = `
      ${image(item.image)}
      ${heading(item.title, 3)}
      ${item.body ? `<p>${inline(item.body)}</p>` : ''}`;
        return item.href
          ? `<a class="card" href="${escapeHtml(item.href)}">${inner}
    </a>`
          : `<article class="card">${inner}
    </article>`;
      })
      .join('\n    ');

    return `<section class="section${b.background === 'subtle' ? ' section--subtle' : ''}">
  <div class="container">
    <div class="prose${b.align === 'center' ? ' prose--center' : ''}">
      ${eyebrow(b.eyebrow)}
      ${heading(b.title)}
      ${b.body ? paragraphs(b.body) : ''}
    </div>
    <div class="cards">
    ${items}
    </div>
  </div>
</section>`;
  },

  /** 圖庫 */
  gallery(b) {
    const figures = toArray(b.images)
      .map(
        (img) => `<figure>
      ${image(img)}
      ${img.caption ? `<figcaption>${inline(img.caption)}</figcaption>` : ''}
    </figure>`
      )
      .join('\n    ');

    return `<section class="section${b.background === 'subtle' ? ' section--subtle' : ''}">
  <div class="container">
    <div class="prose">
      ${eyebrow(b.eyebrow)}
      ${heading(b.title)}
    </div>
    <div class="gallery">
    ${figures}
    </div>
  </div>
</section>`;
  },

  /** 行動呼籲 */
  cta(b) {
    return `<section class="section section--tight section--subtle">
  <div class="container">
    <div class="prose prose--center">
      ${heading(b.title)}
      ${b.body ? paragraphs(b.body) : ''}
      ${actions(b.actions)}
    </div>
  </div>
</section>`;
  },

  /**
   * 時間軸。單一時間序由新到舊，左右自動交錯 —— 新增一筆只要加一行資料，
   * 位置與間距都由版面決定，不必手動排。
   */
  timeline(b) {
    const items = toArray(b.items);
    const years = [...new Set(items.map((i) => i.date.split('.')[0]))].sort().reverse();

    const list = items
      .map((item, index) => {
        const side = index % 2 === 0 ? 'left' : 'right';
        const sub = toArray(item.items);
        return `<li class="timeline__item reveal${item.highlight ? ' timeline__item--highlight' : ''}"
        data-side="${side}" data-year="${escapeHtml(item.date.split('.')[0])}">
      <span class="timeline__marker"></span>
      <p class="timeline__date">${escapeHtml(item.date)}</p>
      <h3 class="timeline__title">${inline(item.title)}</h3>
      ${sub.length ? `<ul class="timeline__list">${sub.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}
    </li>`;
      })
      .join('\n    ');

    const filter = b.filter
      ? `<div class="timeline-filter" role="group" aria-label="依年份篩選">
      <button type="button" data-year="all" aria-pressed="true">全部</button>
      ${years.map((y) => `<button type="button" data-year="${y}" aria-pressed="false">${y} 年</button>`).join('\n      ')}
    </div>`
      : '';

    return `<section class="section${b.background === 'subtle' ? ' section--subtle' : ''}">
  <div class="container">
    <div class="prose prose--center">
      ${eyebrow(b.eyebrow)}
      ${heading(b.title)}
      ${b.body ? paragraphs(b.body) : ''}
    </div>
    ${filter}
    <ol class="timeline">
    ${list}
    </ol>
    ${b.note ? `<p class="timeline__note">${inline(b.note)}</p>` : ''}
  </div>
</section>`;
  },

  /** 圖示牆（興趣、技能） */
  'icon-grid'(b) {
    const items = toArray(b.items)
      .map(
        (item) => `<div class="icon-grid__item reveal">
        <span class="icon-grid__badge">${icon(item.icon, { size: 28 })}</span>
        <span class="icon-grid__label">${escapeHtml(item.label)}</span>
      </div>`
      )
      .join('\n      ');

    return `<section class="section${b.background === 'subtle' ? ' section--subtle' : ''}">
  <div class="container">
    <div class="prose${b.align === 'center' ? ' prose--center' : ''}">
      ${eyebrow(b.eyebrow)}
      ${heading(b.title)}
      ${b.body ? paragraphs(b.body) : ''}
    </div>
    <div class="icon-grid">
      ${items}
    </div>
  </div>
</section>`;
  },

  /** 聯絡資訊 */
  contact(b) {
    const items = toArray(b.items)
      .map((item) => {
        const value = item.href
          ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.value)}</a>`
          : escapeHtml(item.value);
        return `<div>
        <div class="contact-list__label">${escapeHtml(item.label)}</div>
        <div class="contact-list__value">${value}</div>
      </div>`;
      })
      .join('\n      ');

    return `<section class="section${b.background === 'subtle' ? ' section--subtle' : ''}">
  <div class="container">
    <div class="prose">
      ${eyebrow(b.eyebrow)}
      ${heading(b.title)}
      ${b.body ? paragraphs(b.body) : ''}
    </div>
    <div class="contact-list">
      ${items}
    </div>
  </div>
</section>`;
  },
};

export const blockNames = Object.keys(blocks);

export function renderBlock(block) {
  const fn = blocks[block?.type];
  if (!fn) throw new Error(`未知的區塊型別「${block?.type}」，可用：${blockNames.join(', ')}`);
  return fn(block);
}

/* ── 頁面骨架 ─────────────────────────────────────────────── */

function renderNav(site, currentRoute) {
  const items = toArray(site.nav)
    .map((item) => {
      const current = item.href === currentRoute ? ' aria-current="page"' : '';
      return `<li><a href="${escapeHtml(item.href)}"${current}>${escapeHtml(item.label)}</a></li>`;
    })
    .join('\n          ');
  if (!items) return '';

  return `<input type="checkbox" id="nav-toggle" class="nav-toggle">
      <label for="nav-toggle" class="nav-toggle__label" aria-label="開啟選單">☰</label>
      <nav class="site-nav" aria-label="主選單">
        <ul>
          ${items}
        </ul>
      </nav>`;
}

function renderFooter(site) {
  const social = toArray(site.social)
    .map(
      (s) =>
        `<li><a href="${escapeHtml(s.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          s.label
        )}</a></li>`
    )
    .join('\n          ');

  return `<footer class="site-footer">
    <div class="container site-footer__inner">
      <p>${inline(site.footer?.text ?? `© ${new Date().getFullYear()} ${site.title}`)}</p>
      ${social ? `<ul class="social">\n          ${social}\n        </ul>` : ''}
    </div>
  </footer>`;
}

/**
 * 頁面行為。刻意寫得很小且不依賴任何函式庫：
 *   - 捲動淡入。內容預設是看得見的（.no-js），只有在 JS 跑起來之後才轉為
 *     動畫呈現 —— 這樣即使腳本失效，也絕對不會有讀者看到空白頁面。
 *   - 時間軸的年份篩選。
 */
const BEHAVIOUR_SCRIPT = `<script>
  document.documentElement.classList.remove('no-js');

  (function () {
    var targets = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window) || !targets.length) {
      targets.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    targets.forEach(function (el) { observer.observe(el); });
  })();

  document.querySelectorAll('.timeline-filter').forEach(function (group) {
    var timeline = group.parentElement.querySelector('.timeline');
    if (!timeline) return;
    group.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-year]');
      if (!button) return;
      var year = button.dataset.year;
      group.querySelectorAll('button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === button));
      });
      timeline.querySelectorAll('.timeline__item').forEach(function (item) {
        item.hidden = year !== 'all' && item.dataset.year !== year;
      });
      // 篩選後可見項目的順序變了，左右交錯要重算。
      // 同時強制顯示：這些項目可能從未進入過視窗、淡入動畫還沒觸發，
      // 篩選後會變成「佔著位置卻看不見」，在時間軸上留下一段空白。
      var visible = 0;
      timeline.querySelectorAll('.timeline__item').forEach(function (item) {
        if (item.hidden) return;
        item.dataset.side = visible % 2 === 0 ? 'left' : 'right';
        item.classList.add('is-visible');
        visible++;
      });
    });
  });
<\/script>`;

export function renderPage({ site, page }) {
  const title = page.route === '/' ? site.title : `${page.title} — ${site.title}`;
  const description = page.description ?? site.description ?? '';
  const canonical = site.baseUrl ? new URL(page.route, site.baseUrl).toString() : '';
  const body = toArray(page.blocks).map(renderBlock).join('\n\n');

  const brand = site.logo
    ? image({ src: site.logo, alt: site.title })
    : escapeHtml(site.title);

  // 用陣列過濾而非行內三元運算，否則沒填的欄位會在 <head> 留下空行
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    description && `<meta name="description" content="${escapeHtml(description)}">`,
    canonical && `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    description && `<meta property="og:description" content="${escapeHtml(description)}">`,
    canonical && `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    page.image && `<meta property="og:image" content="${escapeHtml(page.image)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    '<link rel="stylesheet" href="/assets/styles.css">',
    site.favicon && `<link rel="icon" href="${escapeHtml(site.favicon)}">`,
  ].filter(Boolean).join('\n  ');

  return `<!doctype html>
<html lang="${escapeHtml(site.lang ?? 'zh-Hant')}" class="no-js">
<head>
  ${head}
</head>
<body>
  <a class="skip-link" href="#main">跳到主要內容</a>

  <header class="site-header">
    <div class="container site-header__inner">
      <a class="site-brand" href="/">${brand}</a>
      ${renderNav(site, page.route)}
    </div>
  </header>

  <main id="main">
${body}
  </main>

  ${renderFooter(site)}

  ${BEHAVIOUR_SCRIPT}
</body>
</html>
`;
}
