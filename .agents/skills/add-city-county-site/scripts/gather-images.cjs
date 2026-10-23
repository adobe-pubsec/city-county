#!/usr/bin/env node
// gather-images.cjs — collect ~12 candidate place photos for a tenant, official site
// first, Wikimedia Commons to top up; download each locally so the agent can view them.
// View them with `open --view --size 300x200 <files>` (downsizes on the fly) and pick the best 6.
//
// File names / alt text are NOT reliable on their own (e.g. "history_museum.jpg"
// turned out to be a meeting room) — the visual pick is a required step.
//
// Usage: node gather-images.cjs <siteUrl> <outDir> [--stock "<City, State>"] [--commons "<P373 category>"] [--article "<Wikipedia title>"] [--want 12]
// Writes <outDir>/candidates.json and <outDir>/c01.<ext> … (extension from the real content type).
const fs = require('fs');
const { fetchT, UA_BROWSER, isMain } = require('./lib.cjs');
const { siteImages } = require('./site-images.cjs');
const { commonsImages } = require('./commons-images.cjs');
const { stockImages } = require('./stock-images.cjs');

const MAX_BYTES = 8e6; // keep live uploads fast; DA/AEM both fine well under this

// Download; extension comes from magic bytes (sites serve PNGs named .jpg and vice versa).
async function download(url, base, maxBytes) {
  const r = await fetchT(url, { headers: { 'User-Agent': UA_BROWSER } }, 45000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) throw new Error('too large ' + buf.length);
  const ext = buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : null;
  if (!ext) throw new Error('not an image');
  const file = base + '.' + ext;
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, ext };
}

async function gatherImages(site, outDir, { commons, article, want = 12, stock, siteWant = 4 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  // Default source mix (stage mode): Adobe Stock watermarked comps for the AEM set (fast, reliable
  // place photos, no license used) + a few official-site photos for the hero. Commons only as a top-up.
  // Stock and site run in parallel.
  const [fromStock, fromSite] = await Promise.all([
    stock ? stockImages(stock, outDir, want).catch((e) => ({ candidates: [], error: String(e.message || e) })) : Promise.resolve({ candidates: [] }),
    siteImages(site, stock ? siteWant : want, stock ? 1 : 2).catch((e) => ({ images: [], error: String(e.message || e) })),
  ]);
  let cands = fromSite.images.filter((x) => x.bytes <= MAX_BYTES);
  const stockOut = (fromStock.candidates || []).filter((c) => c.file).map((c) => ({ ...c, url: c.details, page: c.details, name: c.title, width: 1000, alt: c.title, license: 'Adobe Stock watermarked comp (unlicensed; demo preview)', artist: c.creator }));
  let fromCommons = { images: [] };
  if (cands.length + stockOut.length < want && commons) {
    fromCommons = await commonsImages(commons, want - cands.length - stockOut.length + 2, article).catch((e) => ({ images: [], error: String(e.message || e) }));
    cands = cands.concat(fromCommons.images.map((x) => ({ ...x, url: x.download, name: x.title.replace(/^File:/, '') })));
  }
  cands = cands.slice(0, Math.max(0, want - stockOut.length) + (stock ? siteWant : 0));

  const out = [];
  let i = 0;
  for (const c of cands) {
    const n = String(++i).padStart(2, '0');
    const rec = { id: n, origin: c.origin, url: c.url, page: c.page || c.source, name: c.name, width: c.width, height: c.height, alt: c.alt || c.description || '', license: c.license, artist: c.artist || null, people: !!c.people };
    try {
      Object.assign(rec, await download(c.url, `${outDir}/c${n}`, MAX_BYTES));
    } catch (e) { rec.error = String(e.message || e); }
    out.push(rec);
  }
  // Stock comps are already on disk (s01.jpg …); just list them.
  for (const c of stockOut) out.push({ id: c.id, origin: 'adobe-stock-comp', stockId: c.stockId, url: c.details, page: c.details, name: c.title, alt: c.title, keywords: c.keywords, license: c.license, artist: c.creator, file: c.file, bytes: c.bytes, ext: 'jpg', width: 1000, height: c.fullWidth ? Math.round(1000 * c.fullHeight / c.fullWidth) : undefined });
  const res = { site: fromSite.site || site, siteCount: fromSite.images.length, stockCount: stockOut.length, commonsCount: fromCommons.images.length, candidates: out };
  fs.writeFileSync(`${outDir}/candidates.json`, JSON.stringify(res, null, 2));
  return res;
}

module.exports = { gatherImages };

if (isMain(module)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const pos = a.filter((x, i) => !x.startsWith('--') && !['--commons', '--article', '--want', '--stock'].includes(a[i - 1]));
  if (pos.length < 2) { console.error('usage: gather-images.cjs <siteUrl> <outDir> [--stock "<City, State>"] [--commons "<cat>"] [--article "<title>"] [--want 12]'); process.exitCode = 1; }
  else gatherImages(pos[0], pos[1], { stock: opt('--stock'), commons: opt('--commons'), article: opt('--article'), want: Number(opt('--want') || 12) }).then((r) => {
    console.log(`site: ${r.site}  official-site: ${r.siteCount}  stock: ${r.stockCount}  commons: ${r.commonsCount}`);
    for (const c of r.candidates) console.log(`${c.id} [${c.origin === 'official-site' ? 'site' : c.origin === 'adobe-stock-comp' ? 'stock' : 'commons'}]${c.people ? '[people]' : ''} ${c.width}x${c.height} ${c.error ? 'ERROR ' + c.error : (c.bytes / 1e6).toFixed(1) + 'MB'}  ${c.file || ''}  ${c.name}`);
    console.log(`wrote ${pos[1]}/candidates.json`);
    process.exitCode = r.candidates.filter((c) => !c.error).length >= 6 ? 0 : 2;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
