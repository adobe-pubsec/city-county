function buildBreadcrumbs() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  // e.g. ['events', 'city-council-meeting-may']

  const nav = document.createElement('nav');
  nav.className = 'article-breadcrumbs';
  nav.setAttribute('aria-label', 'Breadcrumb');

  const ol = document.createElement('ol');

  // Home
  const home = document.createElement('li');
  home.innerHTML = '<a href="/">Home</a>';
  ol.append(home);

  // Section (events)
  if (parts[0]) {
    const section = document.createElement('li');
    const label = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    section.innerHTML = `<a href="/${parts[0]}">${label}</a>`;
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

function formatDate(raw) {
  if (!raw) return null;
  try {
    // Accepts YYYY-MM-DD or MM-DD-YYYY
    const normalized = raw.match(/^\d{2}-\d{2}-\d{4}$/)
      ? raw.split('-').reverse().join('-')
      : raw;
    return new Date(`${normalized}T00:00:00`).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  } catch {
    return raw;
  }
}

function formatTime(raw) {
  if (!raw) return null;
  try {
    // Accepts HH:MM (24-hour)
    const [h, m] = raw.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
  } catch {
    return raw;
  }
}

function buildEventInfoBar() {
  const h1 = document.querySelector('main h1');
  if (!h1) return;

  const get = (name) => document.head.querySelector(`meta[name="${name}"]`)?.content;

  const startDate = get('start-date');
  const startTime = get('start-time');
  const endDate = get('end-date');
  const endTime = get('end-time');
  const location = get('location');

  if (!startDate && !startTime && !location) return;

  const bar = document.createElement('div');
  bar.className = 'event-info-bar';

  // Chip / category tag
  const tagMeta = document.head.querySelector('meta[property="article:tag"]');
  if (tagMeta) {
    const chip = document.createElement('span');
    chip.className = 'event-chip';
    chip.textContent = tagMeta.content;
    bar.append(chip);
  }

  // Date
  if (startDate) {
    const item = document.createElement('div');
    item.className = 'event-meta-item';
    let dateText = formatDate(startDate);
    if (endDate && endDate !== startDate) {
      dateText += ` – ${formatDate(endDate)}`;
    }
    item.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">calendar_today</span><span>${dateText}</span>`;
    bar.append(item);
  }

  // Time
  if (startTime) {
    const item = document.createElement('div');
    item.className = 'event-meta-item';
    let timeText = formatTime(startTime);
    if (endTime) {
      timeText += ` – ${formatTime(endTime)}`;
    }
    item.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">schedule</span><span>${timeText}</span>`;
    bar.append(item);
  }

  // Location
  if (location) {
    const item = document.createElement('div');
    item.className = 'event-meta-item';
    item.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">location_on</span><span>${location}</span>`;
    bar.append(item);
  }

  h1.after(bar);
}

function buildAutoHero() {
  const main = document.querySelector('main');
  if (!main) return;

  // Prefer <picture>, fall back to standalone <img> not inside a block or picture
  let target = [...main.querySelectorAll('picture')].find(
    (p) => !p.closest('.block'),
  );
  if (!target) {
    target = [...main.querySelectorAll('img:not(picture img)')].find(
      (img) => !img.closest('.block'),
    );
  }
  if (!target) return;

  // Capture parent references BEFORE moving the element
  const parentP = target.parentElement?.tagName === 'P' ? target.parentElement : null;
  const sectionDiv = parentP?.closest('main > div') ?? target.closest('main > div');

  // Boost as LCP candidate
  const img = target.tagName === 'IMG' ? target : target.querySelector('img');
  if (img) {
    img.removeAttribute('loading');
    img.fetchPriority = 'high';
  }

  // Wrap in hero container and prepend to main
  // Must set display explicitly — styles.css hides all main > div by default
  // and loadArea() has already run by the time the template init fires.
  const heroWrap = document.createElement('div');
  heroWrap.className = 'event-auto-hero';
  heroWrap.style.display = 'block';
  heroWrap.append(target);
  main.prepend(heroWrap);

  // Clean up the now-empty paragraph; remove section if fully empty
  if (parentP) parentP.remove();
  if (sectionDiv && !sectionDiv.textContent.trim() && !sectionDiv.querySelector('img, picture, iframe')) {
    sectionDiv.remove();
  }
}

export default function init() {
  buildBreadcrumbs();
  buildAutoHero();
  buildEventInfoBar();
}
