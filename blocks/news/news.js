import { resolveIndexUrl, filterBySite } from '../../scripts/utils/query-index.js';
import { applySelfColorScheme } from '../section-metadata/section-metadata.js';

async function fetchNews() {
  const url = resolveIndexUrl('news');
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const json = await resp.json();
  return filterBySite(json.data || []);
}

// Google Sheets/Excel date serial epoch (days since 1899-12-30, UTC) — the
// query-index's dateValue() transform emits `date` as one of these serials,
// not a JS timestamp. `lastModified` is separately a Unix epoch in seconds.
// Passing either straight into `new Date()` silently resolves to ~1970.
const SHEET_EPOCH_MS = Date.UTC(1899, 11, 30);

function resolveDate(item) {
  if (typeof item.date === 'number') return new Date(SHEET_EPOCH_MS + (item.date * 86400000));
  if (item.date) return new Date(item.date);
  if (item.lastModified) return new Date(item.lastModified * 1000);
  return null;
}

function formatDate(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function renderCard(item) {
  const tag = (item.tags && item.tags[0]) || '';
  const date = formatDate(resolveDate(item));
  const isPlaceholder = item.image?.startsWith('/default-meta-image.png');

  return `
    <a class="news-card" href="${item.path}">
      ${item.image ? `
        <div class="news-card-image${isPlaceholder ? ' is-placeholder' : ''}">
          ${isPlaceholder ? '' : `<img src="${item.image}" alt="${item.title || ''}" loading="lazy">`}
        </div>` : ''}
      <div class="news-card-body">
        <div class="news-card-meta">
          ${tag ? `<span class="news-tag">${tag}</span>` : ''}
          ${date ? `<span class="news-date">${date}</span>` : ''}
        </div>
        <h3 class="news-card-title">${item.title || item.path}</h3>
        ${item.description ? `<p class="news-card-desc">${item.description}</p>` : ''}
      </div>
    </a>
  `;
}

function getLimit(el) {
  const rows = [...el.querySelectorAll(':scope > div')];
  const row = rows.find((r) => {
    const key = r.querySelector(':scope > div')?.textContent?.trim().toLowerCase();
    return key === 'limit';
  });
  const value = row?.querySelectorAll(':scope > div')[1]?.textContent?.trim();
  const limit = parseInt(value, 10);
  // No row, non-numeric, or 0 all mean "no limit" — slice(0, undefined) returns everything
  return Number.isNaN(limit) || limit <= 0 ? undefined : limit;
}

export default async function init(el) {
  const limit = getLimit(el);
  el.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'news-list';
  el.append(list);

  let data;
  try {
    data = await fetchNews();
  } catch {
    list.innerHTML = '<p class="news-error">News is temporarily unavailable.</p>';
    return;
  }

  // Sort by date descending, take the authored limit
  const items = data
    .filter((item) => item.title || item.path)
    .filter((item) => !['/news', '/news/index'].includes(item.path?.replace(/\/$/, '')))
    .sort((a, b) => (resolveDate(b)?.getTime() || 0) - (resolveDate(a)?.getTime() || 0))
    .slice(0, limit);

  if (items.length === 0) {
    list.innerHTML = '<p class="news-error">No news articles found.</p>';
    return;
  }

  list.innerHTML = items.map(renderCard).join('');

  // --accent (tag bg) has no guaranteed contrast relationship with
  // --primary (tag text) — pick readable text off the tag's actual
  // rendered background instead.
  list.querySelectorAll('.news-tag').forEach(applySelfColorScheme);
}
