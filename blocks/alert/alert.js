import { applySelfColorScheme } from '../section-metadata/section-metadata.js';

const ICONS = { warning: 'warning', info: 'info', error: 'error' };

function getVariant(el) {
  if (el.classList.contains('info')) return 'info';
  if (el.classList.contains('error')) return 'error';
  return 'warning';
}

function setOffset(px) {
  document.documentElement.style.setProperty('--alert-height', `${px}px`);
  const header = document.querySelector('header');
  if (header) header.style.top = `${px}px`;
}

function updateHeight(el) {
  setOffset(el.offsetHeight);
}

function clearAlert(el) {
  el.remove();
  setOffset(0);
}

function dismiss(item, key, el) {
  item.classList.add('is-dismissed');
  item.addEventListener('transitionend', () => {
    item.remove();
    if (el.querySelector('.alert-item')) {
      updateHeight(el);
    } else {
      clearAlert(el);
    }
  }, { once: true });
  try { sessionStorage.setItem(key, '1'); } catch { /* noop */ }
}

export default function init(el) {
  const variant = getVariant(el);
  const icon = ICONS[variant];
  let visible = 0;

  for (const row of [...el.querySelectorAll(':scope > div')]) {
    const inner = row.querySelector(':scope > div');
    const html = inner?.innerHTML ?? row.innerHTML;
    const plain = (inner ?? row).textContent.trim();

    if (!plain) { row.remove(); continue; }

    // Use a stable session key based on text content
    const key = `alert:${btoa(unescape(encodeURIComponent(plain))).slice(0, 24)}`;
    try {
      if (sessionStorage.getItem(key)) { row.remove(); continue; }
    } catch { /* noop */ }

    const item = document.createElement('div');
    item.className = 'alert-item';
    item.innerHTML = `<div class="alert-content">
      <span class="material-symbols-outlined alert-icon">${icon}</span>
      <div class="alert-text">${html}</div>
    </div>
    <button class="alert-close" aria-label="Dismiss alert">
      <span class="material-symbols-outlined">close</span>
    </button>`;

    item.querySelector('.alert-close').addEventListener('click', () => dismiss(item, key, el));
    row.replaceWith(item);
    visible += 1;
  }

  if (!visible) { el.remove(); return; }

  // Hoist just the alert bar to the top of body so it sits above the fixed
  // header — leave the rest of its section (e.g. a hero sharing the section)
  // in place.
  document.body.prepend(el);
  updateHeight(el);

  // The bar's background is --primary/--secondary/--error, all site-specific
  // (except --error) — pick readable text off its actual rendered background
  // rather than assuming white always works.
  applySelfColorScheme(el);

  // Keep --alert-height in sync when the bar wraps on narrow viewports
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => updateHeight(el)).observe(el);
  }
}
