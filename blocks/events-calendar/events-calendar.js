import { resolveIndexUrl } from '../../scripts/utils/query-index.js';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function fetchEvents() {
  const url = await resolveIndexUrl('events');
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const json = await resp.json();
  return json.data || [];
}

function parseDate(str) {
  if (!str) return null;
  // startDate is always a string, but the lastModified fallback is a Unix
  // epoch in seconds, not milliseconds — new Date() on it directly resolves
  // to ~1970.
  const d = typeof str === 'number' ? new Date(str * 1000) : new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatHM(h, m) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${ampm}` : `${hour} ${ampm}`;
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  // Expects HH:MM (24h) or already formatted
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return timeStr;
  return formatHM(h, m);
}

// The date-inserter tool writes a combined YYYY-MM-DDTHH:mm datetime into
// startDate, so there may be no separate startTime — pull the time off the
// parsed date instead, unless it's exactly midnight (i.e. a bare date).
function timeFromDate(date) {
  if (!date || (date.getHours() === 0 && date.getMinutes() === 0)) return '';
  return formatHM(date.getHours(), date.getMinutes());
}

function renderEvent(item) {
  const date = parseDate(item.startDate || item.lastModified);
  const day = date ? date.getDate() : '';
  const month = date ? MONTH_ABBR[date.getMonth()] : '';

  const time = item.startTime ? formatTime(item.startTime) : timeFromDate(date);
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
  list.className = 'ec-list';
  el.append(list);

  let data;
  try {
    data = await fetchEvents();
  } catch {
    list.innerHTML = '<p class="ec-error">Events are temporarily unavailable.</p>';
    return;
  }

  // Filter to future/current events, sort ascending, take the authored limit
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
    .slice(0, limit);

  if (items.length === 0) {
    // Fall back to most recent regardless of date
    const fallback = data
      .sort((a, b) => {
        const da = parseDate(a.startDate || a.lastModified) || 0;
        const db = parseDate(b.startDate || b.lastModified) || 0;
        return db - da;
      })
      .slice(0, limit);

    if (fallback.length === 0) {
      list.innerHTML = '<p class="ec-error">No upcoming events found.</p>';
      return;
    }
    list.innerHTML = fallback.map(renderEvent).join('');
  } else {
    list.innerHTML = items.map(renderEvent).join('');
  }
}
