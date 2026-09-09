/**
 * render.mjs — 把 content/ 的 JSON 內容渲染成語意化的 HTML。
 * 零相依，所以 Docker 建置階段不需要 npm install。
 */

import { icon, brandIcon } from './icons.mjs';

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
  // 保留原文的硬斷行 —— 原站有些段落是刻意斷在特定位置的
  return escapeHtml(text)
    .replace(/\n/g, '<br>')
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

/**
 * 社群連結列。圖示只是視覺，真正的名稱放在 aria-label 與 title，
 * 螢幕閱讀器與滑鼠停留都拿得到。
 */
function renderSocialRow(items, className = 'social-row') {
  const links = toArray(items)
    .filter((item) => item.href && item.icon)
    .map(
      (item) =>
        `<li><a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer" ` +
        `aria-label="${escapeHtml(item.label)}" title="${escapeHtml(item.label)}">` +
        `${brandIcon(item.icon, { size: 20 })}</a></li>`
    )
    .join('\n        ');
  return links ? `<ul class="${className}">\n        ${links}\n      </ul>` : '';
}

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

  /** 首屏封面：背景照 + Logo + 頭像 */
  cover(b) {
    // 疊圖層要單獨包一層 stage：直接貼齊 .cover 的話，會連姓名那一段的高度
    // 一起算進去，頭像的位置就會往下跑而壓到姓名。
    return `<section class="cover">
  <div class="cover__stage">
    ${b.background?.src ? `<div class="cover__bg">${image({ ...b.background, eager: true })}</div>` : ''}
    <div class="container cover__inner">
      ${b.logo?.src ? `<div class="cover__logo">${image({ ...b.logo, eager: true })}</div>` : ''}
      ${b.tagline ? `<p class="cover__tagline">${escapeHtml(b.tagline)}</p>` : ''}
    </div>
    ${b.avatar?.src ? `<div class="cover__avatar">${image({ ...b.avatar, eager: true })}</div>` : ''}
  </div>
  ${b.name ? `<h1 class="cover__name">${inline(b.name)}</h1>` : ''}
</section>`;
  },

  /** 自介：左側敘述，右側身份與社群 */
  profile(b) {
    const highlights = toArray(b.highlights)
      .map((x) => `<li>${inline(x)}</li>`)
      .join('\n        ');
    const roles = toArray(b.roles)
      .map((x) => `<li>${inline(x)}</li>`)
      .join('\n        ');

    return `<section class="section">
  <div class="container">
    <div class="prose"><h2>${escapeHtml(b.title ?? 'ABOUT ME')}</h2></div>
    <div class="profile">
      <div class="profile__bio reveal">
        ${paragraphs(b.body)}
      </div>
      <div class="profile__side reveal">
        ${renderSocialRow(b.social)}
        ${highlights ? `<ul class="profile__highlights">\n        ${highlights}\n      </ul>` : ''}
        ${roles ? `<ul class="profile__roles">\n        ${roles}\n      </ul>` : ''}
        ${b.note ? `<p class="profile__note">${inline(b.note)}</p>` : ''}
        ${
          b.noteAction
            ? `<a class="mail-link" href="${escapeHtml(b.noteAction.href)}">` +
              `${icon(b.noteAction.icon ?? 'mail', { size: 18 })}` +
              `<span>${escapeHtml(b.noteAction.label)}</span></a>`
            : ''
        }
      </div>
    </div>
  </div>
</section>`;
  },

  /** 品牌標誌列 */
  logos(b) {
    const items = toArray(b.items)
      .map(
        (item) => `<li class="logos__item${item.label ? ' logos__item--named' : ''} reveal">
        ${image(item)}
        ${item.label ? `<span class="logos__label">${inline(item.label)}</span>` : ''}
      </li>`
      )
      .join('\n      ');

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
  <div class="container">
    <div class="prose"><h2>${escapeHtml(b.title ?? 'BRAND')}</h2></div>
    <ul class="logos">
      ${items}
    </ul>
  </div>
</section>`;
  },

  /** 經歷 */
  experience(b) {
    const items = toArray(b.items)
      .map((item) => {
        const org = item.href
          ? `<a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.org)}</a>`
          : escapeHtml(item.org ?? '');
        return `<li class="experience__item reveal">
        <h3 class="experience__role">${inline(item.role)}</h3>
        ${org ? `<p class="experience__org">${org}</p>` : ''}
        <p class="experience__period">${escapeHtml(item.period ?? '')}</p>
      </li>`;
      })
      .join('\n      ');

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
  <div class="container">
    <div class="prose"><h2>${escapeHtml(b.title ?? 'EXPERIENCE')}</h2></div>
    <ul class="experience">
      ${items}
    </ul>
  </div>
</section>`;
  },

  /** 文章頁抬頭：標題、日期、閱讀時間、封面 */
  'post-header'(b) {
    const date = b.published ? new Date(b.published) : null;
    const iso = date ? date.toISOString().slice(0, 10) : '';
    const shown = date
      ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
      : '';

    const meta = [
      shown ? `<time datetime="${iso}">${shown}</time>` : '',
      b.readTime ? `<span>${escapeHtml(b.readTime)}</span>` : '',
    ]
      .filter(Boolean)
      .join('<span aria-hidden="true">·</span>');

    return `<article class="post">
  <header class="post__header">
    <div class="container post__head-inner">
      <a class="post__back" href="/blog">← 回部落格</a>
      <h1>${inline(b.title)}</h1>
      ${meta ? `<p class="post__meta">${meta}</p>` : ''}
    </div>
  </header>
  ${b.cover?.src ? `<div class="container"><div class="post__cover">${image({ ...b.cover, eager: true })}</div></div>` : ''}`;
  },

  /** 文章內文：把節點陣列渲染成語意化 HTML */
  article(b) {
    const nodes = toArray(b.nodes)
      .map((node) => {
        switch (node.t) {
          case 'h2':
          case 'h3':
            return `<${node.t}>${inline(node.text)}</${node.t}>`;
          case 'ul':
          case 'ol':
            return `<${node.t}>${toArray(node.items)
              .map((x) => `<li>${inline(x)}</li>`)
              .join('')}</${node.t}>`;
          case 'img':
            // 文章裡的圖點一下可以放大看（原站也是這個行為）
            return `<figure>${image(node, ' class="zoomable" tabindex="0" role="button"' +
              ' aria-label="放大檢視圖片"')}${
              node.caption ? `<figcaption>${inline(node.caption)}</figcaption>` : ''
            }</figure>`;
          case 'quote':
            return `<blockquote>${inline(node.text)}</blockquote>`;
          case 'hr':
            return '<hr>';
          default:
            return `<p>${inline(node.text)}</p>`;
        }
      })
      .join('\n      ');

    return `  <div class="container">
    <div class="post__body">
      ${nodes}
    </div>
  </div>
</article>`;
  },

  /** 純文字段落。level 用來指定標題階層 —— 每頁應該剛好有一個 h1。 */
  prose(b) {
    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
  <div class="container">
    <div class="prose${b.align === 'center' ? ' prose--center' : ''}">
      ${eyebrow(b.eyebrow)}
      ${heading(b.title, b.level ?? 2)}
      ${paragraphs(b.body)}
      ${actions(b.actions)}
    </div>
  </div>
</section>`;
  },

  /** 圖文並排 */
  split(b) {
    return `<section class="section split${b.mediaPosition === 'right' ? ' split--media-right' : ''}${
      b.background ? ` section--${b.background}` : ''
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
      ${item.meta ? `<p class="card__meta">${escapeHtml(item.meta)}</p>` : ''}
      ${heading(item.title, 3)}
      ${item.body ? `<p>${inline(item.body)}</p>` : ''}`;
        return item.href
          ? `<a class="card" href="${escapeHtml(item.href)}">${inner}
    </a>`
          : `<article class="card">${inner}
    </article>`;
      })
      .join('\n    ');

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
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

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
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

    // 年份可以逐年列，也可以照 filterGroups 分成區間 —— 年份一多，
    // 一年一顆按鈕會排滿整列反而難挑。
    const groups = toArray(b.filterGroups);
    const buttons = groups.length
      ? groups
          .map(
            (g) =>
              `<button type="button" data-from="${g.from}" data-to="${g.to}" aria-pressed="false">` +
              `${escapeHtml(g.label)}</button>`
          )
          .join('\n      ')
      : years
          .map((y) => `<button type="button" data-from="${y}" data-to="${y}" aria-pressed="false">${y} 年</button>`)
          .join('\n      ');

    const filter = b.filter
      ? `<div class="timeline-filter" role="group" aria-label="依年份篩選">
      <button type="button" data-all="true" aria-pressed="true">全部</button>
      ${buttons}
    </div>`
      : '';

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
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

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
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

  /**
   * 聯絡區：左側快速聯絡資訊，右側表單（對齊原站的 QUICK ID + CONTACT ME）。
   *
   * 靜態網站本身不能寄信。設定了 endpoint 就 POST 給表單服務；沒設定時退回
   * mailto —— 送出會開啟訪客的郵件軟體並帶好內容，今天就能用，之後接上服務
   * 只要在 site.json 補一個網址，版面完全不用動。
   */
  contact(b) {
    const items = toArray(b.items)
      .map((item) => {
        const value = item.href
          ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.value)}</a>`
          : escapeHtml(item.value);
        return `<div class="contact-list__row">
        ${item.icon ? `<span class="contact-list__icon">${icon(item.icon, { size: 20 })}</span>` : ''}
        <div>
          <div class="contact-list__label">${escapeHtml(item.label)}</div>
          <div class="contact-list__value">${value}</div>
        </div>
      </div>`;
      })
      .join('\n      ');

    const endpoint = b.endpoint || '';
    const mailto = b.email ? `mailto:${b.email}` : '';
    const field = (name, label, type = 'text') =>
      `<label class="field">
          <span class="field__label">${escapeHtml(label)}</span>
          <input class="field__input" type="${type}" name="${name}" ${
            name === 'message' ? '' : 'required'
          }>
        </label>`;

    const form = b.form === false ? '' : `<form class="contact-form"${
      endpoint ? ` action="${escapeHtml(endpoint)}" method="POST"` : ` action="${escapeHtml(mailto)}" method="POST" enctype="text/plain"`
    }>
        <h3>${escapeHtml(b.formTitle ?? 'CONTACT ME')}</h3>
        <div class="contact-form__row">
          ${field('first_name', 'First Name')}
          ${field('last_name', 'Last Name')}
        </div>
        ${field('email', 'Email', 'email')}
        ${field('subject', 'Subject')}
        <label class="field">
          <span class="field__label">Message</span>
          <textarea class="field__input" name="message" rows="4"></textarea>
        </label>
        <button class="btn btn--primary" type="submit">Submit</button>
      </form>`;

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
  <div class="container">
    <div class="contact-grid">
      <div class="contact-grid__info">
        ${eyebrow(b.eyebrow)}
        ${heading(b.title)}
        ${b.body ? paragraphs(b.body) : ''}
        <div class="contact-list">
      ${items}
        </div>
        ${
          b.social?.length
            ? `<div class="contact-follow">
          ${b.socialTitle ? `<p class="contact-follow__label">${escapeHtml(b.socialTitle)}</p>` : ''}
          ${renderSocialRow(b.social)}
        </div>`
            : ''
        }
      </div>
      ${form}
    </div>
  </div>
</section>`;
  },

  /** 電子報訂閱條 */
  newsletter(b) {
    const endpoint = b.endpoint || '';
    const mailto = b.email ? `mailto:${b.email}?subject=${encodeURIComponent(b.subject ?? '訂閱電子報')}` : '';
    return `<section class="section section--tight${b.background ? ` section--${b.background}` : ''}">
  <div class="container newsletter">
    <h2 class="newsletter__title">${inline(b.title)}</h2>
    <form class="newsletter__form"${
      endpoint ? ` action="${escapeHtml(endpoint)}" method="POST"` : ` action="${escapeHtml(mailto)}" method="POST" enctype="text/plain"`
    }>
      <label class="field field--inline">
        <span class="sr-only">E-mail</span>
        <input class="field__input" type="email" name="email" placeholder="E-mail" required>
      </label>
      <button class="btn btn--primary" type="submit">${escapeHtml(b.action ?? '訂閱')}</button>
    </form>
  </div>
</section>`;
  },

  /** 聯絡資訊（僅清單，無表單） */
  'contact-list'(b) {
    const items = toArray(b.items)
      .map((item) => {
        const value = item.href
          ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.value)}</a>`
          : escapeHtml(item.value);
        return `<div class="contact-list__row">
        ${item.icon ? `<span class="contact-list__icon">${icon(item.icon, { size: 20 })}</span>` : ''}
        <div>
          <div class="contact-list__label">${escapeHtml(item.label)}</div>
          <div class="contact-list__value">${value}</div>
        </div>
      </div>`;
      })
      .join('\n      ');

    return `<section class="section${b.background ? ` section--${b.background}` : ''}">
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
  const social = renderSocialRow(site.social, 'social-row');

  return `<footer class="site-footer">
    <div class="container site-footer__inner">
      <p>${inline(site.footer?.text ?? `© ${new Date().getFullYear()} ${site.title}`)}</p>
      ${social}
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
    var pending = [].slice.call(document.querySelectorAll('.reveal'));
    if (!pending.length) return;

    // 掃過一遍，把已經到達視窗下緣的項目顯示出來。
    // 不用 IntersectionObserver 當唯一機制：快速捲動或按 End 鍵時它會跳過元素，
    // 那些項目就會永遠停在透明狀態，佔著位置卻看不見。
    function sweep() {
      var limit = window.innerHeight + 80;
      pending = pending.filter(function (el) {
        if (el.getBoundingClientRect().top > limit) return true;
        el.classList.add('is-visible');
        return false;
      });
      if (!pending.length) {
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
      }
    }

    var queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; sweep(); });
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    sweep();
  })();

  document.querySelectorAll('.timeline-filter').forEach(function (group) {
    var timeline = group.parentElement.querySelector('.timeline');
    if (!timeline) return;
    group.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      var all = button.dataset.all === 'true';
      var from = Number(button.dataset.from);
      var to = Number(button.dataset.to);
      group.querySelectorAll('button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === button));
      });
      timeline.querySelectorAll('.timeline__item').forEach(function (item) {
        var year = Number(item.dataset.year);
        item.hidden = !all && (year < from || year > to);
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

  // 文章內的圖片點一下放大：疊一層全螢幕檢視，再點一下或按 Esc 關閉。
  (function () {
    var box = null;
    var full = null;
    var lastFocus = null;

    function build() {
      box = document.createElement('div');
      box.className = 'lightbox';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', '圖片檢視');
      full = document.createElement('img');
      box.appendChild(full);
      box.addEventListener('click', close);
      document.body.appendChild(box);
    }

    function open(img) {
      if (!box) build();
      full.src = img.currentSrc || img.src;
      full.alt = img.alt || '';
      lastFocus = document.activeElement;
      box.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      box.focus();
    }

    function close() {
      if (!box) return;
      box.classList.remove('is-open');
      document.body.style.overflow = '';
      full.removeAttribute('src');
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    document.addEventListener('click', function (e) {
      var img = e.target.closest && e.target.closest('.zoomable');
      if (img) open(img);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') return close();
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var img = e.target.closest && e.target.closest('.zoomable');
      if (img) { e.preventDefault(); open(img); }
    });
  })();
<\/script>`;

/**
 * 結構化資料（JSON-LD）。這是搜尋引擎與 AI 判斷「這個站是誰的」的主要依據：
 * Person 的 sameAs 把各社群帳號串成同一個人，文章則標明作者、日期與摘要，
 * 被引用時才有明確的出處可依。
 */
function renderJsonLd({ site, page }) {
  const url = (route) => (site.baseUrl ? new URL(route, site.baseUrl).toString() : route);

  const person = {
    '@type': 'Person',
    '@id': `${url('/')}#person`,
    name: site.title,
    url: url('/'),
    ...(site.description ? { description: site.description } : {}),
    ...(site.logo ? { image: url(site.logo) } : {}),
    ...(toArray(site.social).length
      ? { sameAs: toArray(site.social).map((s) => s.href) }
      : {}),
  };

  const graph = [person];

  if (page.layout === 'post') {
    graph.push({
      '@type': 'BlogPosting',
      headline: page.title,
      ...(page.description ? { description: page.description } : {}),
      ...(page.published ? { datePublished: page.published } : {}),
      ...(page.updated ? { dateModified: page.updated } : {}),
      ...(page.cover?.src ? { image: url(page.cover.src) } : {}),
      author: { '@id': person['@id'] },
      publisher: { '@id': person['@id'] },
      mainEntityOfPage: url(page.route),
      inLanguage: site.lang ?? 'zh-Hant',
    });
  } else if (page.event) {
    // 活動頁補上 Event：Google 的活動搜尋與 AI 都靠這段判斷時間地點。
    const e = page.event;
    graph.push({
      '@type': 'Event',
      name: e.name ?? page.title,
      ...(page.description ? { description: page.description } : {}),
      ...(e.startDate ? { startDate: e.startDate } : {}),
      ...(e.endDate ? { endDate: e.endDate } : {}),
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      ...(e.location ? { location: { '@type': 'Place', name: e.location } } : {}),
      ...(e.organizer ? { organizer: { '@type': 'Organization', name: e.organizer } } : {}),
      ...(e.image ? { image: url(e.image) } : {}),
      ...(e.price
        ? {
            offers: {
              '@type': 'Offer',
              price: e.price,
              priceCurrency: e.currency ?? 'TWD',
              url: url(page.route),
              availability: 'https://schema.org/InStock',
            },
          }
        : {}),
      performer: { '@id': person['@id'] },
      url: url(page.route),
      inLanguage: site.lang ?? 'zh-Hant',
    });
  } else {
    graph.push({
      '@type': 'WebSite',
      url: url('/'),
      name: site.title,
      ...(site.description ? { description: site.description } : {}),
      publisher: { '@id': person['@id'] },
      inLanguage: site.lang ?? 'zh-Hant',
    });
  }

  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })
    .replace(/</g, '\\u003C');
  return `<script type="application/ld+json">${json}</script>`;
}

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
    `<link rel="stylesheet" href="${escapeHtml(site.stylesheet ?? '/assets/styles.css')}">`,
    site.favicon && `<link rel="icon" href="${escapeHtml(site.favicon)}">`,
    renderJsonLd({ site, page }),
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
