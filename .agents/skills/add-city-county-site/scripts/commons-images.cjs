#!/usr/bin/env node
// commons-images.cjs — pick 5-6 authentic, freely licensed photos of a place from
// Wikimedia Commons (category from Wikidata P373), with attribution metadata.
// Module: require('./commons-images.cjs').commonsImages(category, count, article)
// CLI:   node commons-images.cjs "<Commons category>" [count=6] [--article "<Wikipedia title>"] [--json]
// Ranking: images used in the Wikipedia article (editor-curated) > landmark subjects > size; junk subjects dropped; near-duplicates collapsed.

const { UA_BOT: UA, isMain } = require('./lib.cjs');
const API = 'https://commons.wikimedia.org/w/api.php?format=json&';
const OK_LICENSE = /^(cc0|cc[- ]by(-sa)?[- ]?\d|public domain|pd)/i;
const SKIP_NAME = /(map|locator|seal|flag|logo|coat[_ ]of[_ ]arms|diagram|chart|svg$|\.pdf$|\.tif|census|plat|signature|bathroom|restroom|toilet|donut|food|meal|kiosk|sign\b|parking|selfie|portrait|interior|restoration|construction|accident|crash|protest|mugshot|grave|tombstone|school bus|\bbus\b|vehicle|car show|i don't|trying|devastation|hurricane|flood|wildfire|damage|demonstration|interlocking)/i;
const LANDMARK = /(skyline|downtown|capitol|city hall|courthouse|bridge|river|lake|falls|park|aerial|panorama|view|main street|historic|district|plaza|square|mountain|harbor|waterfront|library|museum|station)/i;
const stem = (t) => t.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/[\s_-]*(\(\d+\)|\d+|panoramio|\(unsplash\))[\s_.-]*/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

async function api(params) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { return await (await fetch(API + params, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: ctl.signal })).json(); }
  finally { clearTimeout(t); }
}
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function commonsImages(cat, want = 6, article = null) {

  // Files directly in the category, plus one level of likely-scenic subcategories.
  const titles = new Set();
  const scenic = /(skyline|downtown|landmark|building|park|street|river|bridge|capitol|courthouse|hall|view|aerial|panorama)/i;
  const top = await api('action=query&list=categorymembers&cmlimit=200&cmtype=file|subcat&cmtitle=' + encodeURIComponent('Category:' + cat));
  const subs = [];
  for (const m of top?.query?.categorymembers || []) (m.ns === 6 ? titles.add(m.title) : scenic.test(m.title) && subs.push(m.title));
  for (const s of subs.slice(0, 6)) {
    const r = await api('action=query&list=categorymembers&cmlimit=60&cmtype=file&cmtitle=' + encodeURIComponent(s));
    for (const m of r?.query?.categorymembers || []) titles.add(m.title);
  }
  // Images used in the Wikipedia article itself.
  const inArticle = new Set();
  if (article) {
    const ctl = new AbortController(); const tt = setTimeout(() => ctl.abort(), 15000);
    try {
      const w = await (await fetch('https://en.wikipedia.org/w/api.php?format=json&action=query&prop=images&imlimit=100&titles=' + encodeURIComponent(article), { headers: { 'User-Agent': UA }, signal: ctl.signal })).json();
      for (const p of Object.values(w?.query?.pages || {})) for (const im of p.images || []) { inArticle.add(im.title); titles.add(im.title); }
    } catch {} finally { clearTimeout(tt); }
  }
  const list = [...titles].filter((t) => /\.(jpe?g)$/i.test(t) && !SKIP_NAME.test(t));

  // Fetch image info in batches of 50: size, license, author, 1600px thumb.
  const picks = [];
  for (let i = 0; i < list.length && picks.length < 80; i += 50) {
    const r = await api('action=query&prop=imageinfo&iiprop=url|size|extmetadata|mime&iiurlwidth=1600&titles=' + encodeURIComponent(list.slice(i, i + 50).join('|')));
    for (const p of Object.values(r?.query?.pages || {})) {
      const ii = p.imageinfo?.[0]; if (!ii) continue;
      const md = ii.extmetadata || {};
      const lic = strip(md.LicenseShortName?.value);
      if (!OK_LICENSE.test(lic)) continue;
      const ratio = ii.width / ii.height;
      if (ii.width < 1600 || ratio < 1.2 || ratio > 2.1) continue; // landscape, hero-croppable (no extreme panoramas)
      picks.push({
        title: p.title, width: ii.width, height: ii.height, license: lic,
        licenseUrl: md.LicenseUrl?.value || '', artist: strip(md.Artist?.value).slice(0, 120),
        description: strip(md.ImageDescription?.value).slice(0, 200),
        source: ii.descriptionurl, download: ii.thumburl || ii.url,
        inArticle: inArticle.has(p.title),
        score: (inArticle.has(p.title) ? 2000 : 0) + (md.Assessments?.value ? 1000 : 0) + (LANDMARK.test(p.title + ' ' + strip(md.ImageDescription?.value)) ? 500 : 0) + Math.min(ii.width, 6000) / 20,
      });
    }
  }
  picks.sort((a, b) => b.score - a.score);
  const seen = new Set(); const out = [];
  const tier = (x) => x.inArticle || x.score >= 500;
  const ordered = [...picks.filter(tier), ...picks.filter((x) => !tier(x))];
  for (const x of ordered) { const k = stem(x.title).slice(0, 18); if (seen.has(k)) continue; seen.add(k); out.push(x); if (out.length >= want) break; }
  return { category: cat, candidates: list.length, usable: picks.length, images: out.map(({ score, ...x }) => ({ ...x, origin: 'wikimedia-commons' })) };
}

module.exports = { commonsImages };

if (isMain(module)) {
  const args = process.argv.slice(2); const asJson = args.includes('--json');
  const ai = args.indexOf('--article'); const article = ai >= 0 ? args[ai + 1] : null;
  const rest = args.filter((a, i) => a !== '--json' && i !== ai && i !== ai + 1);
  if (!rest[0]) { console.error('usage: commons-images.cjs "<Commons category>" [count] [--article "<title>"] [--json]'); process.exitCode = 1; }
  else commonsImages(rest[0], Number(rest[1] || 6), article).then((r) => {
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else { console.log(`category: ${r.category}  files considered: ${r.candidates}  usable: ${r.usable}`); r.images.forEach((x, i) => console.log(`${i + 1}. ${x.inArticle ? '[article] ' : ''}${x.title}  ${x.width}x${x.height}  ${x.license}  by ${x.artist}`)); }
    process.exitCode = r.images.length >= Math.min(5, Number(rest[1] || 6)) ? 0 : 2;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
