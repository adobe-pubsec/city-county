async function buildBreadcrumbs() {
  const { getSiteBase } = await import('../../scripts/utils/site-config.js');
  const siteBase = await getSiteBase();
  const { pathname } = window.location;
  const relative = siteBase && pathname.startsWith(siteBase) ? pathname.slice(siteBase.length) : pathname;
  const parts = relative.split('/').filter(Boolean);
  // e.g. ['news', 'downtown-revitalization']

  const nav = document.createElement('nav');
  nav.className = 'article-breadcrumbs';
  nav.setAttribute('aria-label', 'Breadcrumb');

  const ol = document.createElement('ol');

  // Home
  const home = document.createElement('li');
  home.innerHTML = `<a href="${siteBase || '/'}">Home</a>`;
  ol.append(home);

  // Section (news / events)
  if (parts[0]) {
    const section = document.createElement('li');
    const label = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    section.innerHTML = `<a href="${siteBase}/${parts[0]}">${label}</a>`;
    ol.append(section);
  }

  // Current page — use h1 text
  const h1 = document.querySelector('main h1');
  if (h1) {
    const current = document.createElement('li');
    current.setAttribute('aria-current', 'page');
    current.textContent = h1.textContent;
    ol.append(current);
  }

  nav.append(ol);
  document.querySelector('main')?.before(nav);
}

function buildHero() {
  const container = document.querySelector('.news-article-template main > div:first-child > .default-content');
  const h1 = container?.querySelector('h1');
  const picP = container?.querySelector(':scope > p:first-child:has(picture)');
  if (!container || !h1 || !picP) return null;

  const hero = document.createElement('div');
  hero.className = 'article-hero';

  const gradient = document.createElement('div');
  gradient.className = 'article-hero-gradient';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'article-hero-title';
  titleWrap.append(h1);

  hero.append(picP.querySelector('picture'), gradient, titleWrap);
  picP.replaceWith(hero);
  return hero;
}

function buildByline(anchor) {
  const h1 = document.querySelector('main h1');
  if (!h1) return;

  const dateMeta = document.head.querySelector('meta[name="publication-date"]');
  const tagMeta = document.head.querySelector('meta[property="article:tag"]');
  if (!dateMeta && !tagMeta) return;

  const byline = document.createElement('div');
  byline.className = 'article-byline';

  if (tagMeta) {
    const tag = document.createElement('span');
    tag.className = 'article-tag';
    tag.textContent = tagMeta.content;
    byline.append(tag);
  }

  if (dateMeta) {
    // Handles MM-DD-YYYY, YYYY-MM-DD, and a full YYYY-MM-DDTHH:mm datetime
    // (as produced by the date-inserter tool)
    const raw = dateMeta.content;
    const date = document.createElement('time');
    date.className = 'article-date';
    try {
      // MM-DD-YYYY → YYYY-MM-DD for Date parsing
      const normalized = raw.match(/^\d{2}-\d{2}-\d{4}$/)
        ? (() => { const [mm, dd, yyyy] = raw.split('-'); return `${yyyy}-${mm}-${dd}`; })()
        : raw;
      // A bare YYYY-MM-DD is parsed as UTC midnight, which toLocaleDateString
      // then shifts back a day in negative-UTC-offset timezones — force
      // local midnight instead. A full datetime (has "T") is used as-is.
      const isoLocal = normalized.includes('T') ? normalized : `${normalized}T00:00:00`;
      date.textContent = new Date(isoLocal).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
      });
    } catch {
      date.textContent = raw;
    }
    byline.append(date);
  }

  (anchor || h1).after(byline);
}

export default async function init() {
  await buildBreadcrumbs();
  const hero = buildHero();
  buildByline(hero);
}
