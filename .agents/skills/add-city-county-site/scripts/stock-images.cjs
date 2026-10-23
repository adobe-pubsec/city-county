#!/usr/bin/env node
// stock-images.cjs — candidate place photos from Adobe Stock as WATERMARKED COMP previews
// (1000px, no license consumed, no auth needed). Downloads them locally for the visual pick.
//
// Usage: node stock-images.cjs "<place, e.g. Asheville, North Carolina>" <outDir> [--want 12] [--json]
// Writes <outDir>/s01.jpg … and <outDir>/stock.json. ~2-3 s total.
// Every record carries stockId + details URL, so a comp can be licensed later (same id).
const fs = require('fs');
const path = require('path');
const { isMain } = require('./lib.cjs');

const API = 'https://stock.adobe.io/Rest/Media/1/Search/Files';
const HEADERS = { 'x-api-key': 'AdobeStockClient1', 'X-Product': 'SLICC-city-county/1.0' };
// Titles that are rarely what a city homepage wants.
const SKIP = /(map|flag|seal|logo|icon|vector|illustration|silhouette|abstract|texture|pattern|3d|render|icon|sign|text|word|lettering|stamp|badge|real estate|house for sale|interior|portrait|woman|man |girl|boy|couple|wedding|selfie|food|drink|beer|car |truck|bird|swallow|heron|duck|deer|squirrel|butterfly|insect|flower close|macro|accident|crash|police|protest|fire damage|flood|hurricane|storm damage|destroyed|debris)/i;

async function f(url, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { headers: HEADERS, signal: c.signal }); } finally { clearTimeout(t); }
}

async function search(words, limit) {
  const p = new URLSearchParams();
  p.set('search_parameters[words]', words);
  p.set('search_parameters[limit]', String(limit));
  p.set('search_parameters[order]', 'relevance');
  p.set('search_parameters[filters][content_type:photo]', '1');
  p.set('search_parameters[filters][content_type:illustration]', '0');
  p.set('search_parameters[filters][content_type:vector]', '0');
  p.set('search_parameters[filters][orientation]', 'horizontal');
  for (const c of ['nb_results', 'id', 'title', 'width', 'height', 'comp_url', 'thumbnail_1000_url', 'creator_name', 'keywords', 'details_url', 'is_editorial', 'category']) p.append('result_columns[]', c);
  const r = await f(API + '?' + p.toString());
  if (!r.ok) throw new Error('Stock search HTTP ' + r.status);
  return r.json();
}

async function stockImages(place, outDir, want = 12) {
  fs.mkdirSync(outDir, { recursive: true });
  const short = place.split(',')[0].trim();
  // Two queries in parallel: the place itself, and a skyline/landmark-biased one.
  const [a, b] = await Promise.all([search(place, 40), search(`${short} skyline downtown`, 20).catch(() => ({ files: [] }))]);
  const seen = new Set(); const picks = [];
  for (const x of [...(a.files || []), ...(b.files || [])]) {
    if (seen.has(x.id)) continue; seen.add(x.id);
    if (SKIP.test(x.title || '')) continue;
    if (x.width / x.height < 1.2) continue;
    // Prefer titles that actually name the place.
    x._score = (new RegExp(short, 'i').test(x.title) ? 100 : 0) + (/(skyline|aerial|downtown|city hall|courthouse|capitol|river|lake|mountain|bridge|park|panorama|historic)/i.test(x.title) ? 50 : 0);
    picks.push(x);
  }
  picks.sort((p, q) => q._score - p._score);
  // Collapse near-duplicates: same photographer + same first 3 title words (series shots).
  const key = (x) => (x.creator_name || '') + '|' + (x.title || '').toLowerCase().split(/\W+/).filter(Boolean).slice(0, 3).join(' ');
  const keys = new Set(); const chosen = [];
  for (const x of picks) { const k = key(x); if (keys.has(k)) continue; keys.add(k); chosen.push(x); if (chosen.length >= want) break; }
  const out = await Promise.all(chosen.map(async (x, i) => {
    const id = 's' + String(i + 1).padStart(2, '0');
    const rec = { id, origin: 'adobe-stock-comp', stockId: x.id, title: x.title, creator: x.creator_name, details: x.details_url, editorial: !!x.is_editorial, keywords: (x.keywords || []).map((k) => k.name).slice(0, 12), fullWidth: x.width, fullHeight: x.height, ext: 'jpg' };
    try {
      const r = await f(x.comp_url || x.thumbnail_1000_url, 30000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      rec.file = path.join(outDir, id + '.jpg'); rec.bytes = buf.length;
      fs.writeFileSync(rec.file, buf);
    } catch (e) { rec.error = String(e.message || e); }
    return rec;
  }));
  const res = { place, totalResults: a.nb_results, candidates: out };
  fs.writeFileSync(path.join(outDir, 'stock.json'), JSON.stringify(res, null, 2));
  return res;
}

module.exports = { stockImages };

if (isMain(module)) {
  const a = process.argv.slice(2);
  const wi = a.indexOf('--want'); const want = wi >= 0 ? Number(a[wi + 1]) : 12;
  const pos = a.filter((x, i) => !x.startsWith('--') && !(wi >= 0 && i === wi + 1));
  if (pos.length < 2) { console.error('usage: stock-images.cjs "<place>" <outDir> [--want 12] [--json]'); process.exitCode = 1; }
  else {
    const t0 = Date.now();
    stockImages(pos[0], pos[1], want).then((r) => {
      if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`place: ${r.place}  stock results: ${r.totalResults}  downloaded: ${r.candidates.filter((c) => c.file).length}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        r.candidates.forEach((c) => console.log(`${c.id} ${c.error ? 'ERROR ' + c.error : c.file}  #${c.stockId}${c.editorial ? ' [editorial]' : ''}  ${c.title.slice(0, 70)}  — ${c.creator}`));
      }
      process.exitCode = r.candidates.filter((c) => c.file).length >= 6 ? 0 : 2;
    }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
  }
}
