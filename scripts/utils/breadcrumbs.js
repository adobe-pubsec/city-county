import { getSiteBase } from './site-config.js';
import { getColorSchemeForValue } from './color-scheme.js';

function humanize(segment) {
  return segment.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Builds and inserts a breadcrumb nav directly before <main>, for any
 * interior page — every path segment except the last becomes a linked
 * "section" crumb, and the last segment is represented by the page's own
 * <h1> text as the current (non-link) crumb. Skipped on the site's own
 * home page (no path segments beyond site-base), or when a page sets
 * `breadcrumbs: off` in its Page Metadata.
 */
export default async function buildBreadcrumbs() {
  if (document.head.querySelector('meta[name="breadcrumbs"]')?.content === 'off') return;

  const siteBase = await getSiteBase();
  const { pathname } = window.location;
  const relative = siteBase && pathname.startsWith(siteBase) ? pathname.slice(siteBase.length) : pathname;
  const parts = relative.split('/').filter(Boolean);
  if (!parts.length) return; // home page — no breadcrumbs

  const h1 = document.querySelector('main h1');
  if (!h1) return;

  const nav = document.createElement('nav');
  nav.className = 'breadcrumbs';
  nav.setAttribute('aria-label', 'Breadcrumb');

  const ol = document.createElement('ol');

  // Home — needs a trailing slash (site-base itself has none) or it doesn't resolve
  const home = document.createElement('li');
  home.innerHTML = `<a href="${siteBase ? `${siteBase}/` : '/'}">Home</a>`;
  ol.append(home);

  // Every segment except the last becomes a linked section crumb — trailing
  // slash so it loads the folder's index page (same issue as the Home link).
  for (let i = 0; i < parts.length - 1; i += 1) {
    const href = `${siteBase}/${parts.slice(0, i + 1).join('/')}/`;
    const li = document.createElement('li');
    li.innerHTML = `<a href="${href}">${humanize(parts[i])}</a>`;
    ol.append(li);
  }

  // Current page — use h1 text
  const current = document.createElement('li');
  current.setAttribute('aria-current', 'page');
  current.textContent = h1.textContent;
  ol.append(current);

  // The bar's bg is --accent; its text is --secondary/--primary — three
  // independent site colors with no guaranteed contrast relationship. Text
  // color stays branded (unlike the pill/chip fixes elsewhere, which force
  // black/white); instead, if the text itself is dark, wash the background
  // out toward white so dark-on-dark can't happen (same technique as the
  // hero's accent-needs-lift, just testing the text and adjusting the bg).
  if (getColorSchemeForValue('var(--secondary)') === 'dark-scheme') {
    nav.classList.add('bg-needs-wash');
  }

  nav.append(ol);
  document.querySelector('main')?.before(nav);
}
