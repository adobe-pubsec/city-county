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
const JUNK = /(logo|icon|sprite|favicon|badge|seal|flag|emblem|placeholder|avatar|headshot|portrait|staff|mayor|council|commissioner|supervisor|board[-_ %20]of|director|chief|meeting|agenda|flyer|poster|graphic|banner|camps?|registration|online|events?[-_]festivals|button|social|facebook|twitter|instagram|youtube|qr[-_]?code|map|chart|screenshot|construction|closure|detour|alert|covid|vote|voting|election|ballot|ribbon|press[-_ ]?release|newsletter|advertis)/i;
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

// Query params that only select a CMS rendition (OpenCities ?dimension=pageimage&w=345,
// Umbraco ?width=&mode=, imgix ?w=&fit=, Drupal ?itok=). Anything else in the query is kept.
const RESIZE_Q = /^(dimension|w|h|width|height|mode|rmode|crop|anchor|center|quality|q|resize|fit|format|fm|auto|itok|scale|size|dpr|ixlib|bgcolor|rnd|v|cb|ts|focus|fp-x|fp-y|maxwidth|maxheight)$/i;
// Same image, any rendition -> one key (used to collapse srcset/<source>/<img> variants).
function canon(u) {
  try {
    const x = new URL(u); const keep = new URLSearchParams();
    for (const [k, v] of x.searchParams) if (!RESIZE_Q.test(k)) keep.append(k, v);
    const q = keep.toString();
    return x.origin + x.pathname + (q ? '?' + q : '');
  } catch { return u; }
}
const qWidth = (u) => { try { const p = new URL(u).searchParams; return Number(p.get('w') || p.get('width') || p.get('maxwidth') || 0); } catch { return 0; } };
// Largest entry of a srcset ("a.jpg 480w, b.jpg 1200w" / "a.jpg 1x, b.jpg 2x"); last entry when no descriptors.
function bestSrcset(ss) {
  const parts = dec(ss).split(/,\s+(?=[^\s,])/).map((p) => p.trim().split(/\s+/)).filter((p) => p[0]);
  let best = null; let bv = -1;
  parts.forEach(([u, d], i) => { const v = d ? parseFloat(d) * (/x$/i.test(d) ? 1000 : 1) : i; if (v >= bv) { bv = v; best = u; } });
  return best;
}

function extract(html, base) {
  const out = new Map(); // canonical url -> { url: largest variant seen, ctx }
  const add = (u, ctx) => {
    if (!u || u.startsWith('data:') || /^\s*\{/.test(u)) return;
    try {
      const abs = new URL(dec(u), base).href; const k = canon(abs); const cur = out.get(k);
      if (!cur) out.set(k, { url: abs, ctx: (ctx || '').slice(0, 200) });
      else { if (qWidth(abs) > qWidth(cur.url)) cur.url = abs; if (!cur.ctx && ctx) cur.ctx = ctx.slice(0, 200); }
    } catch {}
  };
  const attr = (tag, re) => (tag.match(re) || [])[1];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const alt = attr(tag, /\balt=["']([^"']*)/i) || '';
    for (const ss of tag.matchAll(/\b(?:data-lazy-srcset|data-srcset|srcset)=["']([^"']+)/gi)) add(bestSrcset(ss[1]), alt);
    for (const src of tag.matchAll(/\b(?:data-src|data-lazy-src|data-original|data-lazy|data-full(?:-src)?|data-large(?:_|-)file|src)=["']([^"']+)/gi)) add(src[1], alt);
  }
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) for (const ss of m[0].matchAll(/\b(?:data-srcset|srcset)=["']([^"']+)/gi)) add(bestSrcset(ss[1]), '');
  for (const m of html.matchAll(/\bdata-(?:bg|background(?:-image)?)=["']([^"']+\.(?:jpe?g|webp|png)[^"']*)/gi)) add(m[1], 'background');
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+\.(?:jpe?g|webp|png)[^"')]*)/gi)) add(m[1], 'background');
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["']/i.test(m[0])) continue;
    const c = attr(m[0], /\bcontent=["']([^"']+)/i); if (c) add(c, 'og:image');
  }
  const res = new Map(); // url -> context text (same shape as before)
  for (const { url, ctx } of out.values()) res.set(url, ctx);
  return res;
}

// Candidate original URLs for common CMS resize patterns, best first.
function originals(u) {
  const c = [];
  const url = new URL(u);
  // WordPress: name-750x375.jpg -> name.jpg ; also -scaled
  const wp = url.pathname.replace(/-\d{2,5}x\d{2,5}(\.[a-z]+)$/i, '$1');
  if (wp !== url.pathname) c.push(url.origin + wp);
  // Umbraco/ImageProcessor/Drupal styles: strip resize query; Drupal /styles/<style>/public/ -> /
  if (url.search && /(width|height|mode|crop|anchor|dimension|w=|h=|resize|quality|itok)/i.test(url.search)) {
    const k = canon(u); if (k !== url.origin + url.pathname) c.push(k);
    c.push(url.origin + url.pathname);
  }
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
  const tier = (l) => { const t = new URL(l.href).pathname + ' ' + l.text; return /(parks|trails|natural[-_ ]areas|greenways?)/i.test(t) ? 0 : /(visit|tourism|explore|discover|things[-_ ]to[-_ ]do)/i.test(t) ? 1 : /(about|history|living)/i.test(t) ? 2 : 3; };
  const seenL = new Set([homeUrl.replace(/\/$/, '')]);
  const queue = links.filter((l) => { const k = l.href.replace(/\/$/, ''); if (seenL.has(k)) return false; seenL.add(k); return true; });
  const fetchPages = async (n, ranked) => {
    if (ranked) queue.sort((a, b) => tier(a) - tier(b)); // top-up only: place-rich sections first (stable)
    const batch = queue.splice(0, n);
    const got = await Promise.all(batch.map(async (l) => { try { const r = await fetchT(l.href); return r.ok ? { url: r.url || l.href, html: await r.text() } : null; } catch { return null; } }));
    return got.filter(Boolean);
  };
  pages.push(...await fetchPages(maxPages));

  const cands = new Map(); const keep = []; const seen = new Set(); const skipped = [];
  let probed = 0;
  const harvest = async (list) => {
    // Collect + pre-filter by name/alt.
    const fresh = [];
    for (const p of list) for (const [u, ctx] of extract(p.html, p.url)) {
      const name = decodeURIComponent(new URL(u).pathname.split('/').pop() || '');
      if (!/\.(jpe?g|webp|png)$/i.test(name)) continue;
      if (cands.has(u) || [...cands.keys()].some((k) => canon(k) === canon(u))) continue; // same image, other rendition
      const text = name + ' ' + ctx;
      if (STOCK.test(text)) { cands.set(u, { skip: 'stock', name }); continue; }
      if (JUNK.test(text)) { cands.set(u, { skip: 'junk', name }); continue; }
      const v = { page: p.url, alt: ctx, name, place: PLACE.test(text) };
      cands.set(u, v); fresh.push([u, v]);
    }
    // Probe real size (originals), keep landscape >= 1000px wide, collapse duplicates of the same original.
    const todo = fresh.slice(0, Math.max(0, 40 - probed)); probed += todo.length;
    for (let i = 0; i < todo.length; i += 6) {
      const res = await Promise.all(todo.slice(i, i + 6).map(async ([u, v]) => ({ v, p: await probe(u) })));
      for (const { v, p } of res) {
        if (!p) { skipped.push({ name: v.name, why: 'unreadable' }); continue; }
        const key = v.name.toLowerCase().replace(/\.[a-z]+$/, '').replace(/(-\d{2,5}x\d{2,5}|-scaled|-e\d{9,}|-\d+)+$/g, '');
        if (seen.has(key)) continue; seen.add(key);
        const ratio = p.width / p.height;
        if (p.width < 1000) { skipped.push({ name: v.name, why: `small ${p.width}x${p.height}` }); continue; }
        // Ultra-wide page-header banners (e.g. OpenCities 1920x450) are real photos and usable as a hero
        // crop; keep them but rank below normal photos so they only fill gaps.
        const banner = ratio > 3.2 && ratio <= 4.6 && p.width >= 1600;
        if (ratio < 1.15 || (ratio > 3.2 && !banner)) { skipped.push({ name: v.name, why: `aspect ${ratio.toFixed(2)}` }); continue; }
        const people = PEOPLE.test(v.name.replace(/[-_]/g, ' ') + ' ' + v.alt);
        keep.push({ ...p, page: v.page, alt: v.alt, name: v.name, people, ...(banner ? { banner: true } : {}), score: (banner ? -1500 : 0) + (v.place ? 1000 : 0) - (people ? 800 : 0) + (p.bytes > 8e6 ? -300 : 0) + (p.type === 'png' ? -600 : 0) + Math.min(p.width, 4000) / 10 });
      }
    }
  };
  await harvest(pages);
  // Thumbnail-heavy CMSs (OpenCities) put most uploads at 480px; when short, scan up to 3 more
  // inner pages in parallel (~0.3 s) instead of returning too few. Sites that already have enough skip this.
  if (keep.length < want && queue.length && probed < 40) { const more = await fetchPages(3, true); pages.push(...more); await harvest(more); }
  for (const [, v] of cands) if (v.skip) skipped.push({ name: v.name, why: v.skip });
  keep.sort((a, b) => b.score - a.score);
  const images = keep.slice(0, want).map(({ score, ...x }) => ({ ...x, source: 'official-site', origin: 'official-site', license: 'owned by ' + host + ' (internal demo use)' }));

  return { site: homeUrl, pagesScanned: pages.map((p) => p.url), usable: keep.length, images, skipped };
}

module.exports = { siteImages, extract, originals, canon };

if (isMain(module)) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const pi = args.indexOf('--pages'); const maxPages = pi >= 0 ? Number(args[pi + 1]) : 2;
  const pos = args.filter((a, i) => !a.startsWith('--') && !(pi >= 0 && i === pi + 1));
  if (!pos[0]) { console.error('usage: site-images.cjs <siteUrl> [count] [--pages N] [--json]'); process.exitCode = 1; }
  else siteImages(pos[0], Number(pos[1] || 6), maxPages).then((r) => {
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`site: ${r.site}\npages: ${r.pagesScanned.join('  ')}\nusable: ${r.usable}`);
      r.images.forEach((x, i) => console.log(`${i + 1}. ${x.width}x${x.height} ${(x.bytes / 1e6).toFixed(1)}MB ${x.people ? '[people] ' : ''}${x.banner ? '[banner] ' : ''}${x.name}`));
    }
    process.exitCode = r.images.length >= Number(pos[1] || 6) ? 0 : 2;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
