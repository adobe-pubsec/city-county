#!/usr/bin/env node
// news-events.cjs — Step 5 of add-city-county-site (5a real content, 5b fallback,
// 5c preview, 5d publish) as ONE time-boxed, deterministic step.
//
// Sources N news + N events from the official site in parallel (WordPress REST, Tribe
// Events, RSS/Atom, CivicPlus, iCal, Legistar, last-resort HTML), normalizes them, fills
// every slot still empty at ~70% of the budget from the blueprint's own examples
// (entity-localized, re-dated), renders the exact blueprint molds, uploads lead images
// to each article's dot-folder, PUTs to DA in parallel, previews (and with --publish
// publishes) every path, verifies, and prints a summary. Always returns inside --budget.
//
// Usage:
//   node news-events.cjs --site <official url> --slug <slug> --entity "<Display Name>"
//        [--news 3] [--events 3] [--budget 150] [--images <dir>] [--tz America/New_York]
//        [--publish] [--source-only] [--json] [--token <ims>]
// Token: $DA_TOKEN or --token  (DA_TOKEN=$(oauth-token adobe | tr -d '[:space:]'))
//        --source-only needs no token (with one, it also resolves the fallback items).
// Exit:  0 = N news + N events written (real or fallback) and previewed (and published),
//        1 = fewer written / a write, preview or publish failed, 64 = bad usage.
// Writes ONLY /sites/<slug>/news/** and /sites/<slug>/events/** (docs + their dot-folder
// images). Never touches /metadata.json, other tenants, or the blueprint.
//
// Runtime: SLICC Node shim — CommonJS, global fetch, no npm. Not re-entrant (one run at a time).

let lib;
try { lib = require('./lib.cjs'); } catch (e) {
  const path = require('path');
  lib = {
    isMain: (mod) => !!process.argv[1] && path.resolve(process.argv[1]) === mod.filename,
    slugify: (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, ''),
  };
}
const { isMain, slugify } = lib;
const fs = require('fs');
const pathMod = require('path');

const ORG = 'adobe-pubsec';
const REPO = 'city-county';
const DA = 'https://admin.da.live';
const CDA = `https://content.da.live/${ORG}/${REPO}`;
const HLX = 'https://admin.hlx.page';
const PAGE_HOST = `https://main--${REPO}--${ORG}.aem.page`;
const LIVE_HOST = `https://main--${REPO}--${ORG}.aem.live`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const CUTOFF_FRACTION = 0.7;      // sourcing stops here; empty slots go to the fallback
const WRITE_RESERVE_S = 15;       // ...but always leave this long for images/PUT/preview/verify
const MAX_IMAGE = 8 * 1024 * 1024;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ============================================================== runtime / clock / fetch
let RT = null; // { t0, deadline, cutoff, hard: AbortController, token }

function makeRuntime(budgetS, token) {
  const t0 = Date.now();
  const cutS = Math.max(budgetS * 0.25, Math.min(budgetS * CUTOFF_FRACTION, budgetS - WRITE_RESERVE_S));
  return { t0, deadline: t0 + budgetS * 1000, cutoff: t0 + cutS * 1000, cutS, hard: new AbortController(), token };
}
const elapsed = () => (Date.now() - RT.t0) / 1000;
const leftMs = () => RT.deadline - Date.now();
// Cancellable sleeps: every pending one is released at the end so the process exits at once.
const SLEEPS = new Set();
const sleep = (ms) => new Promise((r) => { const t = setTimeout(() => { SLEEPS.delete(t); r(); }, Math.max(0, ms)); SLEEPS.add(t); });
const releaseSleeps = () => { for (const t of SLEEPS) clearTimeout(t); SLEEPS.clear(); };

// Never throws. Every call has a timeout and is clipped to the global deadline.
async function fx(url, o = {}) {
  const { method = 'GET', headers = {}, body, timeout = 8000, as = 'text', signal, maxBytes, reserve = 400 } = o;
  const ms = Math.min(timeout, leftMs() - reserve);
  if (ms < 100) return { ok: false, status: 0, err: 'deadline', url, ms: 0 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort); }
  RT.hard.signal.addEventListener('abort', onAbort);
  const t = Date.now();
  try {
    const r = await fetch(url, { method, body, redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: '*/*', ...headers } });
    const res = { ok: r.ok, status: r.status, ct: r.headers.get('content-type') || '', url: r.url || url, len: Number(r.headers.get('content-length')) || 0 };
    if (maxBytes && res.len > maxBytes) { ctl.abort(); return { ...res, ok: false, err: `too large (${res.len} B)`, ms: Date.now() - t }; }
    if (as === 'buf') res.buf = Buffer.from(await r.arrayBuffer());
    else if (as === 'json') { res.text = await r.text(); try { res.json = JSON.parse(res.text); } catch { res.json = null; } }
    else if (as !== 'none') res.text = await r.text();
    res.ms = Date.now() - t;
    return res;
  } catch (e) {
    const took = Date.now() - t;
    return { ok: false, status: 0, err: ctl.signal.aborted ? (took >= ms - 30 ? 'timeout' : 'aborted') : String(e.message || e), url, ms: took };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    RT.hard.signal.removeEventListener('abort', onAbort);
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ============================================================== text utilities
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·',
  eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', deg: '°', frac12: '½', sect: '§', rarr: '→', larr: '←',
};
function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}
const C0 = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const cleanCtl = (s) => String(s).replace(/\x13/g, '–').replace(/\x14/g, '—').replace(C0, '');
const squish = (s) => String(s).replace(/[\s\u00a0\u200b]+/g, ' ').trim();
const stripTags = (h) => squish(decodeEntities(String(h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/?(a|span|strong|b|em|i|u|abbr|sup|sub|small|mark|font|time)\b[^>]*>/gi, '').replace(/<[^>]+>/g, ' '))).replace(/\s+([,.;:!?)])/g, '$1').replace(/\(\s+/g, '(');
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrEsc = (s) => htmlEsc(s).replace(/"/g, '&quot;');
const cdata = (s) => {
  const t = String(s || '').trim();
  const m = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : decodeEntities(t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
};

function removeNoise(h) {
  let s = String(h || '').replace(/<!--[\s\S]*?-->/g, '');
  for (const t of ['script', 'style', 'noscript', 'svg', 'form', 'iframe', 'nav', 'header', 'footer', 'aside', 'button', 'select', 'template', 'figcaption']) {
    s = s.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}>`, 'gi'), ' ');
  }
  return s;
}

// Slice one element (balanced by tag name) starting at `start` (index of "<tag").
function sliceEl(html, start) {
  const m = /^<([a-z][a-z0-9]*)/i.exec(html.slice(start, start + 30));
  if (!m) return '';
  const re = new RegExp(`<(/?)${m[1]}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0; let mm;
  while ((mm = re.exec(html))) {
    if (/\/>$/.test(mm[0])) continue;
    depth += mm[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, re.lastIndex);
  }
  return html.slice(start);
}
const BODY_CLASSES = ['tribe-events-single-event-description', 'event_description_content', 'event-description', 'entry-content', 'field--name-body', 'article-body', 'article__body', 'post-content', 'news-body', 'story-body', 'content-body', 'body-content', 'fr-view', 'news-content', 'page-content'];
function findContainer(html, classes = BODY_CLASSES, minText = 120) {
  const tries = [
    /<[a-z0-9]+\b[^>]*itemprop=["'](?:articleBody|description)["'][^>]*>/i,
    ...classes.map((c) => new RegExp(`<[a-z0-9]+\\b[^>]*class=["'][^"']*(?<![\\w-])${c.replace(/[-]/g, '\\-')}(?![\\w-])[^"']*["'][^>]*>`, 'i')),
    /<article\b[^>]*>/i, /<main\b[^>]*>/i, /<body\b[^>]*>/i,
  ];
  for (const re of tries) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(html))) {
      const el = sliceEl(html, m.index);
      if (stripTags(removeNoise(el)).length >= minText) return el;
    }
  }
  return html;
}

const JUNK_P = new RegExp([
  'please contact', '\\bcontact:', 'contact (us|the|our)\\b', 'for (more )?information,? (please )?(contact|call|email|visit)', 'media (contact|inquiries)', 'press contact',
  'share (this|on)', 'follow us', 'sign up', 'subscribe', 'click here', 'was this (page|article) helpful', 'all rights reserved', '©', 'copyright',
  'read more', 'back to top', 'print this', 'leer en español', 'en español', 'translate this', '^(tags?|categories|posted in|filed under)\\b',
  '^-?\\s*#{3}\\s*-?$', '^-\\s*30\\s*-$', '^(photo|image|credit)s?( credit)?:', 'add to calendar', 'google calendar', 'icalendar', 'outlook 365',
  '^« all events', '^related\\s*[>:»]', 'please (visit|see|go to|call|email|reach)', 'visit (this|our|the) (page|website|web page)', 'apply (online|now|today|by)', 'job (specification|opportunit)', '^view (the )?(initial |full |original |complete )?(press release|news release|release|story|article|flyer|agenda)\\b', '^(download|view|see) (the )?(pdf|attachment|document)', 'related (news|articles|stories)', 'this (content|page) (was|is) (last )?(updated|reviewed)', 'cookie', 'javascript',
].join('|'), 'i');
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(\(\d{3}\)\s*|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/;
const HERE_SENT = /[^.!?]*\b(here|below|this link|the link|this page)\s*[.!]?$/i;
const VIDEO_SENT = /[^.!?]*\b(watch (the |this |our |a |it )?(full |live )?(video|livestream|recording|replay)|watch (it )?(here|below|now)|(video|recording) (below|above)|click (here )?to watch|see the video)\b[^.!?]*[.!?]?/gi;

const STOP_P = /^(media|press|news)?\s*contacts?( information| us)?:?$|^for questions\b.*contact|^(for )?(media|press) (inquiries|contacts?)\b|^#{3}$|^-?\s*30\s*-?$|^about (the )?[A-Z]/i;
const HAS_WHEN = new RegExp(`\\b(${MON_RE}|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?)\\b|\\d{1,2}:\\d{2}|\\b\\d{1,2}\\s?[ap]\\.?m\\b`, 'i');
function cleanParagraphs(list, { max = 8, maxChars = 2600, minLen = 25 } = {}) {
  const out = []; const seen = new Set(); let total = 0;
  for (let p of list) {
    p = squish(cleanCtl(p)).replace(VIDEO_SENT, ' ');
    p = squish(p);
    if (/\b(see|find|view|read|visit|available|click|register|sign|watch|access|learn more|more information)\b/i.test((p.match(HERE_SENT) || [''])[0])) p = squish(p.replace(HERE_SENT, ''));
    if (STOP_P.test(p) && out.length) break;
    if (p.length < minLen || JUNK_P.test(p) || EMAIL.test(p) || PHONE.test(p)) continue;
    if ((p.match(/[a-z][A-Z][a-z]/g) || []).length >= 2) continue; // glued nav/widget text
    if (p.length < 45 && !/[.!?:”"]$/.test(p) && !HAS_WHEN.test(p)) continue; // headings, addresses, job titles
    if (/^(https?:\/\/|www\.)\S+$/.test(p)) continue;
    const k = p.toLowerCase().slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k); out.push(p); total += p.length;
    if (out.length >= max || total >= maxChars) break;
  }
  return out;
}
function paragraphsFrom(html, opts) {
  const h = removeNoise(html);
  let ps = [...h.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1]));
  if (ps.join(' ').length < 120) {
    ps = h.replace(/<(br|\/div|\/li|\/h[1-6]|\/td|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').split('\n').map((x) => squish(decodeEntities(x)));
  }
  return cleanParagraphs(ps, opts);
}
// "CHATTANOOGA, Tenn. — The City…" -> "The City…"
const stripDateline = (s) => s
  .replace(/^[A-Z][A-Z .'’-]{2,}(?:,\s*[A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+)?)?\s*(?:\([^)]{3,40}\)\s*)?[—–-]{1,2}\s+/, '')
  .replace(new RegExp(`^(?:${'(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}'})[.,]?\\s+(?:[A-Z][\\w/.]+(?:,\\s*[A-Z][\\w.]+)*\\.?\\s*[—–-]\\s+)?`, 'i'), '');
// Date written in the body's dateline: "CITY, St. (October 23, 2026) —" / "Oct. 23, 2026. Reno, Nev. –"
function datelineDate(p, tz) {
  const head = String(p || '').slice(0, 90);
  const m = head.match(/^[A-Z][A-Za-z .,'’-]{2,40}\(([^)]{6,30})\)/) || head.match(new RegExp(`^((?:${MON_RE})\\.?\\s+\\d{1,2},?\\s+\\d{4})`, 'i'));
  const w = m && parseWhen(m[1], tz);
  return w && w.date;
}
function describe(text, max = 200) {
  const t = squish(stripDateline(String(text || '').replace(VIDEO_SENT, ' ')));
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= 80) return cut.slice(0, end + 1);
  return cut.slice(0, cut.lastIndexOf(' ', max - 1)).replace(/[,;:\s]+$/, '') + '…';
}
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'over', 'the', 'to', 'with', 'vs']);
const titleCase = (s) => s.toLowerCase().replace(/[a-z0-9][a-z0-9'’]*/g, (w, i) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
function cleanTitle(t, siteHints = []) {
  let s = squish(cleanCtl(decodeEntities(stripTags(t))));
  if (s.length > 12 && !/[a-z]/.test(s)) s = titleCase(s);
  s = s.replace(/\s+[|–—-]\s+[^|–—-]{2,60}$/, (m) => (siteHints.some((h) => h && m.toLowerCase().includes(h)) || /\.(gov|org|com|us)\b|city of|county|town of/i.test(m) ? '' : m));
  return s;
}
// Short kebab slug: <= 8 words / 60 chars, cut on a word boundary.
function kebab(title, maxWords = 8, maxLen = 60) {
  const words = slugify(String(title).replace(/[’'`]/g, '').replace(/&/g, ' and ').replace(/[/|:—–]+/g, ' ')).split('-').filter(Boolean);
  let out = '';
  for (const w of words.slice(0, maxWords)) { const next = out ? `${out}-${w}` : w; if (next.length > maxLen) break; out = next; }
  return out || 'item';
}

// ============================================================== dates
function tzParts(d, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
const todayISO = (tz) => tzParts(new Date(), tz).date;
function addDays(iso, n) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dayDiff = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 864e5);
const pad = (n) => String(n).padStart(2, '0');
const weekday = (iso) => DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${weekday(iso)}, ${MONTHS[m - 1]} ${d}, ${y}`; };
function time12(hm) { if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'p.m.' : 'a.m.'}`; }
const monIdx = (s) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase());

// -> { date:'YYYY-MM-DD', time?:'HH:MM' } or null. Zoned timestamps are converted to `tz`.
function parseWhen(raw, tz) {
  const s = squish(decodeEntities(String(raw || '')));
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (m) {
    if (m[6] && m[4]) { const d = new Date(s.replace(' ', 'T')); if (!isNaN(d)) return tzParts(d, tz); }
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : undefined };
  }
  if (/^\d{8}(T\d{4,6}Z?)?$/.test(s)) { // iCal basic
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (s.length > 8) {
      const hh = s.slice(9, 11); const mi = s.slice(11, 13);
      if (s.endsWith('Z')) return tzParts(new Date(`${iso}T${hh}:${mi}:00Z`), tz);
      return { date: iso, time: `${hh}:${mi}` };
    }
    return { date: iso };
  }
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return { date: `${m[3]}-${pad(m[1])}-${pad(m[2])}`, time: parseClock(s.slice(m.index + m[0].length)) };
  m = s.match(new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'));
  if (m) return { date: `${m[3]}-${pad(monIdx(m[1]) + 1)}-${pad(m[2])}`, time: parseClock(s.slice(m.index + m[0].length)) };
  m = s.match(new RegExp(`\\b(\\d{1,2})\\s+(${MON_RE})\\.?\\s+(\\d{4})\\b`, 'i'));
  if (m) {
    if (/\d{1,2}:\d{2}(:\d{2})?\s*(GMT|UTC|Z|[+-]\d{4}|[ECMP][SD]T)\b/i.test(s)) { const d = new Date(s); if (!isNaN(d)) return tzParts(d, tz); }
    return { date: `${m[3]}-${pad(monIdx(m[2]) + 1)}-${pad(m[1])}` };
  }
  return null;
}
// "10:00 a.m." / "5:30 PM" / "noon" / "17:00" -> "HH:MM"
function parseClock(s) {
  const t = String(s || '');
  if (/\bnoon\b/i.test(t) && !/\d/.test(t.split(/noon/i)[0].slice(-6))) return '12:00';
  let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?/i);
  if (m) { let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'p') h += 12; return `${pad(h)}:${m[2] || '00'}`; }
  m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return m ? `${pad(m[1])}:${m[2]}` : undefined;
}
function parseClockRange(s) {
  const t = String(s || '');
  const all = [...t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?|\bnoon\b/gi)];
  const conv = (m) => { if (/noon/i.test(m[0])) return '12:00'; let h = Number(m[1]) % 12; if (m[3].toLowerCase() === 'p') h += 12; return `${pad(h)}:${m[2] || '00'}`; };
  if (all.length) {
    let start = conv(all[0]); let end = all[1] ? conv(all[1]) : undefined;
    // "1 - 3 p.m." : the first number carries no meridiem
    const lone = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?/i);
    if (lone && all.length === 1) { let h = Number(lone[1]) % 12; const e = conv([null, lone[3], lone[4], lone[5]]); if (lone[5].toLowerCase() === 'p' && h + 12 < Number(e.slice(0, 2))) h += 12; start = `${pad(h)}:${lone[2] || '00'}`; end = e; }
    if (end === start) end = undefined;
    return { start, end };
  }
  const h24 = [...t.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)];
  return h24.length ? { start: `${pad(h24[0][1])}:${h24[0][2]}`, end: h24[1] ? `${pad(h24[1][1])}:${h24[1][2]}` : undefined } : {};
}

// ============================================================== HTML helpers
function metaContent(html, key) {
  const k = key.replace(/[:]/g, '\\:');
  const re1 = new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${k}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? squish(decodeEntities(m[1])) : '';
}
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { out.push(x); if (x['@graph']) walk(x['@graph']); } };
      walk(j);
    } catch { /* ignore malformed */ }
  }
  return out;
}
const ldType = (o, re) => [].concat(o['@type'] || []).some((t) => re.test(String(t)));
function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*?href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), base);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      out.push({ href: u.href, text: stripTags(m[2]), index: m.index });
    } catch { /* bad url */ }
  }
  return out;
}
function baseDomain(host) {
  const p = host.toLowerCase().replace(/^www\./, '').split('.');
  if (p.length >= 3 && p[p.length - 2].length <= 3 && p[p.length - 1] === 'us') return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}
const sameSite = (a, b) => baseDomain(a) === baseDomain(b);
const absUrl = (u, base) => { try { return new URL(decodeEntities(u), base).href; } catch { return null; } };
const isFeedText = (t) => /^\s*(\ufeff)?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(t || '') && /<(item|entry)\b/i.test(t);
const BAD_IMG = /(logo|seal|icon|sprite|favicon|badge|avatar|placeholder|default[-_]?(image|meta|share|og)|fb[-_]?preview|social[-_]?share|share[-_]?image|og[-_]?default|blank|spacer|pixel|gravatar|emoji|qr[-_]?code|required\.gif|\.gif(\?|$)|\.svg(\?|$))/i;

function firstImage(html, base) {
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const pick = (a) => (tag.match(new RegExp(`\\b${a}=["']([^"']+)["']`, 'i')) || [])[1];
    let src = pick('data-src') || pick('data-lazy-src') || pick('src');
    const ss = pick('srcset') || pick('data-srcset');
    if (ss) { const last = ss.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop(); if (last) src = last; }
    if (!src || src.startsWith('data:')) continue;
    const w = Number(pick('width')) || 0; const h = Number(pick('height')) || 0;
    if ((w && w < 200) || (h && h < 120)) continue;
    const alt = squish(decodeEntities(pick('alt') || ''));
    const abs = absUrl(src, base);
    if (!abs || BAD_IMG.test(abs) || /logo|seal|icon/i.test(alt)) continue;
    return { url: abs.replace(/-\d{2,4}x\d{2,4}(\.(?:jpe?g|png|webp))(\?|$)/i, '$1$2'), alt, thumb: abs };
  }
  return null;
}

// The page's real heading: the <h1> that matches <title>/og:title (sites also put h1s in
// language pickers, modals, etc.), else the first h1 inside <main>/<article>, else og:title.
function bestH1(html) {
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => ({ t: stripTags(m[1]), i: m.index })).filter((x) => x.t.length >= 4);
  const page = `${metaContent(html, 'og:title')} ${stripTags((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')}`.toLowerCase();
  const hit = h1s.filter((x) => page.includes(x.t.toLowerCase().slice(0, 40))).sort((a, b) => b.t.length - a.t.length)[0];
  if (hit) return hit.t;
  const mainAt = html.search(/<(main|article)\b/i);
  const inMain = h1s.find((x) => mainAt >= 0 && x.i > mainAt);
  return (inMain || h1s[0] || {}).t || metaContent(html, 'og:title');
}
// Publication date printed on the page: "Published on 04/27/2026", "Posted: Oct 3, 2026", <time>.
function pageDate(html, tz) {
  const art = (() => { const i = html.search(/<article\b/i); return i >= 0 ? sliceEl(html, i) : ''; })();
  for (const scope of [art, html].filter(Boolean)) {
    const txt = removeNoise(scope).replace(/<[^>]+>/g, ' ');
    const m = squish(decodeEntities(txt)).match(/\b(?:published|posted|released|date posted|news date|release date)(?:\s+on)?\s*:?\s*([^|]{6,40})/i);
    const w = m && parseWhen(m[1], tz);
    if (w) return w.date;
    const t = removeNoise(scope).match(/<time\b[^>]*datetime=["']([^"']+)["']/i);
    if (t && scope === art) { const w2 = parseWhen(t[1], tz); if (w2) return w2.date; }
  }
  return null;
}

// Article detail: { title, date, paragraphs, image:{url,alt}, description }
function parseArticle(html, url, tz) {
  const ld = jsonLd(html).find((o) => ldType(o, /(News)?Article|BlogPosting|Report/i));
  const container = findContainer(html);
  const paragraphs = paragraphsFrom(container);
  const h1 = bestH1(html);
  const title = cleanTitle((ld && ld.headline) || h1 || metaContent(html, 'og:title') || (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '', [new URL(url).hostname.replace(/^www\./, '')]);
  let when = parseWhen(metaContent(html, 'article:published_time'), tz) || (ld && parseWhen(ld.datePublished, tz));
  if (!when) { const d = pageDate(html, tz); if (d) when = { date: d }; }
  if (!when) { const t = container.match(/<time\b[^>]*datetime=["']([^"']+)["']/i); if (t) when = parseWhen(t[1], tz); }
  if (!when) { const head = stripTags(container).slice(0, 400); when = parseWhen(head, tz); }
  const artAt = html.search(/<article\b/i);
  const art = artAt >= 0 ? sliceEl(html, artAt) : '';
  let image = firstImage(art && art.includes(container.slice(0, 200)) ? art : container, url);
  const og = metaContent(html, 'og:image');
  if (!image && og && !BAD_IMG.test(og)) image = { url: absUrl(og, url), alt: metaContent(html, 'og:image:alt') };
  const tags = [...html.matchAll(/<meta\b[^>]*property=["']article:(?:tag|section)["'][^>]*content=["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1]));
  return { title, date: when && when.date, paragraphs, image, tags, metaDescription: metaContent(html, 'description') || metaContent(html, 'og:description') };
}

// Bilingual sites (e.g. Washoe) publish every release twice; keep the English one.
function isEnglish(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const en = (t.match(/ (the|and|of|to|is|will|for|with) /g) || []).length;
  const es = (t.match(/ (el|la|los|las|de|del|que|para|con|una|por|en el|está|será) /g) || []).length;
  return en >= es;
}

// ============================================================== classification
const GENERIC_CAT = /^(news|featured|uncategori[sz]ed|announcements?|press releases?|news releases?|home|homepage|top stories|general|latest news|city news|county news|news ?flash|headlines?|slider|front page|all|events?|blog|media|press|stories|spotlight|highlights?|carousel)$/i;
const TAG_RULES = [
  ['Public Safety', /\b(police|fire|sheriff|emergency|crime|rescue|911|ems|firefighter|public safety|officer)\b/i],
  ['Elections', /\b(election|voting|voter|ballot|polls?)\b/i],
  ['Parks & Recreation', /\b(parks?|recreation|trails?|greenway|pool|playground|nature center)\b/i],
  ['Transportation', /\b(road|street|traffic|transit|bus|paving|bridge|sidewalk|closure|detour|parking)\b/i],
  ['Health', /\b(health|vaccine|flu|clinic|mosquito|rabies|overdose|medicaid)\b/i],
  ['Environment', /\b(climate|energy|solar|recycl|environment|water quality|stormwater|trees?)\b/i],
  ['Housing', /\b(housing|homeless|affordable|rent)\b/i],
  ['Economic Development', /\b(business|workforce|jobs?|economic|employer|grant)\b/i],
  ['Government', /\b(council|commission(ers?)?|board of|mayor|budget|ordinance|supervisors|meeting)\b/i],
  ['Arts & Culture', /\b(art|music|museum|festival|library|culture)\b/i],
];
function pickTag(cats, title, body) {
  const c = (cats || []).map((x) => squish(decodeEntities(x))).find((x) => x && !GENERIC_CAT.test(x) && x.length <= 30 && !/^(city|county|town|village|borough) of\b|\b(county|city|town|government)$/i.test(x));
  if (c) return c;
  for (const [tag, re] of TAG_RULES) if (re.test(title)) return tag;
  for (const [tag, re] of TAG_RULES) if (re.test(String(body).slice(0, 400))) return tag;
  return 'Community';
}

// ============================================================== normalizers
function normNews(raw, strategy) {
  const paragraphs = cleanParagraphs(raw.bodyParagraphs || []);
  const title = cleanTitle(raw.title || '');
  if (!title || !raw.date || !paragraphs.length) return null;
  if ((raw.categories || []).some((c) => /^(jobs?|careers?|employment|job openings?|now hiring)$/i.test(squish(c)))) return null;
  if (!isEnglish(`${title} ${paragraphs.join(' ')}`) || (raw.categories || []).some((c) => /espa[nñ]ol|spanish/i.test(c))) return null;
  const dl = datelineDate(paragraphs[0], raw.tz || 'America/New_York');
  if (dl && dl !== raw.date && Math.abs(dayDiff(dl, raw.date)) <= 30) raw.date = dl; // body beats metadata
  const description = describe(raw.description && raw.description.length >= 40 ? raw.description : paragraphs[0]);
  return {
    title, date: raw.date, description, bodyParagraphs: paragraphs,
    leadImageUrl: raw.leadImageUrl || undefined, leadImageAlt: raw.leadImageAlt || undefined,
    leadImageAltUrl: raw.leadImageThumb && raw.leadImageThumb !== raw.leadImageUrl ? raw.leadImageThumb : undefined,
    sourceUrl: raw.sourceUrl, tag: raw.tag || pickTag(raw.categories, title, paragraphs.join(' ')), strategy,
  };
}
function eventBody(e) {
  const where = e.location ? ` at ${e.location}` : '';
  const when = `${longDate(e.startDate)}${e.startTime ? ` at ${time12(e.startTime)}` : ''}`;
  return `${e.title} is scheduled for ${when}${where}`.replace(/\.?$/, '.');
}
function normEvent(raw, strategy) {
  const title = cleanTitle(raw.title || '');
  if (!title || !raw.startDate || /\bcancel+ed\b|\bpostponed\b/i.test(title)) return null;
  const e = {
    title, startDate: raw.startDate, startTime: raw.startTime || undefined, endDate: raw.endDate || undefined, endTime: raw.endTime || undefined,
    location: squish(cleanCtl(raw.location || '')).replace(/^(location|where|venue)\s*:\s*/i, '').replace(/,?\s*(USA|United States( of America)?)$/i, '').slice(0, 160) || undefined,
    sourceUrl: raw.sourceUrl, strategy,
  };
  if (e.location && (e.location.toLowerCase() === title.toLowerCase() || /^see (the )?description$|^tbd$|^tba$|^n\/?a$/i.test(e.location)
    || (!/\d/.test(e.location) && /\b(workshop|class|meeting|program|session|webinar|seminar|series)\b/i.test(e.location)))) e.location = undefined;
  if (e.endDate && e.endDate < e.startDate) e.endDate = undefined;
  if (e.endDate === e.startDate && !e.endTime) e.endDate = undefined;
  if (e.endTime && !e.endDate) e.endDate = e.startDate;
  if (e.endTime && e.endDate === e.startDate && e.startTime && e.endTime <= e.startTime) { e.endTime = undefined; e.endDate = undefined; }
  const locKey = (e.location || '').toLowerCase();
  let paragraphs = cleanParagraphs(raw.bodyParagraphs || []).filter((p) => {
    const k = p.toLowerCase().replace(/,?\s*(usa|united states)$/, '');
    if (locKey && (locKey.includes(k) || k === locKey)) return false;
    return p.length >= 40 || /[.!?]$/.test(p);
  });
  if (!paragraphs.length) paragraphs = [eventBody(e)];
  e.description = describe(raw.description && raw.description.length >= 30 ? raw.description : paragraphs[0]);
  e.bodyParagraphs = paragraphs;
  return e;
}
const normKey = (t) => String(t).toLowerCase().replace(new RegExp(`\\b(${MON_RE})\\b`, 'gi'), '').replace(/\([^)]*\)/g, '').replace(/[^a-z]+/g, ' ').trim();

// ============================================================== discovery context
function makeContext(site, tz, need) {
  const origin = new URL(site).origin;
  const today = todayISO(tz);
  const ctx = { origin, site, tz, today, need, cache: new Map() };
  ctx.get = (url, o = {}) => {
    const key = `${o.as || 'text'} ${url}`;
    if (!ctx.cache.has(key)) ctx.cache.set(key, fx(url, { timeout: 8000, ...o }));
    return ctx.cache.get(key);
  };
  ctx.home = ctx.get(site.endsWith('/') ? site : `${site}/`, { timeout: 10000 }).then((r) => (r.ok && r.text ? { html: r.text, url: r.url } : null));
  ctx.disc = ctx.home.then((h) => discover(h, origin));
  return ctx;
}
function discover(home, origin) {
  const d = { feeds: [], icals: [], legistar: [], hosts: [], newsPages: [], eventPages: [], homeUrl: origin };
  if (!home) return d;
  const base = home.url || origin;
  d.homeUrl = base;
  const homeHost = new URL(base).hostname;
  for (const m of home.html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (/rel=["']?alternate/i.test(tag) && /type=["']?application\/(rss|atom)\+xml/i.test(tag)) {
      const h = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
      const u = h && absUrl(h, base);
      if (u && !/comments\/feed/i.test(u)) d.feeds.push(u);
    }
  }
  const all = links(home.html, base);
  const hostCount = new Map();
  for (const l of all) {
    const u = new URL(l.href);
    if (/\.ics(\?|$)|[?&]ical=|webcal:|\/ical\b|icalendar/i.test(l.href)) d.icals.push(l.href);
    const lg = u.hostname.match(/^([a-z0-9-]+)\.legistar\.com$/i);
    if (lg) d.legistar.push(lg[1].toLowerCase());
    if (sameSite(u.hostname, homeHost)) {
      if (u.hostname.replace(/^www\./, '') !== homeHost.replace(/^www\./, '')) hostCount.set(u.origin, (hostCount.get(u.origin) || 0) + 1);
      if (/(rss|feed)(\.xml|\/|$)|\.rss$|format=rss/i.test(u.pathname + u.search) && !/rssfeed\.aspx$/i.test(u.pathname)) d.feeds.push(l.href);
      const segs = u.pathname.toLowerCase().replace(/\/+$/, '').split('/').filter(Boolean);
      const last = segs[segs.length - 1] || '';
      if (/^(news|newsroom|news-?room|latest-news|news-releases|press-releases|press|press-room|announcements|news-and-announcements|newsflash|news-center|media-releases|civicalerts\.aspx)$/.test(last) && segs.length <= 3) d.newsPages.push(u.href);
      if (/^(events|calendar|event-calendar|events-calendar|calendar-of-events|community-calendar|calendar\.aspx|meetings|public-meetings)$/.test(last) && segs.length <= 3) d.eventPages.push(u.href);
    }
  }
  const uniq = (a) => [...new Set(a)];
  d.feeds = uniq(d.feeds).slice(0, 8);
  d.icals = uniq(d.icals).slice(0, 3);
  d.legistar = uniq(d.legistar).slice(0, 2);
  d.hosts = [...hostCount.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h).filter((h) => !/\/\/(gis|maps?|jobs|careers|pay|epay|portal|apps?|login|shop|tickets?)\./i.test(h)).slice(0, 3);
  const byLen = (a, b) => a.length - b.length;
  d.newsPages = uniq(d.newsPages).sort(byLen).slice(0, 2);
  d.eventPages = uniq(d.eventPages).sort(byLen).slice(0, 2);
  if (!d.eventPages.length) d.eventPages = [`${origin}/events`, `${origin}/calendar`];
  if (!d.newsPages.length) d.newsPages = [`${origin}/news`];
  return d;
}

// ============================================================== feed parsing
function parseFeed(xml, base) {
  const atom = /<feed\b/i.test(xml.slice(0, 2000)) && !/<rss\b/i.test(xml.slice(0, 2000));
  const blocks = [...xml.matchAll(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const channelTitle = stripTags(cdata((xml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''));
  const items = blocks.map((b) => {
    const tag = (n) => { const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i').exec(b); return m ? cdata(m[1]) : ''; };
    let link = atom ? ((b.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i) || b.match(/<link\b[^>]*href=["']([^"']+)/i) || [])[1] || '') : squish(stripTags(tag('link')));
    if (!link) { const g = b.match(/<guid\b[^>]*isPermaLink=["']true["'][^>]*>([^<]+)/i) || b.match(/<guid\b[^>]*>(https?:[^<]+)/i); if (g) link = g[1].trim(); }
    const html = tag('content:encoded') || tag('content') || tag('description') || tag('summary');
    const enc = b.match(/<(?:enclosure|media:content|media:thumbnail)\b[^>]*url=["']([^"']+)["'][^>]*>/i);
    const cats = [...b.matchAll(/<category\b[^>]*?(?:term=["']([^"']+)["'][^>]*\/?>|>([\s\S]*?)<\/category>)/gi)].map((m) => stripTags(cdata(m[1] || m[2] || '')));
    return {
      title: stripTags(tag('title')), link: link ? absUrl(link, base) : '', html,
      pub: tag('pubDate') || tag('published') || tag('updated') || tag('dc:date'),
      image: enc ? absUrl(decodeEntities(enc[1]), base) : null, cats,
      cal: { dates: tag('calendarEvent:EventDates'), times: tag('calendarEvent:EventTimes'), location: tag('calendarEvent:Location') },
    };
  });
  return { channelTitle, items, calendar: /calendarEvent:|xmlns:ev=|<ev:startdate/i.test(xml) };
}

// ============================================================== news strategies
async function enrichNews(ctx, cands, signal) {
  return pickRecentNews(ctx, (await enrichNewsRaw(ctx, cands, signal)).filter(Boolean));
}
async function enrichNewsRaw(ctx, cands, signal) {
  // cands: { title, date, link, paragraphs?, image?, cats? } — fetch the page when body/image missing
  return pool(cands, 6, async (c) => {
    let paragraphs = c.paragraphs || [];
    let image = c.image || null;
    let date = c.date;
    let tags = c.cats || [];
    let title = c.title;
    let description = c.description;
    if ((paragraphs.length < 2 || !image || !date) && c.link) {
      const r = await fx(c.link, { timeout: 8000, signal });
      if (r.ok && r.text && /html/i.test(r.ct)) {
        const a = parseArticle(r.text, r.url, ctx.tz);
        if (a.paragraphs.length >= Math.max(1, paragraphs.length)) paragraphs = a.paragraphs;
        if (!image && a.image) image = a.image;
        if (!date && a.date) date = a.date;
        if (!tags.length) tags = a.tags;
        if (!title) title = a.title;
        if (!description && a.metaDescription && paragraphs.length && a.metaDescription.length >= 40) {
          // prefer the body if the meta description contradicts it (dates in meta but not in body)
          const metaDates = a.metaDescription.match(new RegExp(`\\b(${MON_RE})\\.?\\s+\\d{1,2}\\b`, 'gi')) || [];
          const body = paragraphs.join(' ').toLowerCase();
          if (metaDates.every((x) => body.includes(x.toLowerCase()))) description = a.metaDescription;
        }
      }
    }
    return normNews({ title, date, description, bodyParagraphs: paragraphs, leadImageUrl: image && image.url, leadImageThumb: image && image.thumb, leadImageAlt: image && image.alt, sourceUrl: c.link, categories: tags, tz: ctx.tz }, c.strategy);
  });
}
// Stage-safe filter: a live audience watches these headlines appear, so skip crime, violence,
// death and disaster stories (title + description). Real but unpleasant news falls through to the
// next-most-recent item; if too few remain, the per-slot blueprint fallback fills in.
const SENSITIVE = /\b(arrest(ed|s)?|suspects?|charged|indict(ed|ment)|homicides?|murders?|kill(ed|ing|s)?|shoot(ing|ings|er)?|shot|stabb(ed|ing)|assault(ed|s)?|sexual|exploitation|abuse|traffick\w*|kidnap\w*|fatal(ity|ities)?|dies|died|death|deaths|deceased|overdose|officer[- ]involved|CIRT|manhunt|missing (child|person|teen|man|woman)|amber alert|lawsuit|sued|scandal|investigation into|crash(es)?|wreck|explosion|evacuat\w*|lockdown)\b/i;
const isSensitive = (c) => SENSITIVE.test(`${c.title || ''} ${c.description || ''}`);
function pickRecentNews(ctx, cands) {
  const seen = new Set();
  return cands.filter((c) => !isSensitive(c)).filter((c) => c.title && c.date && c.date <= addDays(ctx.today, 1) && dayDiff(ctx.today, c.date) <= 180)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .filter((c) => { const k = normKey(c.title); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ============================================================== OpenCities (Granicus) helpers
// OpenCities pages are server-rendered ASP.NET ("seamless" script manager, OpenCities.CustomControls,
// body classes content-type-oc-*, images under /files/assets|sharedassets|content/... with ?dimension=).
// No public RSS/iCal: listings are .list-item-container cards, the homepage has profile-*-listing
// panels, details carry .oc-page-title, .published-on, .main-page-image, li.multi-date-item[data-start-*].
const isOpenCities = (html) => /seamless_script_manager|OpenCities\.CustomControls|\bcontent-type-oc-[a-z]|\.opencities\.com\b/i.test(html || '')
  || (/\/files\/(?:assets|sharedassets|content)\/[^"'\s]*\?dimension=/i.test(html || '') && /\boc-[a-z]/.test(html || ''));
const OC_NEWS_LIST = /^(news-articles|news|all-news|latest-news|news-releases|press-releases|newsroom|news-and-media|media-releases|city-news|county-news)$/;
const OC_EVENT_LIST = /^(events|events-directory|event-directory|event-calendar|events-calendar|community-calendar|city-calendar|county-calendar|calendar|whats-on|upcoming-events)$/;
const OC_NEWS_DEEP = /^\/(news-articles|news|newsroom|news-releases|press-releases)\/.+/i;
const OC_EVENT_DEEP = /^\/(event-folder|events-directory|events|community-calendar|city-calendar|whats-on|event-calendar)\/.+/i;
const ocAttr = (tag, a) => (tag.match(new RegExp(`\\b${a}=["']([^"']*)["']`, 'i')) || [])[1];
const ocText = (h) => stripTags(cleanCtl(String(h || '')));
// WYSIWYG bodies often use <div> blocks instead of <p> (pasted from Outlook): treat block boundaries as paragraphs.
// Bullet lists (charge sheets, agenda items, date lists) are dropped: they read badly as article paragraphs.
const ocBlocks = (h) => `<p>${String(h || '').replace(/<(ul|ol|table)\b[\s\S]*?<\/\1>/gi, '</p><p>').replace(/<\/?(?:p|div|section|h[1-6]|blockquote)\b[^>]*>|<hr\b[^>]*>/gi, '</p><p>')}</p>`;
// Full-size OpenCities image URL: drop ?dimension=…&w=…&h=… (the original is served without it).
function ocImage(html, base, cls) {
  const re = cls ? new RegExp(`<img\\b[^>]*class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>`, 'i') : /<img\b[^>]*>/i;
  const tag = (html.match(re) || [])[0];
  const src = tag && (ocAttr(tag, 'data-src') || ocAttr(tag, 'src'));
  if (!src || src.startsWith('data:')) return null;
  const thumb = absUrl(src, base);
  if (!thumb || BAD_IMG.test(thumb)) return null;
  const u = new URL(thumb);
  for (const k of ['dimension', 'w', 'h', 'width', 'height', 'mode', 'crop', 'quality']) u.searchParams.delete(k);
  let alt = squish(decodeEntities(ocAttr(tag, 'alt') || ''));
  if (/^[\w .-]+\.(jpe?g|png|webp|gif)$/i.test(alt) || /logo|seal|icon/i.test(alt)) alt = '';
  return { url: u.href, thumb, alt };
}
// Keep the original only when it resolves as an image under the size cap; else the sized variant.
async function ocResolveImage(img, signal) {
  if (!img) return null;
  if (img.url === img.thumb) return img;
  const r = await fx(img.url, { method: 'HEAD', as: 'none', timeout: 4000, signal });
  if (r.ok && /^image\//i.test(r.ct) && (!r.len || r.len <= MAX_IMAGE)) return img;
  return { url: img.thumb, alt: img.alt, thumb: img.thumb };
}
// The page's own template region (between OpenCities' normalTemplateStart/End markers).
function ocMain(html) {
  const s = html.indexOf('<!--normalTemplateStart-->');
  if (s < 0) { const i = html.search(/<div\b[^>]*id=["']main-content["']/i); return i >= 0 ? sliceEl(html, i) : ''; }
  const e = html.indexOf('<!--normalTemplateEnd-->', s);
  return html.slice(s, e > s ? e : undefined);
}
// Cards from a listing page (.list-item-container) or a homepage panel (a.profile-list).
function ocCards(html, base) {
  const out = [];
  const push = (b, href) => {
    const link = href && absUrl(href, base);
    if (!link || !/^https?:/i.test(link)) return;
    const title = ocText((b.match(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i) || [])[1]);
    if (!title) return;
    const pub = ocText((b.match(/<p\b[^>]*class=["'][^"']*published-on[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
    const bd = b.match(/class=["']part-date["'][^>]*>\s*(\d{1,2})[\s\S]*?class=["']part-month["'][^>]*>\s*([A-Za-z]{3,})[\s\S]*?class=["']part-year["'][^>]*>\s*(\d{4})/i);
    const evDate = ocText((b.match(/<p\b[^>]*class=["'][^"']*event-date[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
    const desc = ocText((b.match(/class=["']list-item-block-desc["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1])
      || ocText(([...b.matchAll(/<p\b(?![^>]*class=["'][^"']*(?:published-on|event-date|tagged-as|oc-thumbnail|list-item-address|clearfix))[^>]*>([\s\S]*?)<\/p>/gi)].pop() || [])[1]);
    const address = ocText((b.match(/<p\b[^>]*class=["'][^"']*list-item-address[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
    const tags = ocText((b.match(/class=["']text["'][^>]*>([\s\S]*?)<\/span><\/p>/i) || [])[1]).split(/\s*,\s*/).filter(Boolean);
    out.push({ link, title, pub: /published on/i.test(pub) ? pub.replace(/^published on\s*/i, '') : '', blockDate: bd ? `${bd[1]} ${bd[2]} ${bd[3]}` : (evDate || ''), desc, address, tags, image: ocImage(b, base) });
  };
  for (const m of html.matchAll(/<div\b[^>]*class=["'][^"']*\blist-item-container\b[^"']*["'][^>]*>/gi)) {
    const b = sliceEl(html, m.index);
    push(b, ocAttr((b.match(/<a\b[^>]*href=[^>]*>/i) || [''])[0], 'href'));
  }
  for (const m of html.matchAll(/<a\b[^>]*class=["'][^"']*\bprofile-list\b[^"']*["'][^>]*>/gi)) {
    const b = sliceEl(html, m.index);
    push(b, ocAttr(m[0], 'href'));
  }
  return out;
}
// Listing URLs from the homepage: "View more news/events" panel buttons, nav links whose last
// segment is a listing name, and the first segment of deep article/event links.
function ocListings(home, kind) {
  const base = home.url;
  const host = new URL(base).hostname;
  const nameRe = kind === 'news' ? OC_NEWS_LIST : OC_EVENT_LIST;
  const deepRe = kind === 'news' ? OC_NEWS_DEEP : OC_EVENT_DEEP;
  const textRe = kind === 'news' ? /\bnews\b/i : /\b(events?|calendar)\b/i;
  const scored = new Map();
  const add = (u, s) => { if (u && (scored.get(u) || 0) < s) scored.set(u, s); };
  for (const m of home.html.matchAll(/<a\b[^>]*class=["'][^"']*panel-button[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = absUrl(ocAttr(m[0], 'href') || '', base);
    if (u && textRe.test(ocText(m[1])) && sameSite(new URL(u).hostname, host)) add(u.replace(/#.*$/, ''), 3);
  }
  for (const l of links(home.html, base)) {
    const u = new URL(l.href);
    if (!sameSite(u.hostname, host) || /opencities\.com$/i.test(u.hostname) || u.search) continue;
    const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const last = (segs[segs.length - 1] || '').toLowerCase();
    if (segs.length && segs.length <= 3 && nameRe.test(last)) add(u.href, segs.length === 1 ? 2 : 1);
    if (deepRe.test(u.pathname) && segs.length >= 2) add(`${u.origin}/${segs[0]}`, 1);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([u]) => u);
}
// News article detail -> { title, date, paragraphs, image, tags }
function ocParseArticle(html, url, tz) {
  const main = ocMain(html);
  const h1 = main.search(/<h1\b[^>]*class=["'][^"']*oc-page-title/i);
  let region = h1 >= 0 ? main.slice(h1) : main;
  const stop = region.search(/<div\b[^>]*class=["'][^"']*(categories-list-container|oc-related|related-information|side-box)\b/i);
  if (stop > 0) region = region.slice(0, stop);
  const title = ocText((region.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || metaContent(html, 'og:title');
  const pub = ocText((region.match(/<p\b[^>]*class=["'][^"']*published-on[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
  const when = parseWhen(pub.replace(/^published on\s*/i, ''), tz);
  const image = ocImage(region, url, 'main-page-image');
  const body = region.replace(/<h1\b[\s\S]*?<\/h1>/i, '').replace(/<p\b[^>]*class=["'][^"']*published-on[\s\S]*?<\/p>/i, '').replace(/<picture\b[\s\S]*?<\/picture>/gi, '');
  const tags = [...(main.match(/categories-list-container[\s\S]*?<\/ul>/i) || [''])[0].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => ocText(m[1]));
  return { title, date: when && when.date, paragraphs: paragraphsFrom(ocBlocks(body)), image, tags };
}
// Event detail -> raw event (next upcoming occurrence in `tz`).
function ocParseEvent(html, url, ctx) {
  const main = ocMain(html);
  const out = { sourceUrl: url, strategy: 'opencities' };
  out.title = ocText((main.match(/<h1\b[^>]*class=["'][^"']*oc-page-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) || main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
  const now = tzParts(new Date(), ctx.tz);
  const occ = [...main.matchAll(/<li\b[^>]*class=["'][^"']*multi-date-item[^"']*["'][^>]*>/gi)].map((m) => {
    const g = (k) => ocAttr(m[0], `data-${k}`);
    if (!g('start-year')) return null;
    const sd = `${g('start-year')}-${pad(g('start-month'))}-${pad(g('start-day'))}`;
    const ed = g('end-year') ? `${g('end-year')}-${pad(g('end-month'))}-${pad(g('end-day'))}` : sd;
    const st = g('start-hour') != null ? `${pad(g('start-hour'))}:${pad(g('start-mins') || 0)}` : undefined;
    const et = g('end-hour') != null ? `${pad(g('end-hour'))}:${pad(g('end-mins') || 0)}` : undefined;
    const allDay = (!st || st === '00:00') && (!et || et === '23:59' || et === '00:00');
    return { startDate: sd, endDate: ed, startTime: allDay ? undefined : st, endTime: allDay ? undefined : et };
  }).filter(Boolean).filter((o) => o.startDate > ctx.today || (o.startDate === ctx.today && (!o.startTime || o.startTime >= now.time)))
    .sort((a, b) => (a.startDate + (a.startTime || '')).localeCompare(b.startDate + (b.startTime || '')));
  let o = occ[0];
  if (!o) {
    // single-date template: "Next date: Saturday, October 24, 2026 | 05:00 PM to 07:00 PM"
    const ed = ocText((main.match(/<p\b[^>]*class=["'][^"']*event-date[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1]).replace(/^next date:\s*/i, '');
    const w = parseWhen(ed, ctx.tz);
    if (w) { const rng = parseClockRange(ed.replace(/\b\d{4}\b/g, '')); o = { startDate: w.date, startTime: rng.start, endTime: rng.end, endDate: rng.end ? w.date : undefined }; }
  }
  if (o) Object.assign(out, o);
  // Location: the <p>s under <h2 class="sub-title">Location</h2>, minus map links and URLs.
  const locM = main.match(/<h2\b[^>]*class=["'][^"']*sub-title[^"']*["'][^>]*>\s*(?:Location|Where|Venue)\s*<\/h2>([\s\S]*?)(?=<h2\b|<div\b)/i);
  if (locM) {
    const ps = [...locM[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => ({ map: /maps\.google|View Map/i.test(m[1]), t: ocText(m[1].replace(/<a\b[^>]*>\s*View Map\s*<\/a>/gi, '')) }))
      .map((p) => ({ ...p, t: p.t.replace(/,?\s*View Map\s*$/i, '').replace(/\s*,\s*,+/g, ',').replace(/,\s*$/, '').replace(/,\s*(\d{5}(?:-\d{4})?)\b/g, ' $1') }))
      .filter((p) => p.t && !/https?:\/\/|zoom|teams\.microsoft|webex/i.test(p.t));
    // the address paragraph (map link) wins; short notes ("Embarcadero Room") are kept, directions are not
    const parts = ps.some((p) => p.map) ? ps.filter((p) => p.map || (p.t.length <= 40 && !/[.!?]$/.test(p.t))).map((p) => p.t) : ps.map((p) => p.t);
    const segs = []; for (const s of parts.join(', ').split(/\s*,\s*/)) if (s && !segs.some((x) => x.toLowerCase() === s.toLowerCase())) segs.push(s);
    out.location = segs.join(', ');
  }
  // Body: the description above the When/Location blocks; stop at the first sub-heading/accordion.
  let body = main.replace(/<h1\b[\s\S]*?<\/h1>/i, '').replace(/<p\b[^>]*class=["'][^"']*event-date[\s\S]*?<\/p>/i, '').replace(/<picture\b[\s\S]*?<\/picture>/gi, '');
  const cut = body.search(/<h2\b|<div\b[^>]*class=["'][^"']*(oc-wysiwyg-container|multi-date-list-container|side-box|categories-list-container)\b/i);
  if (cut > 0) body = body.slice(0, cut);
  // date-only occurrence (no data-start-hour): take the time written next to that date in the body
  if (out.startDate && !out.startTime) {
    const [, mo, da] = out.startDate.split('-').map(Number);
    const txt = ocText(body.replace(/<br\s*\/?>/gi, ' '));
    const at = txt.search(new RegExp(`\\b${MONTHS[mo - 1].slice(0, 3)}[a-z]*\\.?\\s+${da}\\b`, 'i'));
    if (at >= 0) { const rng = parseClockRange(txt.slice(at, at + 90).replace(/\b\d{4}\b/g, '')); if (rng.start) { out.startTime = rng.start; out.endTime = rng.end; if (rng.end) out.endDate = out.startDate; } }
  }
  out.bodyParagraphs = paragraphsFrom(ocBlocks(body)).filter((p) => !/^(dates?|times?|location|where|when|cost|fees?|ages?|price|registration|event type|calendar)\s*:/i.test(p));
  const img = ocImage(main, url, 'main-page-image');
  if (img) { out.image = img.url; out.imageThumb = img.thumb; }
  return out;
}
async function ocHome(ctx) {
  const home = await ctx.home;
  return home && isOpenCities(home.html) ? home : null;
}
// Fetch up to `max` listing pages (cached on ctx, shared by the news and event strategies).
async function ocListingCards(ctx, home, kind, max = 3) {
  const urls = ocListings(home, kind);
  const guesses = (kind === 'news' ? ['/News-Articles', '/News'] : ['/Events-Directory', '/Events']).map((p) => ctx.origin + p);
  const pages = urls.length ? urls.slice(0, max) : guesses;
  const res = await Promise.all(pages.map((u) => ctx.get(u, { timeout: 9000 })));
  const cards = ocCards(home.html, home.url).map((c) => ({ ...c, from: 'home' }));
  const used = [];
  res.forEach((r, i) => { if (r.ok && r.text && isOpenCities(r.text)) { const cs = ocCards(r.text, r.url); if (cs.length) used.push(pages[i]); cards.push(...cs); } });
  const seen = new Set();
  return { cards: cards.filter((c) => !seen.has(c.link) && seen.add(c.link)), used, pages };
}

const NEWS_STRATEGIES = {
  async 'wp-rest'(ctx, signal) {
    const tryHost = async (host) => {
      const r = await fx(`${host}/wp-json/wp/v2/posts?per_page=${Math.max(10, ctx.need * 4)}&_embed=wp:featuredmedia,wp:term`, { as: 'json', timeout: 12000, signal });
      if (!r.ok || !Array.isArray(r.json) || !r.json.length) return [];
      return r.json.map((p) => {
        const fm = ((p._embedded || {})['wp:featuredmedia'] || [])[0];
        let img = null;
        if (fm && fm.source_url && /^image\//.test(fm.mime_type || 'image/')) {
          const sizes = (fm.media_details && fm.media_details.sizes) || {};
          const size = Number(fm.media_details && fm.media_details.filesize) || 0;
          const url = size && size > MAX_IMAGE ? ((sizes.large || sizes.medium_large || {}).source_url || fm.source_url) : fm.source_url;
          img = { url, alt: squish(decodeEntities(fm.alt_text || '')) };
        }
        const terms = ((p._embedded || {})['wp:term'] || []).flat().filter((t) => t && t.taxonomy === 'category').map((t) => t.name);
        return {
          title: stripTags(p.title && p.title.rendered), date: (parseWhen(p.date, ctx.tz) || {}).date, link: p.link,
          paragraphs: paragraphsFrom((p.content && p.content.rendered) || ''), description: stripTags(p.excerpt && p.excerpt.rendered).replace(/\s*(\[…\]|\[\.\.\.\]|…|continue reading.*|read more.*)$/i, ''),
          image: img && !BAD_IMG.test(img.url) ? img : null, cats: terms, strategy: 'wp-rest', host,
        };
      });
    };
    const first = await tryHost(ctx.origin);
    let cands = first;
    if (pickRecentNews(ctx, cands).length < ctx.need) {
      const d = await ctx.disc;
      const more = await Promise.all(d.hosts.map(tryHost));
      cands = [...cands, ...more.flat()];
    }
    const recent = pickRecentNews(ctx, cands).slice(0, ctx.need * 2 + 1);
    return { items: (await enrichNews(ctx, recent, signal)).filter(Boolean), note: recent[0] ? `host ${recent[0].host}` : 'no posts' };
  },

  async rss(ctx, signal) {
    const guesses = ['/feed/', '/rss.xml', '/news/rss.xml', '/rss', '/news/rss', '/news/feed/'].map((p) => ctx.origin + p);
    const d = await ctx.disc;
    const urls = [...new Set([...d.feeds, ...guesses, ...d.hosts.map((h) => `${h}/feed/`)])];
    const res = await Promise.all(urls.map((u) => fx(u, { timeout: 8000, signal })));
    let cands = []; const used = [];
    res.forEach((r, i) => {
      if (!r.ok || !isFeedText(r.text)) return;
      const f = parseFeed(r.text, r.url);
      if (f.calendar) return;
      used.push(urls[i]);
      const newsy = /news|press|release|blog|stories|updates|alerts/i.test(`${urls[i]} ${f.channelTitle}`);
      for (const it of f.items) {
        if (!newsy && it.link) { const p = new URL(it.link).pathname; const last = p.replace(/\/+$/, '').split('/').pop() || ''; if (!(/\/(news|press|releases?|articles?|stor(y|ies)|blog|posts?|latest-news|newsroom)\//i.test(p) || last.split('-').length >= 5)) continue; }
        const body = it.html ? paragraphsFrom(it.html) : [];
        const imgInBody = it.html ? firstImage(it.html, r.url) : null;
        cands.push({ title: it.title, date: (parseWhen(it.pub, ctx.tz) || {}).date, link: it.link, paragraphs: body.join(' ').length >= 300 ? body : [], image: it.image && !BAD_IMG.test(it.image) ? { url: it.image, alt: '' } : imgInBody, cats: it.cats, strategy: 'rss' });
      }
    });
    const seenLink = new Set();
    cands = cands.filter((c) => !c.link || (!seenLink.has(c.link) && seenLink.add(c.link)));
    const recent = pickRecentNews(ctx, cands).slice(0, ctx.need * 2 + 1);
    return { items: (await enrichNews(ctx, recent, signal)).filter(Boolean), note: used.length ? `feeds: ${used.join(' ')}` : 'no feed found' };
  },

  async civicplus(ctx, signal) {
    const url = `${ctx.origin}/RSSFeed.aspx?ModID=1&CID=All-newsflash.xml`;
    const r = await fx(url, { timeout: 8000, signal });
    if (!r.ok || !isFeedText(r.text)) return { items: [], note: 'no CivicPlus News Flash feed' };
    const f = parseFeed(r.text, r.url);
    const cands = f.items.map((it) => ({ title: it.title, date: (parseWhen(it.pub, ctx.tz) || {}).date, link: it.link, description: stripTags(it.html), image: it.image ? { url: it.image, alt: '' } : null, cats: it.cats, strategy: 'civicplus' }));
    const recent = pickRecentNews(ctx, cands).slice(0, ctx.need * 2 + 1);
    return { items: (await enrichNews(ctx, recent, signal)).filter(Boolean), note: url };
  },

  async opencities(ctx, signal) {
    const home = await ocHome(ctx);
    if (!home) return { items: [], note: 'not OpenCities' };
    const { cards, used, pages } = await ocListingCards(ctx, home, 'news');
    const host = new URL(home.url).hostname;
    const newsy = cards.filter((c) => {
      const u = new URL(c.link);
      if (!sameSite(u.hostname, host) || /\.(pdf|docx?|xlsx?)$/i.test(u.pathname)) return false;
      return c.pub || OC_NEWS_DEEP.test(u.pathname);
    }).map((c) => ({ ...c, date: (parseWhen(c.pub, ctx.tz) || {}).date }));
    let pick = pickRecentNews(ctx, newsy).slice(0, ctx.need + 3);
    if (pick.length < ctx.need) pick = [...pick, ...newsy.filter((c) => !c.date)].slice(0, ctx.need + 5);
    const got = await pool(pick, 6, async (c) => {
      const r = await fx(c.link, { timeout: 8000, signal });
      if (!r.ok || !r.text || !/html/i.test(r.ct)) return null;
      const a = isOpenCities(r.text) ? ocParseArticle(r.text, r.url, ctx.tz) : null;
      const g = !a || a.paragraphs.length === 0 || !a.date ? parseArticle(r.text, r.url, ctx.tz) : null;
      const t0 = normKey((a && a.title) || c.title || '');
      const paragraphs = (a && a.paragraphs.length ? a.paragraphs : (g ? g.paragraphs : [])).filter((p) => normKey(p) !== t0);
      const image = await ocResolveImage((a && a.image) || c.image || (g && g.image) || null, signal);
      return normNews({
        title: (a && a.title) || c.title || (g && g.title), date: (a && a.date) || c.date || (g && g.date),
        description: c.desc && c.desc.length >= 40 ? c.desc : undefined, bodyParagraphs: paragraphs,
        leadImageUrl: image && image.url, leadImageThumb: image && image.thumb, leadImageAlt: image && image.alt,
        sourceUrl: r.url, categories: (a && a.tags.length ? a.tags : c.tags), tz: ctx.tz,
      }, 'opencities');
    });
    return { items: pickRecentNews(ctx, got.filter(Boolean)), note: `listing: ${(used.length ? used : pages).join(' ')} (${newsy.length} cards)` };
  },

  async html(ctx, signal) {
    const d = await ctx.disc;
    const pages = await Promise.all(d.newsPages.map((u) => fx(u, { timeout: 8000, signal })));
    let cands = [];
    pages.forEach((r) => {
      if (!r.ok || !r.text) return;
      const lp = new URL(r.url);
      const ls = links(r.text, r.url);
      const seen = new Set();
      ls.forEach((l, i) => {
        const u = new URL(l.href);
        if (!sameSite(u.hostname, lp.hostname) || seen.has(l.href)) return;
        const last = u.pathname.replace(/\/+$/, '').split('/').pop() || '';
        const looksArticle = (last.split('-').length >= 4 || /[?&](aid|id|articleid)=\d+/i.test(u.search)) && !/\b(category|tag|topics?|page|feed|rss|search|subscribe|archive|directory|policy|social)\b/i.test(u.pathname) && l.text.length >= 15;
        if (!looksArticle) return;
        seen.add(l.href);
        const win = r.text.slice(l.index, (ls[i + 1] ? ls[i + 1].index : l.index + 1500));
        const t = win.match(/<time\b[^>]*datetime=["']([^"']+)["']/i);
        const when = t ? parseWhen(t[1], ctx.tz) : parseWhen(stripTags(win).slice(0, 300), ctx.tz);
        cands.push({ title: l.text, date: when && when.date, link: l.href, strategy: 'html' });
      });
    });
    // Undated links: fetch a few and read the date from the article itself.
    let dated = pickRecentNews(ctx, cands);
    if (dated.length < ctx.need) {
      const undated = cands.filter((c) => !c.date).slice(0, 10);
      const got = await enrichNews(ctx, undated, signal);
      const extra = got.filter(Boolean);
      const items = pickRecentNews(ctx, [...(await enrichNews(ctx, dated.slice(0, ctx.need + 2), signal)).filter(Boolean), ...extra]);
      return { items, note: `listing: ${d.newsPages.join(' ')} (+${undated.length} undated links read)` };
    }
    dated = dated.slice(0, ctx.need + 2);
    return { items: (await enrichNews(ctx, dated, signal)).filter(Boolean), note: `listing: ${d.newsPages.join(' ')}` };
  },
};

// ============================================================== event strategies
function upcoming(ctx, list) {
  const seen = new Set();
  const now = tzParts(new Date(), ctx.tz);
  return list.filter(Boolean).filter((e) => e.startDate > ctx.today || (e.startDate === ctx.today && (!e.startTime || e.startTime >= now.time)))
    .sort((a, b) => (a.startDate + (a.startTime || '')).localeCompare(b.startDate + (b.startTime || '')))
    .filter((e) => { const k = normKey(e.title); if (seen.has(k)) return false; seen.add(k); return true; });
}
// Event detail page -> raw event fields
function parseEventPage(html, url, tz) {
  const ld = jsonLd(html).find((o) => ldType(o, /Event$/i));
  const out = { sourceUrl: url };
  if (ld) {
    out.title = stripTags(ld.name);
    const s = parseWhen(ld.startDate, tz); const e = parseWhen(ld.endDate, tz);
    if (s) { out.startDate = s.date; out.startTime = s.time; }
    if (e) { out.endDate = e.date; out.endTime = e.time; }
    const loc = [].concat(ld.location || [])[0];
    if (loc) {
      const a = loc.address || {};
      out.location = typeof loc === 'string' ? loc : [loc.name, typeof a === 'string' ? a : [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ')].filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i).join(', ');
    }
    if (ld.description) out.description = stripTags(ld.description);
  }
  const main = findContainer(html, ['tribe-events-single', 'event-detail', 'event_detail', 'node--type-event'], 80);
  const mainAt = html.search(/<main\b/i);
  const wide = mainAt >= 0 ? sliceEl(html, mainAt) : main;
  const text = removeNoise(wide).replace(/<(br|\/div|\/li|\/h[1-6]|\/p|\/dt|\/dd|\/td|\/th|\/span)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const lines = text.split('\n').map((x) => squish(decodeEntities(x))).filter(Boolean);
  const labelled = (re) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(new RegExp(`^(?:${re.source})\\s*:?\\s*(.*)$`, 'i'));
      if (m) { const v = squish(m[m.length - 1] || ''); if (v.length >= 3) return v; if (lines[i + 1] && lines[i + 1].length < 160) return lines[i + 1]; }
    }
    return '';
  };
  if (!out.title) out.title = cleanTitle(bestH1(html), [new URL(url).hostname.replace(/^www\./, '')]);
  if (!out.startDate) {
    const iso = text.match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:?\d\d)?)/);
    const dv = labelled(/date\s*(?:&|and)\s*time|event dates?|dates?|when/);
    const p = parseWhen(dv, tz) || (iso && parseWhen(iso[1], tz));
    if (p) {
      out.startDate = p.date;
      const tv = labelled(/event times?|times?|hours/) || dv;
      const rng = parseClockRange(tv.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, ''));
      out.startTime = rng.start || p.time; out.endTime = rng.end;
    }
  }
  if (!out.location) {
    let loc = labelled(/location|where|venue|address/);
    if (!loc || loc.toLowerCase() === (out.title || '').toLowerCase()) loc = (text.match(/\bLocation:\s*([^\n]{5,140})/i) || [])[1] || '';
    out.location = loc;
  }
  const body = findContainer(html, BODY_CLASSES, 60);
  out.bodyParagraphs = paragraphsFrom(body === html ? main : body).filter((p) => !/^(date|time|location|where|when|cost|event type|calendar)\b/i.test(p));
  return out;
}
async function enrichEvents(ctx, raws, signal, { always = false } = {}) {
  return pool(raws, 6, async (raw) => {
    if ((always || !raw.bodyParagraphs || !raw.bodyParagraphs.length || !raw.location) && raw.sourceUrl) {
      const r = await fx(raw.sourceUrl, { timeout: 8000, signal });
      if (r.ok && r.text && /html/i.test(r.ct)) {
        const p = parseEventPage(r.text, r.url, ctx.tz);
        raw = { ...p, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v && (!Array.isArray(v) || v.length))) };
        if ((!raw.bodyParagraphs || !raw.bodyParagraphs.length) && p.bodyParagraphs) raw.bodyParagraphs = p.bodyParagraphs;
        if (!raw.location && p.location) raw.location = p.location;
      }
    }
    return normEvent(raw, raw.strategy);
  });
}

function parseIcs(text, tz) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  return [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => {
    const f = {};
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^([A-Z-]+)(;[^:]*)?:(.*)$/);
      if (mm && !f[mm[1]]) f[mm[1]] = { params: mm[2] || '', value: mm[3].replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1') };
    }
    const when = (k) => {
      if (!f[k]) return null;
      const tzid = (f[k].params.match(/TZID=([^;:]+)/) || [])[1];
      const v = f[k].value.trim();
      if (tzid && /T\d{4}/.test(v) && !v.endsWith('Z')) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time: `${v.slice(9, 11)}:${v.slice(11, 13)}` };
      return parseWhen(v, tz);
    };
    const s = when('DTSTART'); const e = when('DTEND');
    const allDay = f.DTSTART && /VALUE=DATE(?!-)/.test(f.DTSTART.params);
    const desc = f.DESCRIPTION ? f.DESCRIPTION.value : '';
    return {
      title: f.SUMMARY && f.SUMMARY.value, startDate: s && s.date, startTime: allDay ? undefined : s && s.time,
      endDate: e && (allDay ? addDays(e.date, -1) : e.date), endTime: allDay ? undefined : e && e.time,
      location: f.LOCATION && f.LOCATION.value, sourceUrl: f.URL && f.URL.value,
      bodyParagraphs: desc.split(/\n+/).map(squish), rrule: !!f.RRULE,
    };
  });
}

const EVENT_STRATEGIES = {
  async tribe(ctx, signal) {
    const tryHost = async (host) => {
      const r = await fx(`${host}/wp-json/tribe/events/v1/events?per_page=${ctx.need * 6}&start_date=${ctx.today}`, { as: 'json', timeout: 12000, signal });
      if (!r.ok || !r.json || !Array.isArray(r.json.events)) return [];
      return r.json.events.map((e) => {
        const s = parseWhen(e.start_date, ctx.tz); const en = parseWhen(e.end_date, ctx.tz);
        const v = Array.isArray(e.venue) ? null : e.venue;
        const loc = v ? [v.venue, v.address, [v.city, [v.state || v.stateprovince, v.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].map((x) => squish(decodeEntities(x || ''))).filter(Boolean) : [];
        return {
          title: stripTags(e.title), startDate: s && s.date, startTime: e.all_day ? undefined : s && s.time, endDate: en && en.date, endTime: e.all_day ? undefined : en && en.time,
          location: [...new Set(loc)].join(', '), sourceUrl: e.url, bodyParagraphs: paragraphsFrom(e.description || ''), description: stripTags(e.excerpt || ''), strategy: 'tribe',
        };
      });
    };
    let raws = await tryHost(ctx.origin);
    if (upcoming(ctx, raws).length < ctx.need) { const d = await ctx.disc; raws = [...raws, ...(await Promise.all(d.hosts.map(tryHost))).flat()]; }
    const picked = upcoming(ctx, raws.map((r) => ({ ...r, title: cleanTitle(r.title) }))).slice(0, ctx.need + 2);
    return { items: upcoming(ctx, await enrichEvents(ctx, picked, signal)), note: raws.length ? `${raws.length} events listed` : 'no Tribe API' };
  },

  async civicplus(ctx, signal) {
    const url = `${ctx.origin}/RSSFeed.aspx?ModID=58&CID=All-calendar.xml`;
    const r = await fx(url, { timeout: 8000, signal });
    if (!r.ok || !isFeedText(r.text)) return { items: [], note: 'no CivicPlus calendar feed' };
    const f = parseFeed(r.text, r.url);
    const raws = f.items.map((it) => {
      const dates = it.cal.dates || stripTags(it.html).match(/Event dates?:\s*([^|]+?)(Event Time|Location|$)/i)?.[1] || '';
      const [d1, d2] = dates.split(/\s+-\s+/);
      const s = parseWhen(d1, ctx.tz); const e = d2 ? parseWhen(d2, ctx.tz) : null;
      const rng = parseClockRange(it.cal.times || '');
      const allDay = /12:00 AM\s*-\s*11:59 PM/i.test(it.cal.times || '');
      return { title: it.title, startDate: s && s.date, endDate: e && e.date, startTime: allDay ? undefined : rng.start, endTime: allDay ? undefined : rng.end, location: squish((it.cal.location || '').replace(/([a-z.])([A-Z][a-z]+, [A-Z]{2}\b)/, '$1, $2')), sourceUrl: it.link, strategy: 'civicplus' };
    });
    // multi-week ranges (e.g. an academy Sep–Nov) are not "upcoming" items for a homepage
    const picked = upcoming(ctx, raws.filter((x) => !x.endDate || dayDiff(x.endDate, x.startDate) <= 3)).slice(0, ctx.need + 2);
    return { items: upcoming(ctx, await enrichEvents(ctx, picked, signal, { always: true })), note: url };
  },

  async opencities(ctx, signal) {
    const home = await ocHome(ctx);
    if (!home) return { items: [], note: 'not OpenCities' };
    const { cards, used, pages } = await ocListingCards(ctx, home, 'events');
    const host = new URL(home.url).hostname;
    const evs = cards.filter((c) => c.blockDate && !c.pub && sameSite(new URL(c.link).hostname, host)).map((c) => {
      const w = parseWhen(c.blockDate, ctx.tz);
      return { ...c, startDate: w && w.date };
    }).filter((c) => c.startDate && c.startDate >= ctx.today);
    // listing order is by next date; read the detail pages for the real next occurrence/time/place
    const byDate = evs.sort((a, b) => a.startDate.localeCompare(b.startDate) || (OC_EVENT_DEEP.test(new URL(b.link).pathname) - OC_EVENT_DEEP.test(new URL(a.link).pathname)));
    const seen = new Set();
    const pick = byDate.filter((c) => { const k = normKey(c.title); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, ctx.need + 4);
    const got = await pool(pick, 7, async (c) => {
      const r = await fx(c.link, { timeout: 8000, signal });
      let raw = { title: c.title, startDate: c.startDate, location: c.address, bodyParagraphs: c.desc ? [c.desc] : [], sourceUrl: c.link, strategy: 'opencities' };
      if (r.ok && r.text && /html/i.test(r.ct)) {
        const p = isOpenCities(r.text) ? ocParseEvent(r.text, r.url, ctx) : null;
        if (p && p.startDate) {
          raw.rich = true;
          raw = { ...raw, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v && (!Array.isArray(v) || v.length))) };
          if (!p.bodyParagraphs.length && c.desc) raw.bodyParagraphs = [c.desc];
        } else if (p && !p.startDate && /multi-date-item|event-date/i.test(r.text)) return null; // only past occurrences left
        else if (!p) { const g = parseEventPage(r.text, r.url, ctx.tz); if (g.bodyParagraphs && g.bodyParagraphs.length && !c.desc) raw.bodyParagraphs = g.bodyParagraphs; }
      }
      const e = normEvent(raw, 'opencities');
      return e && { e, rich: !!raw.rich };
    });
    // prefer events whose detail page is a real OpenCities event (time + place); cards that link off-site
    // (e.g. ActiveNet registrations) only fill the remaining slots
    const rich = upcoming(ctx, got.filter((x) => x && x.rich).map((x) => x.e));
    const poor = upcoming(ctx, got.filter((x) => x && !x.rich).map((x) => x.e));
    const items = rich.length >= ctx.need ? rich : upcoming(ctx, [...rich, ...poor.slice(0, ctx.need - rich.length)]);
    return { items, note: `listing: ${(used.length ? used : pages).join(' ')} (${evs.length} upcoming cards)` };
  },

  async ical(ctx, signal) {
    const d = await ctx.disc;
    if (!d.icals.length) return { items: [], note: 'no .ics link on the homepage' };
    const res = await Promise.all(d.icals.map((u) => fx(u.replace(/^webcal:/i, 'https:'), { timeout: 8000, signal })));
    const raws = [];
    res.forEach((r) => { if (r.ok && /BEGIN:VCALENDAR/.test(r.text || '')) raws.push(...parseIcs(r.text, ctx.tz).filter((e) => !e.rrule).map((e) => ({ ...e, sourceUrl: e.sourceUrl || r.url, strategy: 'ical' }))); });
    const picked = upcoming(ctx, raws).slice(0, ctx.need + 2);
    return { items: upcoming(ctx, picked.map((x) => normEvent(x, 'ical'))), note: d.icals.join(' ') };
  },

  async legistar(ctx, signal) {
    const d = await ctx.disc;
    if (!d.legistar.length) return { items: [], note: 'no legistar link on the homepage' };
    const out = [];
    for (const client of d.legistar) {
      const q = `$filter=EventDate+ge+datetime'${ctx.today}'&$orderby=EventDate+asc&$top=${ctx.need * 10}`;
      const r = await fx(`https://webapi.legistar.com/v1/${client}/events?${q}`, { as: 'json', timeout: 10000, signal });
      if (!r.ok || !Array.isArray(r.json)) continue;
      for (const e of r.json) {
        if (/cancel|postpon/i.test(`${e.EventAgendaStatusName} ${e.EventComment || ''}`)) continue;
        const body = squish(e.EventBodyName || '');
        if (!body) continue;
        const title = /\b(meeting|hearing|session|workshop|retreat)\b/i.test(body) ? body : `${body} Meeting`;
        const s = parseWhen(e.EventDate, ctx.tz);
        const startTime = parseClock(e.EventTime || '');
        const location = squish(e.EventLocation || '');
        const ev = { title, startDate: s && s.date, startTime, location, sourceUrl: e.EventInSiteURL || `https://${client}.legistar.com/Calendar.aspx`, strategy: 'legistar' };
        const paras = [`The ${body} meets on ${s ? longDate(s.date) : ''}${startTime ? ` at ${time12(startTime)}` : ''}${location ? ` at ${location}` : ''}`.replace(/\.?$/, '.')];
        if (e.EventComment && e.EventComment.length > 20) paras.push(squish(e.EventComment));
        if (e.EventAgendaFile) paras.push('The meeting agenda is posted on the public meeting portal.');
        ev.bodyParagraphs = paras;
        out.push(ev);
      }
      if (upcoming(ctx, out).length >= ctx.need) break;
    }
    return { items: upcoming(ctx, out.map((x) => normEvent(x, 'legistar'))).slice(0, ctx.need + 2), note: `clients: ${d.legistar.join(', ')}` };
  },

  async html(ctx, signal) {
    const d = await ctx.disc;
    const pages = await Promise.all(d.eventPages.map((u) => fx(u, { timeout: 9000, signal })));
    let raws = []; const details = new Set();
    for (const r of pages) {
      if (!r.ok || !r.text) continue;
      // 1. JSON-LD events on the listing
      for (const o of jsonLd(r.text).filter((x) => ldType(x, /Event$/i))) raws.push({ ...parseEventPage(`<script type="application/ld+json">${JSON.stringify(o)}</script>`, absUrl(o.url || r.url, r.url), ctx.tz), strategy: 'html' });
      // 2. calendar widgets embedded as JSON (Drupal fullcalendar_view & co): objects with title + start + url
      for (const m of r.text.matchAll(/<script[^>]*(?:drupal-settings-json|application\/json)[^>]*>([\s\S]*?)<\/script>/gi)) {
        let j; try { j = JSON.parse(m[1]); } catch { continue; }
        const walk = (x) => {
          if (Array.isArray(x)) { x.forEach(walk); return; }
          if (!x || typeof x !== 'object') return;
          if (typeof x.title === 'string' && typeof x.start === 'string' && x.url) {
            const s = parseWhen(x.start, ctx.tz); const e = x.end ? parseWhen(x.end, ctx.tz) : null;
            raws.push({ title: stripTags(x.title), startDate: s && s.date, startTime: s && s.time !== '00:00' ? s.time : undefined, endDate: e && e.date, endTime: e && e.time !== (s && s.time) ? e.time : undefined, sourceUrl: absUrl(x.url, r.url), bodyParagraphs: x.fulldescription ? paragraphsFrom(`<p>${String(x.fulldescription).replace(/(Meeting Materials|Follow the Meeting|Location:)/g, '</p><p>$1')}</p>`) : [], strategy: 'html' });
            return;
          }
          Object.values(x).forEach(walk);
        };
        walk(j);
      }
      // 3. detail links under the listing path
      const lp = new URL(r.url);
      const prefix = lp.pathname.replace(/\/+$/, '');
      for (const l of links(r.text, r.url)) {
        const u = new URL(l.href);
        if (!sameSite(u.hostname, lp.hostname) || u.search.includes('page=') || /\.(ics|pdf)$/i.test(u.pathname)) continue;
        const p = u.pathname.replace(/\/+$/, '');
        const under = (prefix && p.startsWith(`${prefix}/`) && p.split('/').length === prefix.split('/').length + 1) || /\/(event|events)\/[a-z0-9-]{8,}$/i.test(p) || /[?&]EID=\d+/i.test(u.search);
        if (under && !/\b(category|categories|list|month|week|day|tag|type)\b/i.test(p) && l.text.length >= 6) details.add(l.href);
      }
    }
    const listed = upcoming(ctx, raws);
    if (listed.length >= ctx.need) return { items: upcoming(ctx, await enrichEvents(ctx, listed.slice(0, ctx.need + 2), signal)), note: `listing JSON: ${d.eventPages.join(' ')}` };
    const urls = [...details].slice(0, 12);
    const got = await pool(urls, 8, async (u) => {
      const r = await fx(u, { timeout: 8000, signal });
      return r.ok && r.text ? { ...parseEventPage(r.text, r.url, ctx.tz), strategy: 'html' } : null;
    });
    return { items: upcoming(ctx, [...listed, ...got.filter(Boolean)].map((x) => normEvent(x, 'html'))), note: `listing: ${d.eventPages.join(' ')} (${urls.length} detail pages)` };
  },
};

// Run strategies in parallel. Strategies are listed best-first; a hit by a lower-priority
// strategy waits up to GRACE_MS for the better ones still running, then the best hit wins.
// Everything stops at the cutoff.
const GRACE_MS = 6000;
function race(kind, strategies, ctx) {
  const ctl = new AbortController();
  const names = Object.keys(strategies);
  const attempts = names.map((name) => ({ strategy: name, status: 'running', count: 0, ms: 0, note: '' }));
  return new Promise((resolve) => {
    let done = false; let pending = names.length; let graceTimer = null; const results = {};
    const bestHit = () => names.find((n, i) => attempts[i].status === 'hit') || null;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(graceTimer); ctl.abort();
      const winner = bestHit();
      for (const a of attempts) if (a.status === 'running') { a.status = winner ? 'cancelled' : 'cutoff'; a.ms = Date.now() - RT.t0; }
      resolve({ winner, attempts, results });
    };
    const settle = () => {
      if (done) return;
      const w = bestHit();
      if (!w) { if (pending === 0) finish(); return; }
      const better = names.slice(0, names.indexOf(w)).some((n, i) => attempts[i].status === 'running');
      if (!better) { finish(); return; }
      if (!graceTimer) graceTimer = setTimeout(finish, Math.max(0, Math.min(GRACE_MS, RT.cutoff - Date.now())));
    };
    const timer = setTimeout(finish, Math.max(0, RT.cutoff - Date.now()));
    names.forEach((name, i) => {
      const t = Date.now(); const a = attempts[i];
      Promise.resolve().then(() => strategies[name](ctx, ctl.signal)).then((r) => {
        if (done) return;
        const items = (r && r.items || []).filter(Boolean);
        results[name] = items;
        Object.assign(a, { status: items.length >= ctx.need ? 'hit' : items.length ? 'partial' : 'empty', count: items.length, ms: Date.now() - t, note: (r && r.note) || '' });
      }).catch((e) => {
        if (done) return;
        Object.assign(a, { status: 'error', ms: Date.now() - t, note: String(e && e.message || e).slice(0, 160) });
      }).finally(() => { pending--; settle(); });
    });
  });
}

// ============================================================== DA helpers
const auth = () => ({ Authorization: `Bearer ${RT.token}` });
async function daGet(path, as = 'text', timeout = 10000) { return fx(`${DA}/source/${ORG}/${REPO}/${path}`, { headers: auth(), as, timeout }); }
async function daList(path) { const r = await fx(`${DA}/list/${ORG}/${REPO}/${path}`, { headers: auth(), as: 'json', timeout: 10000 }); return r.ok && Array.isArray(r.json) ? r.json : null; }
async function daPut(path, bytes, type) {
  const fd = new FormData();
  fd.append('data', new Blob([bytes], { type }), pathMod.basename(path));
  const r = await fx(`${DA}/source/${ORG}/${REPO}/${path}`, { method: 'PUT', headers: auth(), body: fd, timeout: 20000, as: 'none', reserve: 200 });
  return r.status || r.err;
}
async function hlx(action, path, method = 'POST') {
  const r = await fx(`${HLX}/${action}/${ORG}/${REPO}/main/${path}`, { method, headers: auth(), timeout: 25000, as: 'none', reserve: 200 });
  return r.status || r.err;
}

// ============================================================== blueprint fallback
// The blueprint's own examples are the fallback molds (fetched live, in parallel with sourcing).
const MOLD_ORDER = ['rabid-raccoon-confirmed', 'two-beaches-closed-to-bathing', 'vector-mosquito-spraying', 'city-council-regular-meeting', 'business-funding-webinar', 'rfp-waiver-committee-special-meeting'];
const moldRank = (n) => { const i = MOLD_ORDER.indexOf(n); return i < 0 ? 99 : i; };
function snapshotMolds() {
  const out = { news: [], events: [] };
  for (const k of ['news', 'events']) for (const m of BLUEPRINT_SNAPSHOT[k]) { const html = wrapDoc(m.main); out[k].push({ name: m.name, html, meta: readMeta(html), snapshot: true }); }
  return out;
}
async function loadBlueprint() {
  const out = { news: [], events: [] };
  const [ln, le] = await Promise.all([daList('blueprint/news'), daList('blueprint/events')]);
  const pick = async (kind, list) => {
    const files = (list || []).filter((f) => f.ext === 'html').sort((a, b) => moldRank(a.name) - moldRank(b.name) || a.name.localeCompare(b.name));
    const docs = await Promise.all(files.map(async (f) => { const r = await daGet(`blueprint/${kind}/${f.name}.html`, 'buf'); return r.ok ? { name: f.name, html: r.buf.toString('utf8') } : null; }));
    const seen = new Set();
    for (const d of docs.filter(Boolean)) {
      const meta = readMeta(d.html);
      const tpl = (meta.template || '').toLowerCase();
      if (kind === 'news' && tpl !== 'news-article' && !meta['publication-date']) continue;
      if (kind === 'events' && tpl !== 'event-detail' && !meta['start-date']) continue;
      if (/cancel|postpon/i.test(meta.title || '')) continue;
      const k = normKey(cleanCtl(meta.title || d.name));
      if (seen.has(k)) continue; // "City Council Regular Meeting — May/June" are one mold
      seen.add(k);
      out[kind].push({ ...d, meta });
    }
  };
  await Promise.all([pick('news', ln), pick('events', le)]);
  return out;
}
function readMeta(html) {
  const at = html.indexOf('class="metadata"');
  const src = at < 0 ? '' : html.slice(at);
  const meta = {};
  const re = /<div><div>(?:<p>)?([\s\S]*?)(?:<\/p>)?<\/div><div>(?:<p>)?([\s\S]*?)(?:<\/p>)?<\/div><\/div>/g;
  let m;
  while ((m = re.exec(src))) meta[stripTags(m[1]).toLowerCase()] = stripTags(m[2]);
  return meta;
}
// Step 4's longest-first entity replacement, then a deterministic locality reword.
function localize(text, entity) {
  let t = text.replace(/City County Government/g, `${entity} Government`).replace(/City County/g, entity);
  t = t.replace(/\b[Tt]he (county|city)['’]s\b/g, `${entity}’s`);
  t = t.replace(/\b[Tt]he (county|city)\b(?=\s+(?:has|have|had|is|was|will|and|to|in|for|on|at|as|publishes|announces|reports|said|says|of|officials)\b|[.,;:!?)]|$)/g, entity);
  t = t.replace(/\b([Tt])he (county|city)\b/g, (m, T) => `${T}he ${entity}`);
  t = t.replace(/\bmany (county|city) (departments|offices|agencies)\b/g, `many ${entity} $2`);
  t = t.replace(/^(County|City) to\b/, `${entity} to`);
  return t;
}
function rewriteTextNodes(html, fn) {
  return html.replace(/>([^<]+)</g, (m, txt) => `>${fn(txt)}<`);
}
function setMeta(html, key, value) {
  const re = new RegExp(`(<div><div>(?:<p>)?${key}(?:</p>)?</div><div>(?:<p>)?)([\\s\\S]*?)((?:</p>)?</div></div>)`, 'i');
  return re.test(html) ? html.replace(re, (m, a, b, c) => a + htmlEsc(value) + c) : html;
}
function renameMonth(s, iso) {
  const month = MONTHS[Number(iso.slice(5, 7)) - 1];
  return s.replace(new RegExp(`\\b(${MONTHS.join('|')})\\b(\\s+\\d{1,2}\\b)?`, 'g'), (m, mo, day) => (day ? `${month} ${Number(iso.slice(8, 10))}` : month));
}
// -> item ready to render ({ origin:'fallback', html, slug, refs[] })
function fallbackItem(kind, bp, i, ctx, entity, slug) {
  const date = kind === 'news' ? addDays(ctx.today, -[1, 5, 9, 12, 3, 7][i % 6]) : nextWeekday(addDays(ctx.today, [2, 6, 10, 12, 4, 8][i % 6]));
  let html = cleanCtl(bp.html);
  const metaTitle = cleanCtl(bp.meta.title || '');
  let title = localize(metaTitle, entity);
  let pageSlug = bp.name;
  if (kind === 'events') { title = renameMonth(title, date); pageSlug = kebab(new RegExp(`\\b(${MONTHS.join('|')})\\b`).test(title) ? title : `${title} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`); }
  html = rewriteTextNodes(html, (t) => { const s = localize(t, entity); return kind === 'events' && t.includes(metaTitle.slice(0, 20)) ? renameMonth(s, date) : s; });
  if (kind === 'news') html = setMeta(html, 'publication-date', date);
  else {
    const old = bp.meta['start-date'];
    html = setMeta(html, 'start-date', date);
    if (bp.meta['end-date'] && /^\d{4}-\d{2}-\d{2}$/.test(old || '')) html = setMeta(html, 'end-date', addDays(date, dayDiff(bp.meta['end-date'], old)));
  }
  html = html.replace(/(<div><div>(?:<p>)?image(?:<\/p>)?<\/div><div>[\s\S]*?<\/div><\/div>)/i, ''); // never an Image row
  // copy the mold's own dot-folder media into this page's dot-folder
  const refs = [];
  html = html.replace(new RegExp(`${CDA.replace(/[.]/g, '\\.')}/blueprint/${kind}/\\.${bp.name}/([^"'\\s?]+)`, 'g'), (m, file) => {
    if (!refs.includes(file)) refs.push(file);
    return `${CDA}/sites/${slug}/${kind}/.${pageSlug}/${file}`;
  });
  html = html.replace(/\/blueprint(?![\w-])/g, `/sites/${slug}`);
  const meta = readMeta(html);
  const item = { origin: 'fallback', mold: `blueprint/${kind}/${bp.name}`, title, slug: pageSlug, html, refs };
  if (kind === 'news') Object.assign(item, { date, tag: meta['article:tag'], description: meta.description });
  else Object.assign(item, { startDate: date, startTime: meta['start-time'], endDate: meta['end-date'], endTime: meta['end-time'], location: meta.location, description: meta.description });
  return item;
}
function nextWeekday(iso) { let d = iso; while (['Saturday', 'Sunday'].includes(weekday(d))) d = addDays(d, 1); return d; }

// Snapshot of the blueprint molds (cleaned blueprint, 2026-10-23 evening: 3 news + 3 events, ISO dates), used only when the live
// blueprint cannot be read in time. Bodies are the <main> inner HTML, verbatim.
const BLUEPRINT_SNAPSHOT = {
 "news": [
  {
   "name": "rabid-raccoon-confirmed",
   "main": "<div><picture><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.rabid-raccoon-confirmed/raccoon.png\"><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.rabid-raccoon-confirmed/raccoon.png\" media=\"(min-width: 600px)\"><img src=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.rabid-raccoon-confirmed/raccoon.png\" alt=\"A raccoon in a wooded area\" loading=\"lazy\"></picture><h1>Rabid Raccoon Confirmed</h1><p>The Department of Health Services is reporting that a raccoon found in the county has tested positive for rabies, the latest confirmed terrestrial rabies case reported this year.</p><p>A member of the public reported a raccoon that appeared ill, and officers responded and transported the animal for testing. State health officials notified the county of the positive result. No human or pet exposure was reported.</p><p>Rabies is a fatal virus that attacks the central nervous system and is most commonly found among wild animals such as raccoons, bats, skunks, and foxes, though any mammal can become infected. Health officials remind residents not to touch or attempt to transport wild animals, especially any that appear sick or are behaving abnormally.</p><p>Anyone who spots a raccoon or other wild animal acting strangely is asked to contact the local police non-emergency line or the state environmental conservation office. Contact details are available on the county website.</p></div><div><div class=\"metadata\"><div><div><p>title</p></div><div><p>Rabid Raccoon Confirmed</p></div></div><div><div><p>description</p></div><div><p>A raccoon found in the county has tested positive for rabies, the latest confirmed terrestrial rabies case reported this year.</p></div></div><div><div><p>publication-date</p></div><div><p>2026-08-10</p></div></div><div><div><p>article:tag</p></div><div><p>Health</p></div></div><div><div><p>template</p></div><div><p>news-article</p></div></div></div></div>"
  },
  {
   "name": "two-beaches-closed-to-bathing",
   "main": "<div><picture><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.two-beaches-closed-to-bathing/beach.jpg\"><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.two-beaches-closed-to-bathing/beach.jpg\" media=\"(min-width: 600px)\"><img src=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.two-beaches-closed-to-bathing/beach.jpg\" alt=\"Waves breaking on a public beach shoreline\" loading=\"lazy\"></picture><h1>Two Beaches Closed to Bathing Due to Bacteria Levels</h1><p>The Department of Health Services has closed two public beaches to bathing after routine water testing found bacteria levels exceeding acceptable criteria. The affected beaches will remain closed to swimmers until conditions improve.</p><p>The Health Services Commissioner noted that swimming in bacteria-contaminated water can lead to gastrointestinal illness as well as infections of the eyes, ears, nose, and throat. The advisory is a precautionary measure to protect public health while conditions at the two beaches are monitored.</p><p>Both beaches will reopen once follow-up testing confirms bacteria levels have returned to acceptable ranges. The Office of Ecology conducts regular sampling throughout the summer season as part of its ongoing Bathing Beach Monitoring Program.</p><p>Residents can check current beach status by calling the Bathing Beach hotline or by contacting the Department of Health Services Office of Ecology during business hours. Contact details are available on the county website.</p></div><div><div class=\"metadata\"><div><div><p>title</p></div><div><p>Two Beaches Closed to Bathing Due to Bacteria Levels</p></div></div><div><div><p>description</p></div><div><p>Two public beaches are closed to bathing after testing found bacteria levels above acceptable limits. They will reopen once follow-up testing confirms safe conditions.</p></div></div><div><div><p>publication-date</p></div><div><p>2026-08-10</p></div></div><div><div><p>article:tag</p></div><div><p>Health</p></div></div><div><div><p>template</p></div><div><p>news-article</p></div></div></div></div>"
  },
  {
   "name": "vector-mosquito-spraying",
   "main": "<div><picture><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.vector-mosquito-spraying/mosquito.jpg\"><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.vector-mosquito-spraying/mosquito.jpg\" media=\"(min-width: 600px)\"><img src=\"https://content.da.live/adobe-pubsec/city-county/blueprint/news/.vector-mosquito-spraying/mosquito.jpg\" alt=\"Close-up of a mosquito\" loading=\"lazy\"></picture><h1>County to Spray for Mosquitoes as Summer Peak Approaches</h1><p>The Department of Public Works will carry out targeted mosquito spraying in several communities this week, part of the county's annual effort to keep populations of the biting insects in check during the height of summer. The treatments, which depend on favorable weather, are aimed at reducing the number of adult mosquitoes and the nuisance and health risks that come with them.</p><p>Mosquito control has become a routine but important part of the county's summer public-health work. Warm temperatures and standing water create ideal breeding conditions, and dense populations can carry viruses that affect both people and animals. By treating affected areas when mosquito activity is highest, the Division of Vector Control aims to interrupt that cycle before it becomes a broader problem.</p><p>Crews will use ground-based ultra-low-volume spraying, a method that disperses a fine aerosol of pesticide in the evening hours when mosquitoes are most active and beneficial insects such as bees are least likely to be affected. The materials used are approved for this purpose and are applied in small quantities designed to control adult mosquitoes without leaving significant residue on surfaces.</p><p>Officials stress that the health risk to residents from spraying is very low, but they encourage a few simple precautions. Whenever practical, residents—particularly children and pregnant women—should stay indoors during spraying and for about half an hour afterward. Closing windows and turning off window air-conditioning units during that window further reduces any exposure. Anyone who comes into direct contact with the spray should rinse their eyes with water and wash exposed skin and clothing.</p><p>Residents who garden can take additional steps: harvest ripe fruits and vegetables before spraying, rinse all produce thoroughly before eating, and bring pet dishes, small toys, and laundry indoors ahead of time. Ornamental fish ponds should be covered during the treatment period.</p><p>The county publishes spraying schedules and updates in advance, and residents can sign up to receive notices by phone, text, or email through the county's emergency-alert system. Details on the current schedule, affected neighborhoods, and how to enroll in alerts are available on the county website.</p></div><div><div class=\"metadata\"><div><div><p>title</p></div><div><p>County to Spray for Mosquitoes as Summer Peak Approaches</p></div></div><div><div><p>description</p></div><div><p>The Department of Public Works will conduct targeted evening mosquito spraying in several communities this week as part of the county's annual vector-control program. Residents are advised of simple precautions.</p></div></div><div><div><p>publication-date</p></div><div><p>2026-08-10</p></div></div><div><div><p>article:tag</p></div><div><p>Health</p></div></div><div><div><p>template</p></div><div><p>news-article</p></div></div></div></div>"
  }
 ],
 "events": [
  {
   "name": "city-council-regular-meeting",
   "main": "<div><picture><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/events/.city-council-regular-meeting/council1.png\"><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/events/.city-council-regular-meeting/council1.png\" media=\"(min-width: 600px)\"><img src=\"https://content.da.live/adobe-pubsec/city-county/blueprint/events/.city-council-regular-meeting/council1.png\" alt=\"City council chambers\" loading=\"lazy\"></picture><h1>City Council Regular Meeting — April 28</h1><p>The City Council holds its regular bi-monthly meeting, open to the public. Council meetings are a cornerstone of local democracy and an opportunity for residents to observe city governance in action and make their voices heard.</p><p>The meeting agenda — including all staff reports, resolutions, and ordinances under consideration — will be posted on the city website no later than 72 hours before the meeting. Residents are encouraged to review the agenda in advance.</p><p>Public comment is welcome on any agenda item as well as on general matters of city business not on the agenda. Speakers are asked to sign in prior to the start of the meeting and will be allotted three minutes each. Written comments may also be submitted to the City Clerk in advance.</p><picture><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/events/.city-council-regular-meeting/council2.png\"><source srcset=\"https://content.da.live/adobe-pubsec/city-county/blueprint/events/.city-council-regular-meeting/council2.png\" media=\"(min-width: 600px)\"><img src=\"https://content.da.live/adobe-pubsec/city-county/blueprint/events/.city-council-regular-meeting/council2.png\" alt=\"Residents attending a public meeting\" loading=\"lazy\"></picture><p>Meetings are livestreamed on the city's official channel and broadcast on local cable access television. Recordings are archived and available on the city website following the meeting.</p><p>City Hall is accessible via public transit. Parking is available in nearby public lots and garages. For more information, contact the City Clerk's Office.</p><div class=\"section-metadata\"><div><div><p>style</p></div><div><p>container</p></div></div><div><div><p>spacing</p></div><div><p>xxl</p></div></div></div></div><div><div class=\"metadata\"><div><div><p>title</p></div><div><p>City Council Regular Meeting — April 28</p></div></div><div><div><p>description</p></div><div><p>Regular bi-monthly city council meeting, open to the public. Public comment welcome; agenda posted 72 hours prior.</p></div></div><div><div><p>template</p></div><div><p>event-detail</p></div></div><div><div><p>start-date</p></div><div><p>2026-04-28</p></div></div><div><div><p>start-time</p></div><div><p>19:00</p></div></div><div><div><p>location</p></div><div><p>City Hall Chambers</p></div></div></div></div>"
  },
  {
   "name": "business-funding-webinar",
   "main": "<div><h1>Business Funding Opportunities Webinar</h1><p>Join a virtual session on business funding opportunities available to local entrepreneurs and small business owners. The session covers avenues for financing, grants, and other funding resources that can help local businesses grow.</p><p>This event is held online, making it easy for business owners across the community to participate from wherever they are. The session is geared toward business owners and managers looking to better understand the funding landscape and how to access available programs.</p><p>Advance registration is required to receive the meeting link and additional details.</p><div class=\"section-metadata\"><div><div>style</div><div>container</div></div><div><div>spacing</div><div>xxl</div></div></div></div><div><div class=\"metadata\"><div><div>title</div><div>Business Funding Opportunities Webinar</div></div><div><div>description</div><div>Virtual session on business funding opportunities for local business owners.</div></div><div><div>template</div><div>event-detail</div></div><div><div>start-date</div><div>2026-08-11</div></div><div><div>start-time</div><div>09:00</div></div><div><div>location</div><div>Virtual Meeting</div></div></div></div>"
  },
  {
   "name": "rfp-waiver-committee-special-meeting",
   "main": "<div><h1>Public Notice of Special Meeting of the RFP Waiver Committee</h1><p>The Office of the County Executive announces a special meeting of the RFP Waiver Committee. The committee reviews requests related to procurement RFP waivers.</p><p>The meeting is open to the public and will be held at the county legislative building.</p><p>Background documents, including the RFP Waiver Committee procedures, are available for download on the county's events page.</p><div class=\"section-metadata\"><div><div><p>style</p></div><div><p>container</p></div></div><div><div><p>spacing</p></div><div><p>xxl</p></div></div></div></div><div><div class=\"metadata\"><div><div><p>title</p></div><div><p>Public Notice of Special Meeting of the RFP Waiver Committee</p></div></div><div><div><p>description</p></div><div><p>Public notice of a special meeting of the county RFP Waiver Committee at the county legislative building.</p></div></div><div><div><p>template</p></div><div><p>event-detail</p></div></div><div><div><p>start-date</p></div><div><p>2026-08-19</p></div></div><div><div><p>start-time</p></div><div><p>11:00</p></div></div><div><div><p>location</p></div><div><p>County Legislative Building</p></div></div></div></div>"
  }
 ]
};

// ============================================================== render (exact molds)
const metaRow = (k, v) => `<div><div><p>${k}</p></div><div><p>${htmlEsc(v)}</p></div></div>`;
const wrapDoc = (main) => `\n<body>\n  <header></header>\n  <main>${main}</main>\n  <footer></footer>\n</body>\n`;
function picture(url, alt) {
  return `<picture><source srcset="${attrEsc(url)}"><source srcset="${attrEsc(url)}" media="(min-width: 600px)"><img src="${attrEsc(url)}" alt="${attrEsc(alt)}" loading="lazy"></picture>`;
}
function renderNews(n, imgUrl, entity) {
  const body = n.bodyParagraphs.map((p) => `<p>${htmlEsc(p)}</p>`).join('');
  const src = n.sourceUrl ? `<p>Source: <a href="${attrEsc(n.sourceUrl)}">${htmlEsc(entity)} news</a></p>` : '';
  const meta = [metaRow('title', n.title), metaRow('description', n.description), metaRow('publication-date', n.date), metaRow('article:tag', n.tag), metaRow('template', 'news-article')].join('');
  return wrapDoc(`<div>${picture(imgUrl, n.leadImageAlt || n.title)}<h1>${htmlEsc(n.title)}</h1>${body}${src}</div><div><div class="metadata">${meta}</div></div>`);
}
function renderEvent(e, entity) {
  const body = e.bodyParagraphs.map((p) => `<p>${htmlEsc(p)}</p>`).join('');
  const src = e.sourceUrl ? `<p>Source: <a href="${attrEsc(e.sourceUrl)}">${htmlEsc(entity)} events calendar</a></p>` : '';
  const sm = '<div class="section-metadata"><div><div><p>style</p></div><div><p>container</p></div></div><div><div><p>spacing</p></div><div><p>xxl</p></div></div></div>';
  const rows = [metaRow('title', e.title), metaRow('description', e.description), metaRow('template', 'event-detail'), metaRow('start-date', e.startDate)];
  if (e.startTime) rows.push(metaRow('start-time', e.startTime));
  if (e.endDate) rows.push(metaRow('end-date', e.endDate));
  if (e.endTime) rows.push(metaRow('end-time', e.endTime));
  if (e.location) rows.push(metaRow('location', e.location));
  return wrapDoc(`<div><h1>${htmlEsc(e.title)}</h1>${body}${src}${sm}</div><div><div class="metadata">${rows.join('')}</div></div>`);
}

// ============================================================== images
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { ext: 'png', type: 'image/png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}
async function downloadImage(url) {
  const r = await fx(url, { as: 'buf', timeout: 12000, maxBytes: MAX_IMAGE, headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*' } });
  if (!r.ok || !r.buf) return { err: r.err || `HTTP ${r.status}` };
  if (r.buf.length > MAX_IMAGE) return { err: 'larger than 8 MB' };
  if (r.buf.length < 15000) return { err: `too small (${r.buf.length} B)` };
  const t = sniff(r.buf);
  return t ? { buf: r.buf, ...t } : { err: `not jpeg/png/webp (${r.ct})` };
}
function localPhotos(dir) {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => pathMod.join(dir, f));
  } catch { return []; }
}

// ============================================================== main
async function newsEvents(opts) {
  const o = { news: 3, events: 3, budget: 150, tz: 'America/New_York', ...opts };
  const nNews = Number(o.news); const nEvents = Number(o.events); const budget = Number(o.budget);
  const token = o.token || process.env.DA_TOKEN || '';
  RT = makeRuntime(budget, token);
  const warnings = [];
  const cutoffS = +RT.cutS.toFixed(1);
  const report = { ok: false, mode: o.sourceOnly ? 'source-only' : o.publish ? 'write+publish' : 'write+preview', site: o.site, slug: o.slug, entity: o.entity, budgetS: budget, cutoffS, warnings };
  if (!o.site || !/^https?:\/\//.test(o.site)) throw Object.assign(new Error('--site <https://…> is required'), { code: 64 });
  if (!o.sourceOnly) {
    if (!o.slug || !/^[a-z0-9][a-z0-9-]*$/.test(o.slug)) throw Object.assign(new Error('--slug <a-z0-9-> is required'), { code: 64 });
    if (o.slug === 'blueprint') throw Object.assign(new Error('refusing to write the blueprint'), { code: 64 });
    if (!o.entity) throw Object.assign(new Error('--entity is required'), { code: 64 });
    if (!token) throw Object.assign(new Error('no token: set DA_TOKEN=$(oauth-token adobe | tr -d "[:space:]") or pass --token'), { code: 64 });
  }
  const entity = o.entity || 'City County';
  const slug = o.slug || 'preview';
  const hardTimer = setTimeout(() => RT.hard.abort(), Math.max(0, RT.deadline - Date.now() - 150));
  const work = (async () => {
    // ---- 1. source (parallel, cut off at 70%) + blueprint molds + existing tenant listing
    const ctxN = makeContext(o.site, o.tz, nNews);
    const ctxE = { ...ctxN, need: nEvents };
    const bpP = token ? loadBlueprint().catch((e) => { warnings.push(`blueprint read failed: ${e.message}`); return { news: [], events: [] }; }) : Promise.resolve(null);
    const existingP = token && !o.sourceOnly ? Promise.all([daList(`sites/${slug}/news`), daList(`sites/${slug}/events`)]) : Promise.resolve([null, null]);
    const [nr, er] = await Promise.all([race('news', NEWS_STRATEGIES, ctxN), race('events', EVENT_STRATEGIES, ctxE)]);
    const pickNews = () => {
      if (nr.winner) return nr.results[nr.winner].filter((x) => !isSensitive(x)).slice(0, nNews);
      const seen = new Set();
      return Object.values(nr.results).flat().filter((x) => !isSensitive(x)).sort((a, b) => (a.date < b.date ? 1 : -1)).filter((x) => { const k = normKey(x.title); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, nNews);
    };
    const realNews = pickNews();
    const realEvents = (er.winner ? er.results[er.winner] : upcoming(ctxE, Object.values(er.results).flat())).slice(0, nEvents);
    report.sourcing = {
      sourcedAtS: +elapsed().toFixed(1),
      news: { winner: nr.winner, real: realNews.length, attempts: nr.attempts },
      events: { winner: er.winner, real: realEvents.length, attempts: er.attempts },
    };
    // a lead image used by 2+ items is a site-wide share card, not the article's photo
    const imgCount = new Map(); realNews.forEach((n) => n.leadImageUrl && imgCount.set(n.leadImageUrl, (imgCount.get(n.leadImageUrl) || 0) + 1));
    realNews.forEach((n) => { if (n.leadImageUrl && imgCount.get(n.leadImageUrl) > 1) { n.leadImageUrl = undefined; n.leadImageAlt = undefined; } });

    // ---- 2. fallback fill
    let bp = await Promise.race([bpP, sleep(Math.max(0, leftMs() * 0.4)).then(() => null)]);
    const snap = snapshotMolds();
    if (!bp || bp.news.length < 1 || bp.events.length < 1) { warnings.push(token ? 'blueprint not readable in time; using the embedded blueprint snapshot as the fallback mold' : 'no token: fallback items use the embedded blueprint snapshot'); bp = bp || { news: [], events: [] }; }
    for (const k of ['news', 'events']) if (!bp[k].length) bp[k] = snap[k];
    report.fallbackMolds = { news: bp.news[0] && bp.news[0].snapshot ? 'snapshot' : 'live', events: bp.events[0] && bp.events[0].snapshot ? 'snapshot' : 'live' };
    const fill = (kind, real, n) => {
      const items = real.map((x) => ({ ...x, origin: 'real' }));
      const used = new Set(items.map((x) => normKey(x.title)));
      const molds = bp[kind];
      for (let i = 0; items.length < n && molds.length && i < molds.length * 2; i++) {
        const f = fallbackItem(kind, molds[i % molds.length], items.length, ctxN, entity, slug);
        if (used.has(normKey(f.title)) && i < molds.length) continue;
        used.add(normKey(f.title)); items.push(f);
      }
      if (items.length < n) warnings.push(`${kind}: only ${items.length}/${n} items (${molds.length} blueprint molds available)`);
      return items;
    };
    const news = fill('news', realNews, nNews);
    const events = fill('events', realEvents, nEvents);
    // paths: short kebab slugs, unique per folder
    const assign = (list, kind) => {
      const taken = new Set();
      for (const it of list) {
        let s = it.slug || (kind === 'events' && !new RegExp(`\\b(${MONTHS.join('|')})\\b`, 'i').test(it.title)
          ? kebab(`${it.title}`, 6, 48) + `-${MONTHS[Number(it.startDate.slice(5, 7)) - 1].toLowerCase()}-${Number(it.startDate.slice(8, 10))}`
          : kebab(it.title));
        let k = 2; const base = s; while (taken.has(s)) s = `${base}-${k++}`;
        if (it.html && it.slug && s !== it.slug) it.html = it.html.split(`/${kind}/.${it.slug}/`).join(`/${kind}/.${s}/`);
        taken.add(s); it.slug = s; it.path = `sites/${slug}/${kind}/${s}`;
      }
    };
    assign(news, 'news'); assign(events, 'events');
    report.news = news; report.events = events;
    if (o.sourceOnly) { report.ok = realNews.length + realEvents.length > 0 || (news.length >= nNews && events.length >= nEvents); return; }

    // ---- 3. images + render + PUT (parallel per item)
    const [exN, exE] = await existingP;
    const photos = localPhotos(o.images);
    let photoIdx = 0;
    const nextPhoto = () => (photos.length ? photos[photoIdx++ % photos.length] : null);
    let heroP = null; // tenant hero as the last-resort lead image
    const hero = () => (heroP = heroP || daGet(`sites/${slug}/.index/hero.jpg`, 'buf').then((r) => (r.ok && sniff(r.buf) ? { buf: r.buf, ...sniff(r.buf), name: 'hero' } : null)));
    const putNews = async (it) => {
      it.status = {};
      if (it.origin === 'fallback') {
        // the mold's own lead image (copied like Step 3 does); else a picked photo / the tenant hero
        const file = it.refs[0];
        let img = null; let imgSource = '';
        if (file) {
          const g = await fx(`${CDA}/blueprint/news/.${it.mold.split('/').pop()}/${file}`, { headers: auth(), as: 'buf', timeout: 15000 });
          if (g.ok && sniff(g.buf)) { img = { buf: g.buf, ...sniff(g.buf), file }; imgSource = 'blueprint mold'; } else warnings.push(`${it.slug}: blueprint image copy failed (${g.status || g.err})`);
        }
        if (!img) { const p = nextPhoto(); if (p) { try { const buf = fs.readFileSync(p); const t = sniff(buf); if (t) { img = { buf, ...t, file: `${slugify(pathMod.basename(p).replace(/\.[^.]+$/, ''))}.${t.ext}` }; imgSource = `--images ${pathMod.basename(p)}`; } } catch { /* unreadable */ } } }
        if (!img) { const h = await hero(); if (h) { img = { ...h, file: `hero.${h.ext}` }; imgSource = 'tenant hero'; } }
        if (!img) { it.status.image = 'MISSING'; warnings.push(`${it.slug}: no lead image available`); return; }
        const url = `${CDA}/sites/${slug}/news/.${it.slug}/${img.file}`;
        if (file && img.file !== file) it.html = it.html.split(`${CDA}/sites/${slug}/news/.${it.slug}/${file}`).join(url);
        it.image = url; it.imageSource = imgSource;
        const [s1, s2] = await Promise.all([daPut(`sites/${slug}/news/.${it.slug}/${img.file}`, img.buf, img.type), daPut(`${it.path}.html`, Buffer.from(it.html, 'utf8'), 'text/html')]);
        it.status.image = s1; it.status.put = s2;
        delete it.html;
        return;
      }
      let img = null; let imgSource = '';
      for (const u of [it.leadImageUrl, it.leadImageAltUrl].filter(Boolean)) {
        const d = await downloadImage(u);
        if (d.buf) { img = d; imgSource = 'source'; break; }
        warnings.push(`${it.slug}: lead image ${u} skipped (${d.err})`);
      }
      if (!img) {
        const p = nextPhoto();
        if (p) { try { const buf = fs.readFileSync(p); const t = sniff(buf); if (t && buf.length <= MAX_IMAGE) { img = { buf, ...t, name: slugify(pathMod.basename(p).replace(/\.[^.]+$/, '')) }; imgSource = `--images ${pathMod.basename(p)}`; it.leadImageAlt = undefined; } } catch (e) { warnings.push(`${p}: ${e.message}`); } }
      }
      if (!img) { const h = await hero(); if (h) { img = h; imgSource = 'tenant hero'; it.leadImageAlt = undefined; } }
      if (!img && bp.news[0]) {
        const f = bp.news[0].html.match(new RegExp(`${CDA.replace(/[.]/g, '\\.')}/blueprint/news/\\.[^"/]+/[^"?]+`));
        if (f) { const g = await fx(f[0], { headers: auth(), as: 'buf', timeout: 15000 }); if (g.ok && sniff(g.buf)) { img = { buf: g.buf, ...sniff(g.buf), name: 'image' }; imgSource = 'blueprint example'; it.leadImageAlt = undefined; } }
      }
      if (!img) { it.status.image = 'MISSING'; warnings.push(`${it.slug}: no lead image available`); return; }
      const fname = `${(img.name || kebab(it.title, 4, 30))}.${img.ext}`;
      const ip = `sites/${slug}/news/.${it.slug}/${fname}`;
      it.image = `${CDA}/${ip}`; it.imageSource = imgSource;
      const [s1, s2] = await Promise.all([daPut(ip, img.buf, img.type), daPut(`${it.path}.html`, Buffer.from(renderNews(it, it.image, entity), 'utf8'), 'text/html')]);
      it.status.image = s1; it.status.put = s2;
    };
    const putEvent = async (it) => {
      it.status = {};
      if (it.origin === 'fallback') {
        const copies = await Promise.all(it.refs.map(async (file) => {
          const g = await fx(`${CDA}/blueprint/events/.${it.mold.split('/').pop()}/${file}`, { headers: auth(), as: 'buf', timeout: 15000 });
          return g.ok ? daPut(`sites/${slug}/events/.${it.slug}/${file}`, g.buf, (sniff(g.buf) || { type: 'application/octet-stream' }).type) : `GET ${g.status || g.err}`;
        }));
        if (copies.length) it.status.image = copies.join(',');
        it.status.put = await daPut(`${it.path}.html`, Buffer.from(it.html, 'utf8'), 'text/html');
        delete it.html;
        return;
      }
      it.status.put = await daPut(`${it.path}.html`, Buffer.from(renderEvent(it, entity), 'utf8'), 'text/html');
    };
    const all = [...news.map((x) => ['news', x]), ...events.map((x) => ['events', x])];
    await Promise.all(all.map(([k, it]) => (k === 'news' ? putNews(it) : putEvent(it))));
    report.writtenAtS = +elapsed().toFixed(1);
    const okPut = (it) => [200, 201].includes(it.status.put) && (!it.status.image || String(it.status.image).split(',').every((s) => ['200', '201'].includes(String(s))));
    // ---- 4. preview (+ publish), all paths in parallel
    await Promise.all(all.map(async ([, it]) => {
      if (!okPut(it)) return;
      it.status.preview = await hlx('preview', it.path);
      if (o.publish && it.status.preview === 200) it.status.live = await hlx('live', it.path);
    }));
    report.previewedAtS = +elapsed().toFixed(1);
    // ---- 5. verify: rendered preview page 200 and, with --publish, index rows
    await Promise.all(all.map(async ([, it]) => {
      if (it.status.preview !== 200 || leftMs() < 2500) return;
      const get = () => fx(`${PAGE_HOST}/${it.path}`, { timeout: 8000, as: 'text', headers: { 'Cache-Control': 'no-cache' } });
      let r = await get();
      if (r.status === 404 && leftMs() > 8000) {
        // a 404 cached at the edge by an earlier request; a second preview POST purges it
        const again = await hlx('preview', it.path);
        await sleep(1500);
        r = await get();
        it.status.repreview = again;
      }
      it.status.page = r.status || r.err;
      if (r.ok && r.text) {
        const og = (r.text.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '';
        it.ogImage = og.replace(/^https?:\/\/[^/]+/, '');
        if (all.find(([k, x]) => x === it)[0] === 'news' && /default-meta-image/.test(og)) warnings.push(`${it.path}: og:image is the site default (lead image not picked up)`);
      }
    }));
    const stray = [];
    const mine = new Set(all.map(([, it]) => it.path));
    for (const [kind, ex] of [['news', exN], ['events', exE]]) for (const f of ex || []) if (f.ext === 'html' && !mine.has(`sites/${slug}/${kind}/${f.name}`)) stray.push(`/sites/${slug}/${kind}/${f.name}`);
    if (stray.length) { report.otherPagesInFolders = stray; warnings.push(`${stray.length} other page(s) already in the tenant's news/events folders (left untouched): ${stray.join(' ')}`); }
    if (o.publish) {
      report.index = { news: { expected: news.length, found: 0 }, events: { expected: events.length, found: 0 } };
      const want = { news: news.filter((x) => x.status.live === 200).map((x) => `/${x.path}`), events: events.filter((x) => x.status.live === 200).map((x) => `/${x.path}`) };
      let polls = 0;
      while (leftMs() > 3500) {
        polls++;
        const res = await Promise.all(['news', 'events'].map((k) => fx(`${LIVE_HOST}/${k}-index.json?limit=5000&cb=${Date.now()}`, { as: 'json', timeout: 6000 })));
        ['news', 'events'].forEach((k, i) => {
          const rows = (res[i].json && res[i].json.data) || [];
          const have = new Set(rows.map((r) => r.path));
          report.index[k].found = want[k].filter((p) => have.has(p)).length;
          report.index[k].rowsUnderTenant = rows.filter((r) => r.path.startsWith(`/sites/${slug}/${k}/`)).length;
          for (const it of (k === 'news' ? news : events)) if (have.has(`/${it.path}`)) it.status.index = 'yes';
        });
        if (report.index.news.found >= want.news.length && report.index.events.found >= want.events.length) break;
        await sleep(Math.min(3000, leftMs() - 3500));
      }
      report.index.polls = polls;
    }
    const good = (it) => okPut(it) && it.status.preview === 200 && (!o.publish || it.status.live === 200) && it.status.image !== 'MISSING';
    report.ok = news.length >= nNews && events.length >= nEvents && all.every(([, it]) => good(it));
  })();
  try {
    await Promise.race([work, sleep(leftMs() - 100).then(() => { warnings.push('global deadline reached; report reflects the state at the deadline'); })]);
  } catch (e) {
    warnings.push(`error: ${e.message || e}`);
  } finally {
    clearTimeout(hardTimer);
    RT.hard.abort();
    releaseSleeps();
  }
  report.elapsedS = +elapsed().toFixed(1);
  return report;
}

// ============================================================== CLI
function parseArgs(argv) {
  const o = {};
  const flags = { '--publish': 'publish', '--json': 'json', '--source-only': 'sourceOnly', '--help': 'help', '-h': 'help' };
  const vals = { '--site': 'site', '--slug': 'slug', '--entity': 'entity', '--news': 'news', '--events': 'events', '--budget': 'budget', '--images': 'images', '--token': 'token', '--tz': 'tz' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) o[flags[a]] = true;
    else if (vals[a]) o[vals[a]] = argv[++i];
    else if (a.includes('=') && vals[a.split('=')[0]]) o[vals[a.split('=')[0]]] = a.slice(a.indexOf('=') + 1);
    else throw Object.assign(new Error(`unknown argument: ${a}`), { code: 64 });
  }
  return o;
}
const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
function printReport(r) {
  const L = (s = '') => console.log(s);
  L(`news-events  ${r.mode}  site=${r.site}  slug=${r.slug || '-'}  entity="${r.entity || '-'}"`);
  if (r.sourcing) {
    for (const k of ['news', 'events']) {
      const s = r.sourcing[k];
      L(`${k.padEnd(6)} winner=${s.winner || 'none'}  real=${s.real}  ` + s.attempts.map((a) => `${a.strategy}:${a.status}${a.count ? `(${a.count})` : ''}@${(a.ms / 1000).toFixed(1)}s`).join('  '));
    }
    L(`sourcing done at ${r.sourcing.sourcedAtS}s (cutoff ${r.cutoffS}s)`);
  }
  const rows = [...(r.news || []).map((x) => ['news', x]), ...(r.events || []).map((x) => ['event', x])];
  if (rows.length) {
    L('');
    L(`${'type'.padEnd(6)}${'origin'.padEnd(9)}${'date'.padEnd(18)}${'title'.padEnd(52)}path`);
    for (const [k, x] of rows) {
      const date = k === 'news' ? x.date : `${x.startDate}${x.startTime ? ` ${x.startTime}` : ''}`;
      L(`${k.padEnd(6)}${x.origin.padEnd(9)}${String(date).padEnd(18)}${trunc(x.title, 50).padEnd(52)}/${x.path}`);
      if (x.status) L(`${''.padEnd(15)}${Object.entries(x.status).map(([a, b]) => `${a}=${b}`).join(' ')}${x.imageSource ? `  image from ${x.imageSource}` : ''}`);
    }
  }
  if (r.index) L(`\nindex: news ${r.index.news.found}/${r.index.news.expected}, events ${r.index.events.found}/${r.index.events.expected} (polls ${r.index.polls})`);
  for (const w of r.warnings) L(`warning: ${w}`);
  L(`\n${r.ok ? 'OK' : 'NOT OK'}  elapsed ${r.elapsedS}s of ${r.budgetS}s budget`);
}

module.exports = { newsEvents };

if (isMain(module)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 64; }
  if (o && (o.help || !o.site)) {
    console.error('usage: node news-events.cjs --site <url> --slug <slug> --entity "<Name>" [--news 3] [--events 3] [--budget 150] [--images <dir>] [--tz America/New_York] [--publish] [--source-only] [--json] [--token <ims>]');
    process.exitCode = o.help ? 0 : 64;
  } else if (o) {
    newsEvents(o).then((r) => {
      if (o.json) console.log(JSON.stringify(r, null, 2)); else printReport(r);
      process.exitCode = r.ok ? 0 : 1;
      // in-flight requests abandoned at the deadline must not hold the process open
      setTimeout(() => process.exit(r.ok ? 0 : 1), 50);
    }).catch((e) => { console.error('error:', e.message || e); process.exitCode = e.code || 1; });
  }
}
