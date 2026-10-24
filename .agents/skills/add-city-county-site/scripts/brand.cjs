#!/usr/bin/env node
// brand.cjs — fast palette + logo extraction from a city/county homepage (SKILL step 6a/6b).
// One homepage fetch + up to 8 linked stylesheets in parallel (static, no browser).
// Usage: node brand.cjs <site-url> [--out <dir>] [--json]
//        node brand.cjs <site-url> --apply --slug <slug> [--dry-run] [--out <dir>] [--json]
// Module: require('./brand.cjs').brand(url, { out }); applyLogo(result, { slug, token, dryRun })
// Exit: 0 = palette + logo (and, with --apply, header written + verified), 2 = partial (no logo
//       or no brand colors), 1 = error (incl. a failed --apply).
// Read-only against the web; writes only into --out (default /tmp/brand/<host>).
// --apply (needs DA_TOKEN): uploads logo.use to sites/<slug>/fragments/nav/.header/logo.<ext>,
//   points the header <picture> at it, sets logo-is, forces brand home links to /sites/<slug>/,
//   PUTs the header and re-GETs to verify. No preview. --dry-run: GET + plan only, no writes.
const fs = require('fs');
const zlib = require('zlib');
const { fetchT, UA_BROWSER, isMain } = require('./lib.cjs');

const BUDGET_MS = 20000; const PER_FETCH = 8000; const MAX_SHEETS = 8; const MAX_CSS_BYTES = 2e6; const MAX_LOGO_BYTES = 3e6;

// ---------- color math ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
const toHex = ({ r, g, b }) => '#' + hex2(r) + hex2(g) + hex2(b);
function parseColor(s) {
  s = s.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a };
  }
  m = s.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const ch = (v) => (v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v));
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a };
  }
  m = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const c = hsl2rgb(parseFloat(m[1]) / 360, parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
    c.a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return c;
  }
  return null;
}
function rgb2hsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return { h, s, l };
}
function hsl2rgb(h, s, l) {
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return { r: f(0), g: f(8), b: f(4) };
}
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const contrastWhite = (c) => 1.05 / (lum(c) + 0.05);
function lab(c) {
  const [R, G, B] = [lin(c.r), lin(c.g), lin(c.b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047); const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722); const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => { const p = lab(a); const q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const hueDist = (a, b) => { const d = Math.abs(rgb2hsl(a).h - rgb2hsl(b).h) * 360; return Math.min(d, 360 - d); };
// Brand-usable: not near-black/white, not gray/low-saturation.
function isBrandish(c) {
  if (!c || c.a < 0.6) return false;
  const { s, l } = rgb2hsl(c); const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
  return l > 0.06 && l < 0.94 && s >= 0.22 && chroma >= 0.12;
}
const isNearWhite = (c) => { const { l, s } = rgb2hsl(c); return l >= 0.9 && (s < 0.35 || l > 0.96); };
// Light enough to vanish on a light (#fff..#f0f0f0) header: near-white, or a light neutral gray (#c9c9c9).
const isLightInk = (c) => { const { l, s } = rgb2hsl(c); return isNearWhite(c) || (l >= 0.74 && s < 0.15); };
function darkenFor(c, target = 4.5) {
  const hsl = rgb2hsl(c); let out = c;
  for (let l = hsl.l; l > 0 && contrastWhite(out) < target; l -= 0.01) out = hsl2rgb(hsl.h, hsl.s, l);
  return out;
}
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

// ---------- fetch helpers ----------
function makeFetch(deadline) {
  return async (url, { asBuffer = false, max = MAX_CSS_BYTES } = {}) => {
    const left = deadline - Date.now(); if (left < 300) throw new Error('budget exhausted');
    const r = await fetchT(url, { headers: { 'User-Agent': UA_BROWSER, Accept: '*/*' } }, Math.min(PER_FETCH, left));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > max) throw new Error('too large ' + buf.length);
    return { url: r.url || url, type: r.headers.get('content-type') || '', body: asBuffer ? buf : buf.toString('utf8') };
  };
}
const dec = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#x2F;/gi, '/').trim();
const abs = (u, base) => { try { return new URL(dec(u), base).href; } catch { return null; } };
const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i')); return m ? dec(m[1] ?? m[2] ?? m[3]) : null; };

// ---------- CSS ----------
// Flat rule list: [{sel, body, sheet}] — good enough for minified + @media-nested CSS.
function cssRules(css, sheet) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/^[\s\S]*@[a-z-]+[^{]*$/i, (x) => x).trim();
    if (!sel || sel.startsWith('@font-face') || /^(from|to|\d+%)/.test(sel)) continue;
    out.push({ sel: sel.replace(/\s+/g, ' '), body: m[2], sheet });
  }
  return out;
}
const decls = (body) => body.split(';').map((d) => { const i = d.indexOf(':'); return i < 0 ? null : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()]; }).filter((d) => d && d[0] && d[1]);

function rankSheets(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0]; const rel = (attr(t, 'rel') || '').toLowerCase();
    const isSheet = rel.split(/\s+/).includes('stylesheet') || (rel.includes('preload') && (attr(t, 'as') || '') === 'style');
    if (!isSheet) continue;
    const media = (attr(t, 'media') || '').toLowerCase(); if (media === 'print') continue;
    const href = attr(t, 'href'); const u = href && abs(href, base); if (!u) continue;
    let s = 0; const h = new URL(u); const same = h.hostname.replace(/^www\./, '') === new URL(base).hostname.replace(/^www\./, '');
    if (same) s += 3;
    if (/fonts\.googleapis|typekit|use\.fontawesome|font-?awesome|cdnjs|jsdelivr|unpkg|bootstrapcdn|jquery|slick|swiper|owl\.carousel|animate\.css|aos\.css|lightbox|fancybox|recaptcha|translate|cookie|onetrust|addtoany|dashicons|wp-includes|\/core\/(modules|assets|themes)|\/modules\/contrib|admin|print/i.test(u)) s -= 6;
    if (/theme|custom|style|main|global|site|client|brand|app|layout|base|_next\/static\/css|header|common/i.test(u)) s += 2;
    out.push({ url: u, score: s, i: out.length });
  }
  const seen = new Set();
  return out.filter((x) => !seen.has(x.url) && seen.add(x.url)).sort((a, b) => b.score - a.score || a.i - b.i);
}

// ---------- palette ----------
const SEL_HEADER = /(^|[\s,>.#\-_])(header|masthead|navbar|nav|site-nav|main-nav|menu|top-?bar|banner|branding|utility)\b/i;
const SEL_FOOTER = /footer/i;
const SEL_BUTTON = /(\bbtn\b|button|\.cta|\bcta\b|call-to-action)/i;
const SEL_LINK = /(^|[\s,>])a(:link|:visited|:hover|:focus)?\s*$/i;
const SEL_HEAD = /(^|[\s,>])h[1-3]\b/i;
const SEL_JUNK = /[-_.](warning|error|danger|success|alert|emergency|invalid|closure|urgent)\b|\.has-[a-z0-9-]+-(background-)?color|\.wp-block|editor-styles|\.text-bg-|\.bg-(primary|secondary|success|danger|warning|info|light|dark)|\.btn-(outline-)?(success|danger|warning|info|light|dark)|\.alert-|\.badge|\.table-|\.form-|\.is-invalid|\.is-valid|valid-feedback|\.error|\.warning|\.success|::selection|focus-visible|\.skip|\.sr-only|cookie|onetrust|gdpr|translate|\.goog-|\.ui-|\.fc-|\.leaflet|\.mapboxgl|\.slick|\.swiper/i;
const STOCK_NAMES = 'blue|indigo|purple|pink|red|orange|yellow|green|teal|cyan|white|gray|grey|black|success|danger|warning|info|light|dark';
// Framework-generated custom properties: stock Bootstrap names (--bs-blue, --bs-danger, --bs-btn-bg ...), WP presets, Tailwind.
// Custom names inside a themed Bootstrap build (--bs-primary, --bs-main-blue, --bs-sunset) are NOT matched and count as brand.
const VAR_FRAMEWORK = new RegExp(`^--(wp--preset|wp-admin|wp--style|tw-|swiper|plyr|fa-|ck-|toastify|mdc-)|^--(${STOCK_NAMES})$|^--bs-((${STOCK_NAMES})(-\\d+)?|body|border|form|btn|link|emphasis|focus|highlight|code|heading|nav|navbar|dropdown|table|alert|card|list|tooltip|popover|modal|toast|accordion|pagination|progress|offcanvas|error|secondary-bg|tertiary)([-_].*)?$|^--bs-.*-(rgb|subtle|emphasis|bg-subtle|border-subtle)$`, 'i');
// Stock framework defaults (Bootstrap 3/4/5, WordPress admin, Tailwind blue-500...) — never brand evidence on their own.
const STOCK_HEX = new Set(['#007bff', '#0069d9', '#0062cc', '#0056b3', '#0d6efd', '#0b5ed7', '#0a58ca', '#337ab7', '#286090', '#23527c', '#2e6da4', '#6c757d', '#198754', '#28a745', '#218838', '#dc3545', '#c82333', '#ffc107', '#0dcaf0', '#17a2b8', '#6610f2', '#6f42c1', '#d63384', '#e83e8c', '#fd7e14', '#20c997', '#5cb85c', '#5bc0de', '#f0ad4e', '#d9534f', '#007cba', '#006ba1', '#005a87', '#3b82f6', '#2563eb', '#1da1f2', '#3b5998', '#1877f2', '#c13584', '#e1306c', '#ff0000', '#bd081c', '#bd081d', '#0077b5', '#0a66c2', '#25d366', '#86b7fe', '#9ec5fe']);

function paletteFrom(html, rules) {
  const C = new Map(); // hex -> {c, score, freq, ev:{}}
  const bump = (col, w0, why0, freq0 = 0) => {
    let w = w0; let why = why0; let freq = freq0;
    if (!isBrandish(col)) return;
    const hex = toHex(col); let e = C.get(hex);
    if (!e) { e = { hex, c: { r: col.r, g: col.g, b: col.b }, score: 0, freq: 0, ev: {} }; C.set(hex, e); }
    if (STOCK_HEX.has(hex)) { w *= 0.1; freq *= 0.1; why = why && why + ' (framework default)'; }
    e.score += w; e.freq += freq; if (why) e.ev[why] = (e.ev[why] || 0) + 1;
  };
  const warnings = [];
  // 1. theme-color
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/name\s*=\s*["']?(theme-color|msapplication-TileColor)["'\s>]/i.test(m[0])) continue;
    const c = parseColor(attr(m[0], 'content') || ''); if (c) bump(c, 25, 'meta theme-color');
  }
  // 2. custom properties (definitions), then var() usage resolves through them
  const vars = new Map();
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const all = rules.concat(cssRules(inline, 'inline <style>'));
  for (const r of all) for (const [p, v] of decls(r.body)) {
    if (!p.startsWith('--')) continue;
    const c = parseColor(v.replace(/\s*!important/, ''));
    if (!c) continue;
    if (!vars.has(p) || /:root|html|body/.test(r.sel)) vars.set(p, c);
    if (VAR_FRAMEWORK.test(p)) { bump(c, 0.2, 'framework var'); continue; }
    const w = /primary|brand/i.test(p) ? 12 : /^--bs-/i.test(p) ? 3 : /secondary|accent|main|theme|highlight/i.test(p) ? 5 : /^--(color|clr|c)-/i.test(p) ? 2 : 0.8;
    bump(c, w, `var ${p}`);
  }
  // 3. declarations: selector-weighted + frequency
  for (const r of all) {
    if (SEL_JUNK.test(r.sel)) continue;
    for (const [p, v0] of decls(r.body)) {
      if (p.startsWith('--')) continue;
      if (!/(^|-)(color|background|border|fill|stroke|outline|shadow|decoration)/.test(p)) continue;
      let cols = (v0.match(COLOR_RE) || []).map(parseColor).filter(Boolean);
      if (!cols.length) for (const vm of v0.matchAll(/var\(\s*(--[\w-]+)/g)) if (vars.has(vm[1])) cols.push(vars.get(vm[1]));
      if (!cols.length) continue;
      const bg = /^background/.test(p); const fg = p === 'color' || p === 'fill';
      let w = 0; let why = null;
      if (SEL_HEADER.test(r.sel) && !SEL_FOOTER.test(r.sel)) { w = bg ? 8 : fg ? 2.5 : 1.5; why = bg ? 'header/nav background' : 'header/nav ' + p; }
      else if (SEL_FOOTER.test(r.sel)) { w = bg ? 6 : 1.5; why = bg ? 'footer background' : 'footer ' + p; }
      else if (SEL_BUTTON.test(r.sel)) { w = bg ? 4 : 1.5; why = 'button ' + (bg ? 'background' : p); }
      else if (SEL_LINK.test(r.sel) && fg) { w = 3; why = 'link color'; }
      else if (SEL_HEAD.test(r.sel) && fg) { w = 2; why = 'heading color'; }
      for (const c of cols) bump(c, w, why, 1);
    }
  }
  // inline style="" in the HTML
  for (const m of html.matchAll(/style\s*=\s*"([^"]*)"/gi)) for (const v of m[1].match(COLOR_RE) || []) bump(parseColor(v) || {}, 0, null, 1.5);
  // frequency (sqrt-damped so one big framework can't dominate)
  for (const e of C.values()) { e.score += 3 * Math.sqrt(e.freq); if (e.freq) e.ev.occurrences = Math.round(e.freq); }

  // merge near-identical colors into the strongest member
  const list = [...C.values()].sort((a, b) => b.score - a.score);
  const clusters = [];
  for (const e of list) {
    const k = clusters.find((x) => dE(x.c, e.c) < 9);
    if (k) { k.score += e.score; k.merged.push(e.hex); for (const [w, n] of Object.entries(e.ev)) k.ev[w] = (k.ev[w] || 0) + n; } else clusters.push({ ...e, ev: { ...e.ev }, merged: [] });
  }
  clusters.sort((a, b) => b.score - a.score);
  const cands = clusters.slice(0, 12).map((k) => ({
    hex: k.hex, score: Math.round(k.score * 10) / 10, contrastWhite: Math.round(contrastWhite(k.c) * 100) / 100,
    evidence: Object.entries(k.ev).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, n]) => (n > 1 ? `${w} x${n}` : w)), merged: k.merged.slice(0, 6), c: k.c,
  }));
  if (!cands.length) return { primary: null, secondary: null, accent: null, candidates: [], warnings: ['no saturated brand colors found in HTML/CSS (site may set colors via JS or images) — pick by eye'] };

  // roles
  const top = cands[0]; let primary; let primaryNote = null;
  if (top.contrastWhite >= 4.5) primary = top.c;
  else {
    const alt = cands.slice(1, 4).find((x) => x.contrastWhite >= 4.5 && x.score >= top.score * 0.6 && hueDist(x.c, top.c) < 35);
    if (alt) { primary = alt.c; primaryNote = `top color ${top.hex} only ${top.contrastWhite}:1 on white; used next same-hue candidate ${alt.hex}`; }
    else { primary = darkenFor(top.c); primaryNote = `top color ${top.hex} only ${top.contrastWhite}:1 on white; darkened to ${toHex(primary)} (${contrastWhite(primary).toFixed(2)}:1)`; }
  }
  const rest = cands.filter((x) => dE(x.c, primary) >= 12 && x.score >= Math.min(3, top.score * 0.05));
  // Secondary: strongest remaining color that is clearly different from primary and still carries white text.
  const secondary = rest.find((x) => x.contrastWhite >= 3 && dE(x.c, primary) >= 20) || rest.find((x) => x.contrastWhite >= 3) || rest[0];
  const rest2 = rest.filter((x) => x !== secondary && (!secondary || dE(x.c, secondary.c) >= 12));
  // Accent: a bright, saturated pop, ideally a contrasting hue (score is damped so frequency matters less here).
  // score^0.8 x saturation x brightness x hue contrast (vs primary, then secondary). Same-hue lighter pops (Monmouth red) still qualify.
  const accScore = (x) => {
    const h = rgb2hsl(x.c); const lightF = h.l < 0.18 ? 0.2 : h.l < 0.28 ? 0.5 : h.l <= 0.85 ? 1 : 0.4;
    const dP = Math.min(hueDist(x.c, primary), 90) / 90; const dS = secondary ? Math.min(hueDist(x.c, secondary.c), 90) / 90 : 1;
    const same = hueDist(x.c, primary) < 20 && h.l - rgb2hsl(primary).l < 0.06 ? 0.35 : 1; // same hue, not lighter: not a pop
    return same * x.score ** 0.8 * h.s * lightF * (0.7 + 0.4 * dP + 0.3 * dS);
  };
  // A pop = clearly different hue, or the same hue clearly lighter; mid lightness; saturated.
  const isPop = (x) => { const h = rgb2hsl(x.c); return h.s >= 0.4 && h.l >= 0.3 && h.l <= 0.88 && (hueDist(x.c, primary) >= 25 || h.l - rgb2hsl(primary).l >= 0.08); };
  const accFloor = Math.max(2, top.score * 0.04);
  let accent = rest2.filter((x) => x.score >= accFloor && isPop(x)).sort((a, b) => accScore(b) - accScore(a))[0];
  let accentNote = null;
  if (!accent) {
    const h = rgb2hsl(primary); const a = hsl2rgb(h.h, clamp(h.s + 0.15), clamp(h.l + 0.28, 0.35, 0.75));
    accent = { hex: toHex(a), c: a }; accentNote = `fewer than 3 distinct brand colors; accent derived from primary (lighter/more saturated)`;
  }
  let secondaryOut = secondary ? secondary.hex : null;
  if (!secondary) { const h = rgb2hsl(primary); const s = hsl2rgb(h.h, clamp(h.s * 0.8), clamp(h.l + 0.15, 0, 0.45)); secondaryOut = toHex(s); warnings.push('secondary derived from primary (only one brand color found)'); }
  if (primaryNote) warnings.push(primaryNote);
  if (accentNote) warnings.push(accentNote);
  return { primary: toHex(primary), secondary: secondaryOut, accent: accent.hex, candidates: cands.map(({ c, ...x }) => x), warnings };
}

// ---------- logo ----------
const LOGOISH = /logo|brand|site-?title|site-?name|masthead|wordmark|branding|home[-_]?link|header-site|seal/i;
const NOT_LOGO = /facebook|twitter|instagram|youtube|linkedin|tiktok|pinterest|nextdoor|social|\bx-\d|\/x\.(svg|png)|share|icon-|-icon\b|icons?\/|flag|lang|language|translate|311|search|menu|hamburger|close|arrow|chevron|caret|spinner|loading|placeholder|badge|award|partner|sponsor|app-?store|google-?play|ada|wcag|accessib|weather/i;
const HOME_HREF = /^(\/|\.\/|\/home\/?|\/index\.(php|html?|aspx?)|index\.(php|html?|aspx?)|https?:\/\/[^/]+\/?(home|index\.\w+)?\/?)$/i;

function regions(html) {
  // [start,end) index ranges for header-ish and footer-ish markup (approximate, regex-based).
  const R = { header: [], footer: [] };
  const span = (re, closeRe, key, cap) => { for (const m of html.matchAll(re)) { const s = m.index; closeRe.lastIndex = s; const c = closeRe.exec(html); R[key].push([s, c ? c.index : Math.min(html.length, s + cap)]); } };
  span(/<header\b/gi, /<\/header>/gi, 'header', 20000);
  span(/<(div|section|nav)\b[^>]*(id|class)\s*=\s*["'][^"']*(site-?header|masthead|navbar|header-?wrap|top-?header|\bheader\b|branding|banner)[^"']*["']/gi, /<\/(div|section|nav)>/gi, 'header', 6000);
  span(/<nav\b/gi, /<\/nav>/gi, 'header', 8000);
  span(/<footer\b|<(div|section)\b[^>]*(id|class)\s*=\s*["'][^"']*footer[^"']*["']/gi, /<\/footer>/gi, 'footer', 30000);
  return R;
}
const inR = (rs, i) => rs.some(([a, b]) => i >= a && i < b);
function unwrap(u) {
  try { const x = new URL(u); if (/\/_next\/image|\/_vercel\/image|\/cdn-cgi\/image/.test(x.pathname) && x.searchParams.get('url')) return new URL(x.searchParams.get('url'), x.origin).href; } catch {}
  return u;
}
const bestSrcset = (ss) => { const p = ss.split(/,\s+(?=[^\s,])/).map((x) => x.trim().split(/\s+/)); let b = null; let bv = -1; p.forEach(([u, d], i) => { const v = d ? parseFloat(d) * (/x$/i.test(d) ? 1000 : 1) : i; if (u && v >= bv) { bv = v; b = u; } }); return b; };

function logoCandidates(html, base, rules) {
  const R = regions(html); const firstFooter = html.search(/<footer\b/i);
  const out = []; const add = (c) => { if (c.url || c.inline) out.push(c); };
  const homeAnchorBefore = (i) => {
    const pre = html.slice(Math.max(0, i - 1500), i); const a = pre.lastIndexOf('<a '); if (a < 0 || pre.indexOf('</a>', a) >= 0) return false;
    const href = attr(pre.slice(a), 'href') || ''; const lab = (attr(pre.slice(a), 'aria-label') || '') + (attr(pre.slice(a), 'title') || '');
    return HOME_HREF.test(href.trim()) || /home/i.test(lab) || (href && abs(href, base) && new URL(abs(href, base)).pathname.replace(/\/(home|index\.\w+)?$/i, '') === '' );
  };
  const ctxBefore = (i) => html.slice(Math.max(0, i - 700), i).match(/(class|id)\s*=\s*["'][^"']*(logo|brand|site-title|branding)[^"']*["']/i);
  const scoreTag = (i, text, kind, alt = '') => {
    let s = 0; const why = [];
    if (/logo|wordmark/i.test(text)) { s += 50; why.push('logo-ish class/id/src'); }
    else if (/logo|wordmark/i.test(alt)) { s += 25; why.push('logo in alt text only'); }
    else if (LOGOISH.test(text)) { s += 25; why.push('brand-ish attr'); }
    if (inR(R.header, i)) { s += 30; why.push('in header/nav'); }
    if (homeAnchorBefore(i)) { s += 25; why.push('inside home link'); }
    if (ctxBefore(i)) { s += 20; why.push('in logo/brand container'); }
    if (inR(R.footer, i) || (firstFooter >= 0 && i > firstFooter)) { s -= 45; why.push('footer'); }
    if (NOT_LOGO.test(text)) { s -= 70; why.push('icon/social/lang'); }
    if (/footer|mobile|sticky/i.test(text)) { s -= 8; why.push('variant'); }
    if (/print|dark|black|color|colour|blue|navy/i.test(text) && !/white|reverse|inverse|knockout/i.test(text)) { s += 3; why.push('dark/print variant (good on light header)'); }
    if (/white|reverse|inverse|knockout/i.test(text)) { s -= 3; why.push('light variant'); }
    if (/seal/i.test(text) && !/logo/i.test(text)) { s -= 10; why.push('seal'); }
    if (kind === 'svg') s += 6;
    if (/-\d{2,4}x\d{2,4}\.(jpe?g|png|webp)|\/uploads\/\d{4}\/\d{2}\//i.test(text) && !/logo/i.test(text.replace(/[^ ]*\/uploads\/[^ ]*/g, ''))) { s -= 15; why.push('CMS content thumbnail'); }
    if (/\.jpe?g(\?|$|\s)/i.test(text)) { s -= 10; why.push('jpeg (logos are rarely jpeg)'); }
    if (/^(image|photo|picture) of\b/i.test(alt.trim())) { s -= 20; why.push('descriptive alt'); }
    s -= Math.min(15, i / 20000); // earlier in the document is better
    return { s, why };
  };
  // <img> (src, data-src, srcset, data-srcset)
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const t = m[0]; const i = m.index;
    let src = attr(t, 'data-src') || attr(t, 'data-lazy-src') || attr(t, 'data-original');
    const ss = attr(t, 'srcset') || attr(t, 'data-srcset');
    const s0 = attr(t, 'src');
    if (!src) src = s0 && !s0.startsWith('data:') ? s0 : null;
    if (!src && s0 && /^data:image\/svg\+xml/i.test(s0) && s0.length > 400) src = s0;
    if (ss && (!src || /\/_next\/image/.test(src))) src = bestSrcset(ss) || src;
    if (!src) continue;
    const u = src.startsWith('data:') ? src : unwrap(abs(src, base));
    const text = [attr(t, 'class'), attr(t, 'id'), src.startsWith('data:') ? '' : src].join(' ');
    const { s, why } = scoreTag(i, text, /\.svg(\?|$)/i.test(u) ? 'svg' : 'img', attr(t, 'alt') || '');
    add({ kind: 'img', url: u, score: s, why, alt: attr(t, 'alt') || '', w: Number(attr(t, 'width')) || null, h: Number(attr(t, 'height')) || null });
  }
  // inline <svg>
  for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
    const t = m[0]; if (t.length < 300) continue; // icons
    const head = t.slice(0, 400) + ' ' + ((t.match(/<title[^>]*>([^<]*)/i) || [])[1] || '');
    const { s, why } = scoreTag(m.index, head, 'svg');
    if (/<use\b/i.test(t) && t.length < 600) continue; // sprite reference
    add({ kind: 'inline-svg', inline: t, url: null, score: s - (t.length < 1200 ? 15 : 0), why });
  }
  // CSS background-image on logo-ish selectors (incl. ::before/::after)
  const tokens = new Set([...html.matchAll(/\b(?:class|id)\s*=\s*["']([^"']+)["']/gi)].flatMap((m) => m[1].split(/\s+/)));
  for (const r of rules) {
    if (!LOGOISH.test(r.sel)) continue;
    const bg = decls(r.body).find(([p, v]) => /^(background(-image)?|content|mask(-image)?|-webkit-mask(-image)?)$/.test(p) && /url\(/i.test(v));
    if (!bg) continue;
    const um = bg[1].match(/url\(\s*["']?([^"')]+)["']?\s*\)/i); if (!um) continue;
    let u = um[1]; if (u.startsWith('data:') && !/^data:image\/svg/i.test(u)) continue;
    u = u.startsWith('data:') ? u : abs(u, r.sheet.startsWith('http') ? r.sheet : base); if (!u) continue;
    if (/sprite/i.test(u)) continue;
    let s = 45; const why = [`css ${bg[0]} on "${r.sel.slice(0, 60)}"`];
    const selTokens = (r.sel.match(/[.#][\w-]+/g) || []).map((x) => x.slice(1));
    if (selTokens.some((t) => tokens.has(t))) { s += 15; why.push('selector present in HTML'); } else { s -= 20; why.push('selector not in HTML'); }
    if (/header|masthead|navbar|banner/i.test(r.sel)) { s += 12; why.push('header selector'); }
    if (/footer|print|mobile|sticky|scroll|fixed|small/i.test(r.sel)) { s -= 15; why.push('variant selector'); }
    if (NOT_LOGO.test(u)) { s -= 50; why.push('icon-ish url'); }
    if (/[-_](mobile|sticky|small|sm|xs|mini|scroll|print)\b|[-_]m\.(svg|png)/i.test(u.split('?')[0].split('/').pop())) { s -= 6; why.push('variant file name'); }
    if (/\.svg(\?|$)/i.test(u) || /^data:image\/svg/i.test(u)) s += 6;
    if (/::?(before|after)/.test(r.sel)) why.push('pseudo-element');
    add({ kind: 'css-background', url: u, score: s, why, selector: r.sel.slice(0, 120) });
  }
  // fallbacks
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if (/property\s*=\s*["']og:image["']/i.test(m[0])) { const u = abs(attr(m[0], 'content') || '', base); if (u) add({ kind: 'og:image', url: u, score: 4, why: ['fallback og:image'] }); }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') || '').toLowerCase(); const u = abs(attr(m[0], 'href') || '', base); if (!u) continue;
    if (rel.includes('apple-touch-icon')) add({ kind: 'apple-touch-icon', url: u, score: 6, why: ['fallback apple-touch-icon'] });
    else if (/\bicon\b/.test(rel) && /\.svg(\?|$)/i.test(u)) add({ kind: 'svg-favicon', url: u, score: 5, why: ['fallback svg favicon'] });
  }
  // dedupe by URL (keep best)
  const best = new Map();
  for (const c of out) { const k = c.url || c.inline.slice(0, 500); const cur = best.get(k); if (!cur || c.score > cur.score) best.set(k, c); }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

// ---------- image inspection ----------
function svgDims(svg) {
  const root = (svg.match(/<svg\b[^>]*>/i) || [''])[0];
  const vb = attr(root, 'viewBox');
  const num = (v) => (v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : null);
  let w = num(attr(root, 'width')); let h = num(attr(root, 'height'));
  if (vb) { const p = vb.trim().split(/[\s,]+/).map(Number); if (p.length === 4 && p[2] > 0 && p[3] > 0) { if (!w || !h) { const r = p[2] / p[3]; if (w && !h) h = w / r; else if (h && !w) w = h * r; else { w = p[2]; h = p[3]; } } } }
  return w && h ? { w: Math.round(w), h: Math.round(h) } : null;
}
function rasterDims(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { fmt: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString('ascii', 0, 3) === 'GIF') return { fmt: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const f = b.toString('ascii', 12, 16);
    if (f === 'VP8 ') return { fmt: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (f === 'VP8L') { const n = b.readUInt32LE(21); return { fmt: 'webp', w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    if (f === 'VP8X') return { fmt: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { fmt: 'jpeg', w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }; i += 2 + b.readUInt16BE(i + 2); }
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { fmt: 'ico', w: b[6] || 256, h: b[7] || 256 };
  return null;
}
// Decode 8-bit PNG (gray/rgb/palette/gray+a/rgba; plain or Adam7-interlaced) -> stats on visible pixels.
function pngWhiteStats(b) {
  try {
    let i = 8; let w = 0; let h = 0; let depth = 0; let type = 0; let inter = 0; const idat = []; let pal = null; let trns = null;
    while (i < b.length) {
      const len = b.readUInt32BE(i); const t = b.toString('ascii', i + 4, i + 8); const d = b.subarray(i + 8, i + 8 + len);
      if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
      else if (t === 'PLTE') pal = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
      i += 12 + len;
    }
    if (depth !== 8) return null;
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]; if (!ch || (type === 3 && !pal)) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    // Adam7 passes [x0, y0, dx, dy]; non-interlaced = one pass covering the image.
    const passes = inter ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    let vis = 0; let white = 0; let transp = 0; let p = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.ceil((w - x0) / dx); const ph = Math.ceil((h - y0) / dy); if (pw <= 0 || ph <= 0) continue;
      const stride = pw * ch; let cur = Buffer.alloc(stride); let prev = Buffer.alloc(stride);
      for (let y = 0; y < ph; y++) {
        const f = raw[p++];
        for (let x = 0; x < stride; x++) {
          const L = x >= ch ? cur[x - ch] : 0; const U = prev[x]; const C = x >= ch ? prev[x - ch] : 0; let v = raw[p++];
          if (f === 1) v += L; else if (f === 2) v += U; else if (f === 3) v += (L + U) >> 1; else if (f === 4) { const pa = Math.abs(U - C); const pb = Math.abs(L - C); const pc = Math.abs(L + U - 2 * C); v += pa <= pb && pa <= pc ? L : pb <= pc ? U : C; }
          cur[x] = v & 255;
        }
        for (let x = 0; x < pw; x++) {
          let r; let g; let bl; let al = 255; const o = x * ch;
          if (type === 6) { r = cur[o]; g = cur[o + 1]; bl = cur[o + 2]; al = cur[o + 3]; } else if (type === 2) { r = cur[o]; g = cur[o + 1]; bl = cur[o + 2]; } else if (type === 0) { r = g = bl = cur[o]; } else if (type === 4) { r = g = bl = cur[o]; al = cur[o + 1]; } else { const k = cur[o]; r = pal[k * 3]; g = pal[k * 3 + 1]; bl = pal[k * 3 + 2]; al = trns && k < trns.length ? trns[k] : 255; }
          if (al < 64) { transp++; continue; }
          vis++; if (r > 225 && g > 225 && bl > 225) white++;
        }
        const tmp = prev; prev = cur; cur = tmp;
      }
    }
    const total = vis + transp; if (!total) return null;
    return { transparentFrac: transp / total, whiteFrac: vis ? white / vis : 0 };
  } catch { return null; }
}
// Paint colors actually used by an SVG (attributes, style="", <style> blocks).
function svgPaints(svg) {
  const s = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<(mask|clipPath|defs)\b[\s\S]*?<\/\1>/gi, (x) => (/<(linearGradient|radialGradient)/i.test(x) ? x.replace(/<(mask|clipPath)\b[\s\S]*?<\/\1>/gi, '') : ''));
  const vals = [];
  for (const m of s.matchAll(/\b(fill|stroke|stop-color)\s*=\s*["']([^"']+)["']/gi)) vals.push(m[2]);
  for (const m of s.matchAll(/(?:^|[;{\s"'])(fill|stroke|stop-color)\s*:\s*([^;}"']+)/gi)) vals.push(m[2]);
  const shapes = (s.match(/<(path|rect|circle|ellipse|polygon|polyline|line|text|tspan|use)\b/gi) || []).length;
  // shapes with no fill anywhere up the chain default to black — approximate: any shape with no fill attr/style and no class while no group fill
  const explicit = vals.map((v) => v.trim().toLowerCase()).filter((v) => v && v !== 'none' && v !== 'transparent' && !v.startsWith('url(') && v !== 'inherit');
  const hasDefaultBlack = shapes > 0 && !/\bfill\s*[:=]/i.test(s);
  return { explicit, hasDefaultBlack, shapes, currentColor: explicit.some((v) => v === 'currentcolor') };
}
const NAMED = { white: '#ffffff', black: '#000000', '#fff': '#ffffff' };
function svgIsWhite(svg) {
  const p = svgPaints(svg);
  if (p.hasDefaultBlack || !p.explicit.length) return { white: false, reason: p.shapes ? 'default (black) fill' : 'no shapes' };
  const cols = p.explicit.filter((v) => v !== 'currentcolor').map((v) => parseColor(NAMED[v] || v)).filter(Boolean);
  if (!cols.length) return { white: false, reason: p.currentColor ? 'currentColor (inherits page text color)' : 'unparsed paints' };
  const nonWhite = cols.filter((c) => !isLightInk(c) && c.a > 0.3);
  const gray = cols.filter((c) => !isNearWhite(c) && isLightInk(c)).length;
  return { white: nonWhite.length === 0, reason: nonWhite.length ? `${nonWhite.length}/${cols.length} non-white paints` : `all ${cols.length} paints white${gray ? ` or light gray (${gray})` : ''}` };
}
function recolorSvg(svg, hex) {
  const isW = (v) => { const c = parseColor(NAMED[v.trim().toLowerCase()] || v.trim()); return c && isNearWhite(c); };
  const isG = (v) => { const c = parseColor(NAMED[v.trim().toLowerCase()] || v.trim()); return c && !isNearWhite(c) && isLightInk(c); };
  // light-gray secondary ink -> a lighter tint of primary so two-tone logos keep their contrast
  const p = parseColor(hex); const ph = rgb2hsl(p); const tint = toHex(hsl2rgb(ph.h, ph.s, clamp(ph.l + 0.25, 0, 0.7)));
  svg = svg
    .replace(/\b(fill|stroke|stop-color)(\s*=\s*["'])([^"']+)(["'])/gi, (m, q, a, v, z) => (isG(v) ? q + a + tint + z : m))
    .replace(/(fill|stroke|stop-color)(\s*:\s*)(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi, (m, q, a, v) => (isG(v) ? q + a + tint : m));
  return svg
    .replace(/\b(fill|stroke|stop-color)(\s*=\s*["'])([^"']+)(["'])/gi, (m, p, a, v, z) => (isW(v) ? p + a + hex + z : m))
    .replace(/(fill|stroke|stop-color)(\s*:\s*)(#[0-9a-f]{3,8}|white|rgba?\([^)]*\))/gi, (m, p, a, v) => (isW(v) ? p + a + hex : m));
}

async function inspect(c, get) {
  let buf; let finalUrl = c.url;
  if (c.inline) buf = Buffer.from(c.inline);
  else if (c.url.startsWith('data:')) {
    const m = c.url.match(/^data:([^,;]+)(;base64)?,(.*)$/s); if (!m) throw new Error('bad data uri');
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  } else { const r = await get(c.url, { asBuffer: true, max: MAX_LOGO_BYTES }); buf = r.body; finalUrl = r.url; }
  const head = buf.subarray(0, 2000).toString('utf8');
  if (/<svg\b/i.test(head) || /<svg\b/i.test(buf.toString('utf8', 0, Math.min(buf.length, 20000)))) {
    const svg = buf.toString('utf8'); const d = svgDims(svg) || { w: c.w, h: c.h };
    const wd = svgIsWhite(svg);
    const embedded = /<image\b/i.test(svg);
    return { format: 'svg', buf: Buffer.from(svg), width: d && d.w, height: d && d.h, white: wd.white, whyWhite: wd.reason, embedded, finalUrl };
  }
  const d = rasterDims(buf); if (!d) throw new Error('not an image');
  let white = false; let whyWhite = null; let whiteFrac = null;
  if (d.fmt === 'png') { const st = pngWhiteStats(buf); if (st) { whiteFrac = st.transparentFrac > 0.15 ? st.whiteFrac : 0; white = st.transparentFrac > 0.15 && st.whiteFrac > 0.6; /* >60% of visible ink white: wordmark vanishes on a light header */ whyWhite = `${Math.round(st.whiteFrac * 100)}% of visible px white, ${Math.round(st.transparentFrac * 100)}% transparent`; } else whyWhite = 'png not decodable (16-bit or <8-bit) — check by eye'; }
  else if (d.fmt === 'gif' || d.fmt === 'jpeg') whiteFrac = 0;
  return { format: d.fmt, buf, width: d.w, height: d.h, white, whyWhite, whiteFrac, finalUrl };
}
const logoIs = (w, h) => (!w || !h ? null : w / h >= 1.5 ? 'wide' : w / h <= 0.67 ? 'tall' : 'square');

// ---------- main ----------
async function brand(site, { out } = {}) {
  const t0 = Date.now(); const deadline = t0 + BUDGET_MS; const get = makeFetch(deadline); const warnings = [];
  if (!/^https?:\/\//i.test(site)) site = 'https://' + site;
  const home = await get(site, { max: 6e6 });
  const base = home.url; const html = home.body; const host = new URL(base).hostname.replace(/^www\./, '');
  out = out || `/tmp/brand/${host}`;
  fs.mkdirSync(out, { recursive: true });
  // stylesheets in parallel (cap count + bytes)
  const ranked = rankSheets(html, base);
  const sheets = ranked.filter((x) => x.score > -3).slice(0, MAX_SHEETS);
  let cssBytes = 0;
  const got = await Promise.all(sheets.map((s) => get(s.url).then((r) => r, (e) => ({ err: String(e.message || e), url: s.url }))));
  const rules = [];
  const sheetLog = [];
  for (const g of got) {
    if (g.err) { sheetLog.push({ url: g.url, error: g.err }); continue; }
    if (cssBytes + g.body.length > MAX_CSS_BYTES) { sheetLog.push({ url: g.url, skipped: 'css byte cap' }); continue; }
    cssBytes += g.body.length; sheetLog.push({ url: g.url, bytes: g.body.length });
    rules.push(...cssRules(g.body, g.url));
  }
  const inlineCss = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const inlineRules = cssRules(inlineCss, base);
  if (!sheets.length && !inlineCss) warnings.push('no stylesheets found');

  const pal = paletteFrom(html, rules);
  warnings.push(...pal.warnings);

  // logo: rank, then inspect the top few in parallel and take the best that decodes
  const lc = logoCandidates(html, base, rules.concat(inlineRules));
  const viable = lc.filter((c) => c.score > 0);
  const tryList = (viable.length ? viable : lc).slice(0, 4);
  const insp = await Promise.all(tryList.map((c) => inspect(c, get).then((r) => r, (e) => ({ err: String(e.message || e) }))));
  let chosen = null; let ci = -1;
  for (let i = 0; i < tryList.length; i++) {
    const r = insp[i]; if (r.err) { tryList[i].error = r.err; continue; }
    if (r.width && r.height && Math.max(r.width, r.height) < 24) { tryList[i].error = `too small ${r.width}x${r.height}`; continue; }
    chosen = r; ci = i; break;
  }
  const logo = { url: null, file: null, format: null, width: null, height: null, logoIs: null, whiteOnTransparent: false, recoloredFile: null, use: null, kind: null, candidates: [] };
  if (chosen) {
    const c = tryList[ci];
    const ext = chosen.format === 'jpeg' ? 'jpg' : chosen.format;
    const file = `${out}/logo.${ext}`; fs.writeFileSync(file, chosen.buf);
    Object.assign(logo, { url: c.inline ? null : (c.url.startsWith('data:') ? 'data:(inline in CSS)' : chosen.finalUrl), kind: c.kind, file, format: chosen.format, width: chosen.width || null, height: chosen.height || null, logoIs: logoIs(chosen.width, chosen.height), whiteOnTransparent: !!chosen.white, whiteCheck: chosen.whyWhite, use: file });
    if (!logo.width) warnings.push('logo has no intrinsic size (SVG without viewBox/width/height); logo-is left unset — check by eye');
    if (chosen.embedded) warnings.push('SVG logo embeds a raster <image>; colors/white check apply only to vector parts');
    if (c.score < 30) warnings.push(`logo is a weak match (${c.kind}, score ${Math.round(c.score)}) — confirm by eye; may be a fallback icon`);
    if (chosen.white) {
      if (chosen.format === 'svg' && pal.primary) {
        const rf = `${out}/logo-recolored.svg`; fs.writeFileSync(rf, recolorSvg(chosen.buf.toString('utf8'), pal.primary));
        logo.recoloredFile = rf; logo.use = rf;
        warnings.push(`logo is white-on-transparent (invisible on a light header); use ${rf} (white -> ${pal.primary})`);
      } else {
        // White raster: look for a recolorable white SVG or a dark variant among the other inspected logo candidates.
        const structural = (x) => x.why.some((w) => /inside home link|logo\/brand container|selector present/.test(w)) && /logo|brand|mark|seal/i.test(x.url || '');
        const alts = tryList.map((x, i) => ({ x, r: insp[i] })).filter(({ x, r }) => x !== c && !r.err && structural(x) && (r.format === 'svg' || (!r.white && r.whiteFrac != null && r.whiteFrac <= 0.35)));
        const alt = alts.find(({ r }) => r.format === 'svg') || alts[0];
        if (alt) {
          const ax = alt.x; const ar = alt.r; const aext = ar.format === 'jpeg' ? 'jpg' : ar.format;
          const af = `${out}/logo-alt.${aext}`; fs.writeFileSync(af, ar.buf);
          logo.alternate = { url: ax.url, file: af, format: ar.format, width: ar.width, height: ar.height, logoIs: logoIs(ar.width, ar.height), whiteOnTransparent: !!ar.white, why: ax.why };
          if (ar.format === 'svg' && ar.white && pal.primary) {
            const rf = `${out}/logo-recolored.svg`; fs.writeFileSync(rf, recolorSvg(ar.buf.toString('utf8'), pal.primary));
            logo.recoloredFile = rf; logo.alternate.recoloredFile = rf; logo.use = rf;
            warnings.push(`header logo is a white-on-transparent raster (no auto-recolor); alternate white SVG ${ax.url} recolored to ${rf} — check it is the same mark before using`);
          } else warnings.push(`header logo is a white-on-transparent raster; non-white alternate saved to ${af} — check it is the same mark`);
        } else warnings.push('logo is a white-on-transparent raster; cannot recolor automatically — use it on a primary-colored header band, or find a dark variant');
      }
    }
  } else warnings.push('no usable logo found — leave the blueprint placeholder (logo-is square)');
  logo.candidates = lc.slice(0, 8).map((c) => ({ kind: c.kind, url: c.inline ? '(inline svg)' : c.url && c.url.startsWith('data:') ? c.url.slice(0, 40) + '…' : c.url, score: Math.round(c.score), why: c.why, ...(c.selector ? { selector: c.selector } : {}), ...(c.error ? { error: c.error } : {}) }));

  return { site: base, ms: Date.now() - t0, palette: { primary: pal.primary, secondary: pal.secondary, accent: pal.accent, candidates: pal.candidates }, logo, warnings, sheets: sheetLog };
}

// ---------- --apply: logo + header fragment in DA ----------
const DA_ORG = 'adobe-pubsec'; const DA_REPO = 'city-county';
const DA_MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
// Brand section of a header fragment: from <main> to its section-metadata (or the first nav list).
function brandRegion(t) {
  const start = t.indexOf('<main>') >= 0 ? t.indexOf('<main>') : 0;
  const ends = [t.indexOf('class="section-metadata"', start), t.indexOf('<ul', start)].filter((x) => x > start);
  return [start, ends.length ? Math.min(...ends) : t.length];
}
// Rewrite the header HTML; pure, so --dry-run and tests can use it. Returns { html, changes }.
function rewriteHeader(html, { slug, ext, logoIs: is }) {
  const changes = []; let t = html;
  const logoUrl = `https://content.da.live/${DA_ORG}/${DA_REPO}/sites/${slug}/fragments/nav/.header/logo.${ext}`;
  // 1. logo refs (img src + source srcset): absolute content.da.live form (what clone-blueprint and
  //    existing tenants use) from any base, or a relative .header/logo.<ext>.
  let n = 0;
  t = t.replace(/https:\/\/content\.da\.live\/[^"'\s>]*?\/fragments\/nav\/\.header\/logo\.[a-z0-9]+/gi, (m) => { n++; return logoUrl; });
  t = t.replace(/((?:src|srcset)=")(?:\.\/)?\.header\/logo\.[a-z0-9]+/gi, (m, a) => { n++; return a + logoUrl; });
  changes.push(`logo refs -> .header/logo.${ext}: ${n}`);
  // 2. logo-is value cell(s), e.g. …<p>logo-is</p></div><div><p>square</p>…
  if (is) {
    let k = 0;
    t = t.replace(/(<p>logo-is<\/p><\/div>\s*<div>\s*<p>)([^<]*)(<\/p>)/gi, (m, a, v, b) => { k++; return a + is + b; });
    changes.push(`logo-is -> ${is}: ${k}`);
  }
  // 3. brand-section home links -> /sites/<slug>/ (trailing slash; /sites/<slug> 404s).
  const [start, end] = brandRegion(t);
  let h = 0; const home = `/sites/${slug}/`;
  const brandPart = t.slice(start, end).replace(/(<a\b[^>]*?\shref=")([^"]*)(")/gi, (m, a, v, b) => { if (v !== home) h++; return a + home + b; });
  t = t.slice(0, start) + brandPart + t.slice(end);
  changes.push(`home links -> ${home}: ${h} fixed`);
  return { html: t, changes, logoUrl };
}

async function applyLogo(r, { slug, token, dryRun = false } = {}) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('--apply needs --slug <slug> (lowercase, a-z0-9-)');
  const base = `sites/${slug}/fragments/nav`;
  const src = (p) => `https://admin.da.live/source/${DA_ORG}/${DA_REPO}/${p}`;
  const headerPath = `${base}/header.html`;
  const out = { headerPath, logoPath: null, headerChanged: false, logoIs: null, dryRun: !!dryRun, changes: [], verified: false };
  const l = r.logo || {};
  if (!l.use) { out.warning = 'no usable logo; header left untouched (blueprint placeholder, logo-is square)'; return out; }
  const ext = (l.use.match(/\.([a-z0-9]+)$/i) || [])[1].toLowerCase().replace('jpeg', 'jpg');
  const mime = DA_MIME[ext]; if (!mime) throw new Error(`unsupported logo type .${ext}`);
  out.logoPath = `${base}/.header/logo.${ext}`; out.logoIs = l.logoIs || null; out.logoFile = l.use;
  if (!out.logoIs) out.warning = 'logo has no intrinsic size; logo-is left as authored';
  if (!token) {
    if (dryRun) { out.plan = [`GET ${headerPath}`, `PUT ${out.logoPath} (${mime}, from ${l.use})`, `rewrite logo src -> .header/logo.${ext}, logo-is -> ${out.logoIs}, brand home links -> /sites/${slug}/`, `PUT ${headerPath}, re-GET verify`]; out.warning = (out.warning ? out.warning + '; ' : '') + 'no DA_TOKEN: plan only, header not read'; return out; }
    throw new Error('no DA_TOKEN (export DA_TOKEN=$(oauth-token adobe | tr -d \'[:space:]\'))');
  }
  const auth = { Authorization: `Bearer ${token}` };
  const put = async (p, bytes, type) => {
    const fd = new FormData(); fd.append('data', new Blob([bytes], { type }), p.split('/').pop());
    const x = await fetchT(src(p), { method: 'PUT', headers: auth, body: fd }, 30000);
    if (!x.ok) throw new Error(`PUT ${p} -> ${x.status}`);
    return x.status;
  };
  const get = async (p) => { const x = await fetchT(src(p), { headers: auth }, 20000); if (!x.ok) throw new Error(`GET ${p} -> ${x.status}${x.status === 404 ? ' (clone the tenant first)' : x.status === 401 || x.status === 403 ? ' (refresh DA_TOKEN)' : ''}`); return Buffer.from(await x.arrayBuffer()); };
  const before = (await get(headerPath)).toString('utf8');
  const rw = rewriteHeader(before, { slug, ext, logoIs: out.logoIs });
  out.changes = rw.changes; out.headerChanged = rw.html !== before; out.logoUrl = rw.logoUrl;
  if (!/\.header\/logo\./.test(before)) out.warning = (out.warning ? out.warning + '; ' : '') + 'header had no .header/logo.* reference; logo uploaded but not linked';
  if (dryRun) { out.plan = [`PUT ${out.logoPath} (${mime}, ${fs.statSync(l.use).size} bytes)`, out.headerChanged ? `PUT ${headerPath} (${rw.changes.join('; ')})` : `header already up to date; no PUT`]; return out; }
  const logoBytes = fs.readFileSync(l.use);
  await put(out.logoPath, logoBytes, mime);
  if (out.headerChanged) await put(headerPath, Buffer.from(rw.html, 'utf8'), 'text/html');
  // Verify: re-GET both. Header must carry the new src, logo-is and home links.
  const [hBack, lBack] = await Promise.all([get(headerPath), get(out.logoPath)]);
  const back = hBack.toString('utf8');
  const checks = {
    headerMatches: back === rw.html,
    logoSrc: back.includes(rw.logoUrl),
    logoIs: !out.logoIs || new RegExp(`<p>logo-is</p></div>\\s*<div>\\s*<p>${out.logoIs}</p>`).test(back),
    homeLinks: (() => { const [a0, b0] = brandRegion(back); const hs = [...back.slice(a0, b0).matchAll(/<a\b[^>]*?\shref="([^"]*)"/gi)].map((m) => m[1]); return hs.length > 0 && hs.every((x) => x === `/sites/${slug}/`); })(),
    logoBytes: lBack.length === logoBytes.length,
  };
  out.checks = checks; out.verified = Object.values(checks).every(Boolean);
  if (!out.verified) throw Object.assign(new Error('--apply verify failed: ' + JSON.stringify(checks)), { applied: out });
  return out;
}

module.exports = { brand, applyLogo, rewriteHeader, parseColor, contrastWhite, svgIsWhite, recolorSvg, logoIs, VAR_FRAMEWORK };

if (isMain(module)) {
  const a = process.argv.slice(2);
  const oi = a.indexOf('--out'); const out = oi >= 0 ? a[oi + 1] : undefined;
  const si = a.indexOf('--slug'); const slug = si >= 0 ? a[si + 1] : undefined;
  const apply = a.includes('--apply'); const dryRun = a.includes('--dry-run');
  const url = a.filter((x, i) => !x.startsWith('--') && !(oi >= 0 && i === oi + 1) && !(si >= 0 && i === si + 1))[0];
  if (!url || (apply && !slug)) { console.error('usage: brand.cjs <site-url> [--out <dir>] [--json] [--apply --slug <slug> [--dry-run]]'); process.exitCode = 1; }
  else brand(url, { out }).then(async (r) => {
    if (apply) {
      try { r.applied = await applyLogo(r, { slug, token: (process.env.DA_TOKEN || '').trim(), dryRun }); }
      catch (e) { r.applied = e.applied || { error: String(e.message || e) }; r.applied.error = String(e.message || e); }
    }
    if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      const p = r.palette; const l = r.logo;
      console.log(`site: ${r.site}  (${r.ms} ms)`);
      console.log(`palette: primary ${p.primary}  secondary ${p.secondary}  accent ${p.accent}`);
      p.candidates.slice(0, 6).forEach((c, i) => console.log(`  ${i + 1}. ${c.hex}  score ${c.score}  ${c.contrastWhite}:1  ${c.evidence.join('; ')}`));
      if (l.file) console.log(`logo: ${l.kind} ${l.format} ${l.width}x${l.height} logo-is=${l.logoIs} white=${l.whiteOnTransparent}\n  src  ${l.url || '(inline svg)'}\n  use  ${l.use}`);
      else console.log('logo: none found');
      r.warnings.forEach((w) => console.log('warning: ' + w));
      const ap = r.applied;
      if (ap) {
        if (ap.error) console.log(`apply: FAILED  ${ap.error}`);
        else if (ap.dryRun) console.log(`apply (dry run): ${ap.headerPath}\n  ${(ap.plan || []).join('\n  ')}`);
        else console.log(`apply: ${ap.logoPath ? 'uploaded ' + ap.logoPath : 'no logo'}  header ${ap.headerChanged ? 'updated' : 'unchanged'}  logo-is=${ap.logoIs}  verified=${ap.verified}${ap.changes.length ? '\n  ' + ap.changes.join('\n  ') : ''}`);
        if (ap.warning) console.log('warning: ' + ap.warning);
      }
    }
    process.exitCode = r.applied && r.applied.error ? 1 : r.palette.primary && r.logo.file ? 0 : 2;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
