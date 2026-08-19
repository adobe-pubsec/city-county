import { filterBySite } from '../../scripts/utils/query-index.js';
import { getSiteBase } from '../../scripts/utils/site-config.js';

const INDEX_URL = '/query-index.json';
const PAGE_SIZE = 10;

async function fetchIndex() {
  const resp = await fetch(INDEX_URL);
  if (!resp.ok) throw new Error(`Failed to load index: ${resp.status}`);
  const json = await resp.json();
  return filterBySite(json.data || []);
}

function score(item, terms) {
  const title = (item.title || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  const path = (item.path || '').toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (title.includes(term)) total += 3;
    else if (desc.includes(term)) total += 2;
    else if (path.includes(term)) total += 1;
  }
  return total;
}

function highlight(text, terms) {
  if (!text) return '';
  let result = text;
  for (const term of terms) {
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(re, '<mark>$1</mark>');
  }
  return result;
}

// Derives a display label for the breadcrumb root from the site's slug,
// e.g. site-base "/sites/wake-county" -> "Wake County".
function siteLabelFromBase(siteBase) {
  const slug = siteBase.split('/').filter(Boolean).pop();
  if (!slug) return 'Home';
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function breadcrumb(path, siteBase, siteLabel) {
  const relative = siteBase && path.startsWith(siteBase) ? path.slice(siteBase.length) : path;
  const parts = relative.split('/').filter(Boolean);
  const labels = parts.map((p) => p.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
  return [siteLabel, ...labels].join(' › ');
}

function renderResult(item, terms, siteBase, siteLabel) {
  const el = document.createElement('a');
  el.className = 'sr-result';
  el.href = item.path;

  const title = highlight(item.title || item.path, terms);
  const desc = item.description ? highlight(item.description, terms) : '';

  el.innerHTML = `
    <div class="sr-result-path">${breadcrumb(item.path, siteBase, siteLabel)}</div>
    <div class="sr-result-title">${title}</div>
    ${desc ? `<div class="sr-result-desc">${desc}</div>` : ''}
  `;
  return el;
}

function buildForm(query) {
  const form = document.createElement('form');
  form.className = 'sr-form';
  form.setAttribute('method', 'get');
  form.setAttribute('action', '/search');
  form.setAttribute('role', 'search');
  form.setAttribute('aria-label', 'Refine search');

  form.innerHTML = `
    <div class="sr-field">
      <span class="material-symbols-outlined sr-icon" aria-hidden="true">search</span>
      <input
        type="search"
        name="q"
        value="${(query || '').replace(/"/g, '&quot;')}"
        placeholder="Search city services..."
        class="sr-input"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search"
      >
      <button type="submit" class="sr-btn btn btn-primary">Search</button>
    </div>
  `;
  return form;
}

export default async function init(el) {
  const params = new URLSearchParams(window.location.search);
  const query = (params.get('q') || '').trim();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  el.innerHTML = '';
  el.append(buildForm(query));

  const status = document.createElement('p');
  status.className = 'sr-status';
  el.append(status);

  if (!query) {
    status.textContent = 'Enter a search term to find city services, news, events, and more.';
    return;
  }

  status.textContent = 'Searching…';
  status.setAttribute('aria-live', 'polite');

  let data;
  try {
    data = await fetchIndex();
  } catch {
    status.textContent = 'Search is temporarily unavailable. Please try again later.';
    return;
  }

  const siteBase = await getSiteBase();
  const siteLabel = siteLabelFromBase(siteBase);

  const results = data
    .map((item) => ({ ...item, _score: score(item, terms) }))
    .filter((item) => item._score > 0)
    .sort((a, b) => b._score - a._score);

  if (results.length === 0) {
    status.innerHTML = `No results found for <strong>"${query}"</strong>. Try different keywords.`;
    return;
  }

  status.innerHTML = `<strong>${results.length}</strong> result${results.length === 1 ? '' : 's'} for <strong>"${query}"</strong>`;

  const list = document.createElement('div');
  list.className = 'sr-list';
  el.append(list);

  let shown = 0;
  function showPage() {
    const page = results.slice(shown, shown + PAGE_SIZE);
    page.forEach((item) => list.append(renderResult(item, terms, siteBase, siteLabel)));
    shown += page.length;

    if (moreBtn) {
      if (shown >= results.length) {
        moreBtn.remove();
      } else {
        moreBtn.textContent = `Show more (${results.length - shown} remaining)`;
      }
    }
  }

  let moreBtn;
  if (results.length > PAGE_SIZE) {
    moreBtn = document.createElement('button');
    moreBtn.className = 'sr-more btn';
    moreBtn.addEventListener('click', showPage);
    el.append(moreBtn);
  }

  showPage();
}
