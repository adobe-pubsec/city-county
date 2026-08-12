import { getConfig } from '../../scripts/ak.js';
import { resolveIndexUrl } from '../../scripts/utils/query-index.js';

async function fetchEvents() {
  const url = await resolveIndexUrl('events');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('index unavailable');
  const json = await resp.json();
  return json.data || [];
}

async function loadFullCalendar() {
  const { codeBase } = getConfig();
  return import(`${codeBase}/deps/fullcalendar/dist/index.js`);
}

// Combines a date with an optional separate time into a datetime string
// FullCalendar can parse. `date` may already carry a time (as produced by
// the date-inserter tool), be a bare YYYY-MM-DD, or — as a last resort for
// events missing a start date — a Unix epoch in seconds (lastModified).
function toDateTime(date, time) {
  if (!date) return null;
  if (typeof date === 'number') return new Date(date * 1000).toISOString();
  if (date.includes('T')) return date;
  return time ? `${date}T${time}` : date;
}

function toEvent(item) {
  return {
    title: item.title || item.path,
    start: toDateTime(item.startDate || item.lastModified, item.startTime),
    end: toDateTime(item.endDate, item.endTime) || undefined,
    url: item.path,
    extendedProps: { location: item.location || '' },
  };
}

export default async function init(el) {
  el.innerHTML = '';

  const status = document.createElement('p');
  status.className = 'events-calendar-status';
  status.textContent = 'Loading…';
  el.append(status);

  let items;
  try {
    items = await fetchEvents();
  } catch {
    status.textContent = 'Calendar is temporarily unavailable.';
    return;
  }

  const events = items
    .filter((item) => item.startDate || item.lastModified)
    .map(toEvent);

  status.remove();

  const calendarEl = document.createElement('div');
  calendarEl.className = 'events-calendar-inner';
  el.append(calendarEl);

  const {
    Calendar, dayGridPlugin, listPlugin, interactionPlugin,
  } = await loadFullCalendar();

  const calendar = new Calendar(calendarEl, {
    plugins: [dayGridPlugin, listPlugin, interactionPlugin],
    initialView: 'dayGridMonth',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,listMonth',
    },
    height: 'auto',
    events,
    eventDidMount: ({ event, el: eventEl }) => {
      const location = event.extendedProps.location;
      if (location) eventEl.setAttribute('title', location);
    },
  });
  calendar.render();

  // The block still carries `data-status="decorated"` (which styles.css
  // hides via display:none) while render() runs above, so FullCalendar
  // measures a zero-size container and bakes that into inline styles. A
  // resize observer catches the moment the section actually becomes
  // visible (and any later resize) and forces a re-measure.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => calendar.updateSize()).observe(calendarEl);
  }
}
