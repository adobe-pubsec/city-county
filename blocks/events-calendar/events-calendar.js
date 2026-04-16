import { resolveIndexUrl } from '../../scripts/utils/query-index.js';
const MAX_ITEMS = 5;

const DEMO_EVENTS = [
  {
    path: '/events/city-council-meeting-may',
    title: 'City Council Regular Meeting',
    startDate: '2026-04-28',
    startTime: '19:00',
    location: 'City Hall Chambers',
  },
  {
    path: '/events/parks-rec-workshop',
    title: 'Parks & Recreation Community Workshop',
    startDate: '2026-05-02',
    startTime: '10:00',
    location: 'Community Center',
  },
  {
    path: '/events/farmers-market-opening',
    title: 'Downtown Farmers Market — Season Opening',
    startDate: '2026-05-10',
    startTime: '08:00',
    location: 'Court Square, Downtown',
  },
  {
    path: '/events/city-council-meeting-june',
    title: 'City Council Regular Meeting',
    startDate: '2026-06-28',
    startTime: '19:00',
    location: 'City Hall Chambers',
  },
];

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function fetchEvents() {
  const url = await resolveIndexUrl('events');
  const resp = await fetch(url);
  if (!resp.ok) return DEMO_EVENTS;
  const json = await resp.json();
  return (json.data && json.data.length) ? json.data : DEMO_EVENTS;
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  // Expects HH:MM (24h) or already formatted
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${ampm}` : `${hour} ${ampm}`;
}

function renderEvent(item) {
  const date = parseDate(item.startDate || item.lastModified);
  const day = date ? date.getDate() : '';
  const month = date ? MONTH_ABBR[date.getMonth()] : '';

  const time = item.startTime ? formatTime(item.startTime) : '';
  const location = item.location || '';

  return `
    <a class="ec-event" href="${item.path}">
      <div class="ec-date-chip" aria-label="${month} ${day}">
        <span class="ec-day">${day}</span>
        <span class="ec-month">${month}</span>
      </div>
      <div class="ec-event-body">
        <h3 class="ec-event-title">${item.title || item.path}</h3>
        ${time || location ? `
          <p class="ec-event-meta">
            ${time ? `<span class="ec-event-time"><span class="material-symbols-outlined" aria-hidden="true">schedule</span>${time}</span>` : ''}
            ${time && location ? '<span class="ec-bullet" aria-hidden="true">·</span>' : ''}
            ${location ? `<span class="ec-event-location"><span class="material-symbols-outlined" aria-hidden="true">location_on</span>${location}</span>` : ''}
          </p>` : ''}
      </div>
    </a>
  `;
}

export default async function init(el) {
  // Read authored subtitle, heading, and optional "submit event" link
  const rows = [...el.querySelectorAll(':scope > div')];
  let subtitle = '';
  let heading = '';
  let submitHref = '';
  let submitLabel = '';

  rows.forEach((row) => {
    const cells = [...row.querySelectorAll(':scope > div')];
    const link = cells[0]?.querySelector('a');
    const text = cells[0]?.textContent?.trim() || '';

    if (link) {
      submitHref = link.href;
      submitLabel = link.textContent?.trim() || 'Submit an Event';
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
  header.className = 'ec-header';
  header.innerHTML = `
    ${subtitle ? `<p class="ec-eyebrow">${subtitle}</p>` : ''}
    ${heading ? `<h2 class="ec-heading">${heading}</h2>` : ''}
  `;
  el.append(header);

  // List container
  const list = document.createElement('div');
  list.className = 'ec-list';
  el.append(list);

  let data;
  try {
    data = await fetchEvents();
  } catch {
    list.innerHTML = '<p class="ec-error">Events are temporarily unavailable.</p>';
    return;
  }

  // Filter to future/current events, sort ascending
  const now = Date.now();
  const items = data
    .filter((item) => {
      const d = parseDate(item.startDate || item.lastModified);
      return d && d.getTime() >= now - 86400000; // include today
    })
    .sort((a, b) => {
      const da = parseDate(a.startDate || a.lastModified) || 0;
      const db = parseDate(b.startDate || b.lastModified) || 0;
      return da - db;
    })
    .slice(0, MAX_ITEMS);

  if (items.length === 0) {
    // Fall back to most recent regardless of date
    const fallback = data
      .sort((a, b) => {
        const da = parseDate(a.startDate || a.lastModified) || 0;
        const db = parseDate(b.startDate || b.lastModified) || 0;
        return db - da;
      })
      .slice(0, MAX_ITEMS);

    if (fallback.length === 0) {
      list.innerHTML = '<p class="ec-error">No upcoming events found.</p>';
      return;
    }
    list.innerHTML = fallback.map(renderEvent).join('');
  } else {
    list.innerHTML = items.map(renderEvent).join('');
  }

  // Submit event CTA
  if (submitHref) {
    const cta = document.createElement('div');
    cta.className = 'ec-cta';
    cta.innerHTML = `<a class="btn ec-submit-btn" href="${submitHref}">${submitLabel}</a>`;
    el.append(cta);
  }
}
