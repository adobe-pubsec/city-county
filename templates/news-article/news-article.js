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

async function buildByline(anchor) {
  const h1 = document.querySelector('main h1');
  if (!h1) return;

  const dateMeta = document.head.querySelector('meta[name="publication-date"]');
  const tagMeta = document.head.querySelector('meta[property="article:tag"]');
  if (!dateMeta && !tagMeta) return;

  const byline = document.createElement('div');
  byline.className = 'article-byline';

  let tag;
  if (tagMeta) {
    tag = document.createElement('span');
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

  // --accent (tag bg) has no guaranteed contrast relationship with
  // --primary (tag text) — must run after insertion so getComputedStyle
  // resolves the actual rendered background.
  if (tag) {
    const { applySelfColorScheme } = await import('../../blocks/section-metadata/section-metadata.js');
    applySelfColorScheme(tag);
  }
}

export default async function init() {
  const hero = buildHero();
  await buildByline(hero);
}
