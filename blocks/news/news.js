import { resolveIndexUrl } from '../../scripts/utils/query-index.js';

const MAX_ITEMS = 3;

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

export default async function init(el) {
  // Read authored subtitle + heading from block cells
  const rows = [...el.querySelectorAll(':scope > div')];
  let subtitle = '';
  let heading = '';
  let viewAllHref = '';

  rows.forEach((row) => {
    const cells = [...row.querySelectorAll(':scope > div')];
    const text = cells[0]?.textContent?.trim() || '';
    const link = cells[0]?.querySelector('a');

    if (link && text) {
      viewAllHref = link.href;
    } else if (!heading && text) {
      if (!subtitle) {
        subtitle = text;
      } else {
        heading = text;
      }
    }
  });

  el.innerHTML = '';

  // Section header
  const header = document.createElement('div');
  header.className = 'news-header';
  header.innerHTML = `
    ${subtitle ? `<p class="news-eyebrow">${subtitle}</p>` : ''}
    ${heading ? `<h2 class="news-heading">${heading}</h2>` : ''}
  `;
  el.append(header);

  // Loading state
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

  // Sort by date descending, take MAX_ITEMS
  const items = data
    .filter((item) => item.title || item.path)
    .filter((item) => !['/news', '/news/index'].includes(item.path?.replace(/\/$/, '')))
    .sort((a, b) => {
      const da = new Date(a.date || a.lastModified || 0);
      const db = new Date(b.date || b.lastModified || 0);
      return db - da;
    })
    .slice(0, MAX_ITEMS);

  if (items.length === 0) {
    list.innerHTML = '<p class="news-error">No news articles found.</p>';
    return;
  }

  list.innerHTML = items.map(renderCard).join('');

  // "View all" link
  if (viewAllHref) {
    const cta = document.createElement('div');
    cta.className = 'news-cta';
    cta.innerHTML = `<a class="btn btn-outline news-view-all" href="${viewAllHref}">View All News</a>`;
    el.append(cta);
  }
}
