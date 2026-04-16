import { resolveIndexUrl } from '../../scripts/utils/query-index.js';

const ITEMS_PER_PAGE = 6;

function slugToTitle(path) {
  return path.split('/').pop()
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatDate(raw) {
  if (!raw) return '';
  // Normalise MM-DD-YYYY → YYYY-MM-DD
  const normalized = raw.match(/^\d{2}-\d{2}-\d{4}$/)
    ? (() => { const [mm, dd, yyyy] = raw.split('-'); return `${yyyy}-${mm}-${dd}`; })()
    : raw;
  const d = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function imageUrl(raw) {
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  // DA Live media paths: /org/repo/media/... → https://content.da.live/...
  return `https://content.da.live${raw}`;
}

async function fetchNews() {
  const url = await resolveIndexUrl('news');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('index unavailable');
  const { data = [] } = await resp.json();
  return data
    .sort((a, b) => {
      const toMs = (s) => {
        if (!s) return 0;
        const norm = s.match(/^\d{2}-\d{2}-\d{4}$/)
          ? (() => { const [mm, dd, yyyy] = s.split('-'); return `${yyyy}-${mm}-${dd}`; })()
          : s;
        return new Date(norm).getTime() || 0;
      };
      return toMs(b.date) - toMs(a.date);
    });
}

function buildCard(item) {
  const title = item.title || slugToTitle(item.path);
  const date = formatDate(item.date);
  const img = imageUrl(item.image);

  const card = document.createElement('a');
  card.className = 'nl-card';
  card.href = item.path;

  if (img) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'nl-card-img';
    imgWrap.innerHTML = `<img src="${img}" alt="${title}" loading="lazy">`;
    card.append(imgWrap);
  }

  const body = document.createElement('div');
  body.className = 'nl-card-body';

  if (date) {
    const time = document.createElement('time');
    time.className = 'nl-card-date';
    time.textContent = date;
    body.append(time);
  }

  const h3 = document.createElement('h3');
  h3.className = 'nl-card-title';
  h3.textContent = title;
  body.append(h3);

  if (item.description) {
    const p = document.createElement('p');
    p.className = 'nl-card-desc';
    p.textContent = item.description;
    body.append(p);
  }

  const readMore = document.createElement('span');
  readMore.className = 'nl-read-more';
  readMore.textContent = 'Read more →';
  body.append(readMore);

  card.append(body);
  return card;
}

function buildPagination(current, total, onNav) {
  if (total <= 1) return null;

  const nav = document.createElement('nav');
  nav.className = 'nl-pagination';
  nav.setAttribute('aria-label', 'News pages');

  const addBtn = (label, page, disabled, active) => {
    const btn = document.createElement('button');
    btn.className = `nl-page-btn${active ? ' is-active' : ''}`;
    btn.textContent = label;
    btn.setAttribute('aria-label', `Page ${page}`);
    if (active) btn.setAttribute('aria-current', 'page');
    if (disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => onNav(page));
    }
    nav.append(btn);
  };

  const addEllipsis = () => {
    const span = document.createElement('span');
    span.className = 'nl-page-ellipsis';
    span.textContent = '…';
    nav.append(span);
  };

  addBtn('‹', current - 1, current === 1, false);

  let lastPrinted = 0;
  for (let i = 1; i <= total; i++) {
    const show = i === 1 || i === total || (i >= current - 2 && i <= current + 2);
    if (show) {
      if (lastPrinted && i - lastPrinted > 1) addEllipsis();
      addBtn(i, i, false, i === current);
      lastPrinted = i;
    }
  }

  addBtn('›', current + 1, current === total, false);
  return nav;
}

export default async function init(el) {
  el.innerHTML = '';
  const status = document.createElement('p');
  status.className = 'nl-status';
  status.textContent = 'Loading…';
  el.append(status);

  let allNews;
  try {
    allNews = await fetchNews();
  } catch {
    status.textContent = 'News is temporarily unavailable.';
    return;
  }

  status.remove();

  if (!allNews.length) {
    const empty = document.createElement('p');
    empty.className = 'nl-status';
    empty.textContent = 'No news articles found.';
    el.append(empty);
    return;
  }

  const totalPages = Math.ceil(allNews.length / ITEMS_PER_PAGE);

  const grid = document.createElement('div');
  grid.className = 'nl-grid';
  el.append(grid);

  const paginationSlot = document.createElement('div');
  paginationSlot.className = 'nl-pagination-wrap';
  el.append(paginationSlot);

  function render(page) {
    const start = (page - 1) * ITEMS_PER_PAGE;
    const items = allNews.slice(start, start + ITEMS_PER_PAGE);

    grid.innerHTML = '';
    items.forEach((item) => grid.append(buildCard(item)));

    paginationSlot.innerHTML = '';
    const pag = buildPagination(page, totalPages, (next) => {
      render(next);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    if (pag) paginationSlot.append(pag);
  }

  render(1);
}
