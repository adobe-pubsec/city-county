#!/usr/bin/env node
// site-images.cjs — harvest place photos from a city/county's OWN website.
// Homepage first, then up to N inner pages (parks/about/visit/community...).
// Resolves CMS-resized variants to originals, reads real pixel size, filters out
// stock, logos, people/news shots, and tiny images. Read-only; downloads nothing to disk.
// Module: require('./site-images.cjs').siteImages(url, count, pages)
// CLI:   node site-images.cjs <siteUrl> [count=6] [--pages 2] [--json]
// Exit 0 = >=count usable images, 2 = fewer (caller should top up from Commons), 1 = error.

const { UA_BROWSER: UA, isMain } = require('./lib.cjs');
const T = 15000;

const STOCK = /(shutterstock|istock|adobestock|adobe[-_]stock|gettyimages|getty[-_]|depositphotos|dreamstime|123rf|stock[-_]?photo|unsplash|pexels)/i;
const JUNK = /(logo|icon|sprite|favicon|badge|seal|flag|emblem|placeholder|avatar|headshot|portrait|staff|mayor|council|commissioner|supervisor|board[-_ %20]of|director|chief|meeting|agenda|flyer|poster|graphic|banner|camps?|registration|online|events?[-_]festivals|button|social|facebook|twitter|instagram|youtube|qr[-_]?code|map|chart|screenshot|construction|closure|detour|alert|covid|vote|voting|election|ballot|ribbon)/i;
const PLACE = /(skyline|downtown|city[-_ ]?hall|courthouse|capitol|government[-_ ]center|park|river|lake|trail|bridge|aerial|drone|sunset|sunrise|view|street|plaza|square|library|museum|garden|greenbelt|waterfront|harbor|mountain|historic|landmark|main[-_ ]street|fountain|festival|market|tree|spring|fall|autumn|winter|summer|header|hero|homepage)/i;
const INNER = /(^|[\/\s_-])(parks|parks-and-recreation|parks-recreation|recreation|about|about-us|visit|visitors|visiting|tourism|explore|history|living[-_ ]here|discover|things[-_ ]to[-_ ]do)([\/\s_.-]|$)/i;
const NOT_INNER = /(parking|ticket|permit|pay|bill|tax|assistance|mental|health|court|jail|police|job|career|bid|rfp|form|login|account|meeting|agenda)/i;
const PEOPLE = /\b(man|woman|men|women|boy|girl|kids?|child|children|family|people|person|crowd|volunteers?|students?|ribbon[-_ ]cutting|dedication)\b/i;

async function fetchT(url, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), T);
  try { return await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctl.signal, ...opts }); }
  finally { clearTimeout(t); }
}
const dec = (s) => s.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').trim();

function extract(html, base) {
  const out = new Map(); // url -> context text
  const add = (u, ctx) => {
    if (!u || u.startsWith('data:')) return;
    try { const abs = new URL(dec(u), base).href; if (!out.has(abs)) out.set(abs, (ctx || '').slice(0, 200)); } catch {}
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const alt = (tag.match(/\balt=["']([^"']*)/i) || [])[1] || '';
    const ss = (tag.match(/\b(?:data-srcset|srcset)=["']([^"']+)/i) || [])[1];
    if (ss) { const last = ss.split(',').map((s) => s.trim().split(/\s+/)[0]).pop(); add(last, alt); }
    add((tag.match(/\b(?:data-src|data-lazy-src|src)=["']([^"']+)/i) || [])[1], alt);
  }
  for (const m of html.matchAll(/<source\b[^>]*srcset=["']([^"']+)/gi)) add(m[1].split(',').pop().trim().split(/\s+/)[0], '');
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+\.(?:jpe?g|webp|png)[^"')]*)/gi)) add(m[1], 'background');
  const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i) || [])[1];
  if (og) add(og, 'og:image');
  return out;
}

// Candidate original URLs for common CMS resize patterns, best first.
function originals(u) {
  const c = [];
  const url = new URL(u);
  // WordPress: name-750x375.jpg -> name.jpg ; also -scaled
  const wp = url.pathname.replace(/-\d{2,5}x\d{2,5}(\.[a-z]+)$/i, '$1');
  if (wp !== url.pathname) c.push(url.origin + wp);
  // Umbraco/ImageProcessor/Drupal styles: strip resize query; Drupal /styles/<style>/public/ -> /
  if (url.search && /(width|height|mode|crop|anchor|w=|h=|resize|quality|itok)/i.test(url.search)) c.push(url.origin + url.pathname);
  const dr = url.pathname.replace(/\/styles\/[^/]+\/public\//, '/');
  if (dr !== url.pathname) c.push(url.origin + dr);
  c.push(u);
  return [...new Set(c)];
}

// Read JPEG/PNG/WebP dimensions from the first bytes (Range request; falls back to full body).
function dims(buf) {
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const f = b.toString('ascii', 12, 16);
    if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (f === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1, type: 'webp' }; }
    if (f === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), type: 'webp' };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), type: 'jpeg' };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

async function probe(u) {
  let fallback = null;
  for (const cand of originals(u)) {
    try {
      const r = await fetchT(cand, { headers: { 'User-Agent': UA, Range: 'bytes=0-131071' } });
      if (!r.ok && r.status !== 206) continue;
      const ct = r.headers.get('content-type') || '';
      if (!/image\/(jpe?g|png|webp)/i.test(ct)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const d = dims(buf); if (!d) continue;
      const total = Number((r.headers.get('content-range') || '').split('/')[1]) || Number(r.headers.get('content-length')) || buf.length;
      const hit = { url: cand, from: u, width: d.w, height: d.h, type: d.type, bytes: total, resolvedOriginal: cand !== u };
      if (total > 8e6 && cand !== u) { fallback = fallback || hit; continue; } // too heavy for a live upload; try the served variant
      if (hit.width < 1000 && fallback) return fallback;
      return hit;
    } catch {}
  }
  return fallback;
}

async function siteImages(site, want = 6, maxPages = 2) {

  const home = await fetchT(site);
  const homeUrl = home.url || site; const homeHtml = await home.text();
  const host = new URL(homeUrl).hostname.replace(/^www\./, '');
  const pages = [{ url: homeUrl, html: homeHtml }];

  // Inner pages likely to carry place imagery (same site only).
  const links = [...homeHtml.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => { try { return { href: new URL(dec(m[1]), homeUrl).href, text: m[2].replace(/<[^>]+>/g, ' ').trim() }; } catch { return null; } })
    .filter((l) => l && new URL(l.href).hostname.replace(/^www\./, '') === host && INNER.test(new URL(l.href).pathname + ' ' + l.text) && !NOT_INNER.test(l.href + ' ' + l.text) && !/\.(pdf|docx?|xlsx?)$/i.test(l.href));
  const seenL = new Set();
  for (const l of links) {
    if (pages.length > maxPages) break;
    const k = l.href.replace(/\/$/, ''); if (seenL.has(k) || k === homeUrl.replace(/\/$/, '')) continue; seenL.add(k);
    try { const r = await fetchT(l.href); if (r.ok) pages.push({ url: r.url || l.href, html: await r.text() }); } catch {}
  }

  // Collect + pre-filter by name/alt.
  const cands = new Map();
  for (const p of pages) for (const [u, ctx] of extract(p.html, p.url)) {
    const name = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
    if (!/\.(jpe?g|webp|png)$/i.test(name)) continue;
    const text = name + ' ' + ctx;
    if (STOCK.test(text)) { cands.set(u, { skip: 'stock', name }); continue; }
    if (JUNK.test(text)) { cands.set(u, { skip: 'junk', name }); continue; }
    if (!cands.has(u)) cands.set(u, { page: p.url, alt: ctx, name, place: PLACE.test(text) });
  }

  // Probe real size (originals), keep landscape >= 1200px wide, collapse duplicates of the same original.
  const keep = []; const seen = new Set(); const skipped = [];
  const todo = [...cands.entries()].filter(([, v]) => !v.skip).slice(0, 40);
  for (let i = 0; i < todo.length; i += 6) {
    const res = await Promise.all(todo.slice(i, i + 6).map(async ([u, v]) => ({ v, p: await probe(u) })));
    for (const { v, p } of res) {
      if (!p) { skipped.push({ name: v.name, why: 'unreadable' }); continue; }
      const key = v.name.toLowerCase().replace(/\.[a-z]+$/, '').replace(/(-\d{2,5}x\d{2,5}|-scaled|-e\d{9,}|-\d+)+$/g, '');
      if (seen.has(key)) continue; seen.add(key);
      const ratio = p.width / p.height;
      if (p.width < 1000) { skipped.push({ name: v.name, why: `small ${p.width}x${p.height}` }); continue; }
      if (ratio < 1.15 || ratio > 3.2) { skipped.push({ name: v.name, why: `aspect ${ratio.toFixed(2)}` }); continue; }
      const people = PEOPLE.test(v.name.replace(/[-_]/g, ' ') + ' ' + v.alt);
      keep.push({ ...p, page: v.page, alt: v.alt, name: v.name, people, score: (v.place ? 1000 : 0) - (people ? 800 : 0) + (p.bytes > 8e6 ? -300 : 0) + (p.type === 'png' ? -600 : 0) + Math.min(p.width, 4000) / 10 });
    }
  }
  for (const [, v] of cands) if (v.skip) skipped.push({ name: v.name, why: v.skip });
  keep.sort((a, b) => b.score - a.score);
  const images = keep.slice(0, want).map(({ score, ...x }) => ({ ...x, source: 'official-site', origin: 'official-site', license: 'owned by ' + host + ' (internal demo use)' }));

  return { site: homeUrl, pagesScanned: pages.map((p) => p.url), usable: keep.length, images, skipped };
}

module.exports = { siteImages };

if (isMain(module)) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const pi = args.indexOf('--pages'); const maxPages = pi >= 0 ? Number(args[pi + 1]) : 2;
  const pos = args.filter((a, i) => !a.startsWith('--') && i !== pi + 1);
  if (!pos[0]) { console.error('usage: site-images.cjs <siteUrl> [count] [--pages N] [--json]'); process.exitCode = 1; }
  else siteImages(pos[0], Number(pos[1] || 6), maxPages).then((r) => {
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`site: ${r.site}\npages: ${r.pagesScanned.join('  ')}\nusable: ${r.usable}`);
      r.images.forEach((x, i) => console.log(`${i + 1}. ${x.width}x${x.height} ${(x.bytes / 1e6).toFixed(1)}MB ${x.people ? '[people] ' : ''}${x.name}`));
    }
    process.exitCode = r.images.length >= Number(pos[1] || 6) ? 0 : 2;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
