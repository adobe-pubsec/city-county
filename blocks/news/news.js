import { resolveIndexUrl } from '../../scripts/utils/query-index.js';

async function fetchNews() {
  const url = await resolveIndexUrl('news');
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const json = await resp.json();
  return json.data || [];
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function renderCard(item) {
  const tag = (item.tags && item.tags[0]) || '';
  const date = formatDate(item.date || item.lastModified);
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
    .sort((a, b) => {
      const da = new Date(a.date || a.lastModified || 0);
      const db = new Date(b.date || b.lastModified || 0);
      return db - da;
    })
    .slice(0, limit);

  if (items.length === 0) {
    list.innerHTML = '<p class="news-error">No news articles found.</p>';
    return;
  }

  list.innerHTML = items.map(renderCard).join('');
}
