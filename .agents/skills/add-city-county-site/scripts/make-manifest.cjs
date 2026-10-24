#!/usr/bin/env node
// make-manifest.cjs — write the aem-assets.cjs manifest from picked gather-images IDs
// (SKILL step 6d.3), optionally the homepage hero.jpg (step 6c). Replaces the hand-written
// manifest: Stock titles/artists come from stock.json (not candidates.json), rights wording
// matches the existing manifests, and every file is sniffed by magic bytes and converted
// to a real JPEG when its extension lies (sites serve PNGs named .jpg) or it isn't JPEG.
//
// Usage: node make-manifest.cjs <img-dir> --slug <slug> --entity "<City of X, State>"
//          --pick s02,s04,c03,... [--hero c03] [--out <img-dir>/manifest.json]
//          [--host <author url>] [--title c03="Downtown on Congress Street"] [--json]
//   IDs as in gather-images output: s01… = Stock comps, c01… (or 01…) = official-site / Commons.
//   --title (repeatable) overrides the generated title for one ID (site photos often have no alt).
//   --hero: also writes <img-dir>/hero.jpg; Stock comps lose the left 60 px Stock-ID strip.
// Exit: 0 = manifest written, 2 = written with fallbacks (a conversion/crop failed; see warnings),
//       1 = error (bad args, unknown ID, missing file).
// Writes only into <img-dir> (and --out). Never uploads; run aem-assets.cjs on the result.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { isMain, slugify } = require('./lib.cjs');

const HOST = 'https://author-p129103-e1259846.adobeaemcloud.com';
const STATES = { alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc' };
// Words that never make a good file-name subject.
const STOP = new Set('a an the of in on at over from and with by for to as is are its it this that near during including into onto under above along across through around between view viewed views photo photos photograph photography image picture shot wide angle beautiful vibrant stunning amazing gorgeous daytime overhead perspective blue skies sky city town usa us america american riding hitting multiple main south north east west springtime summertime wintertime just very being seen looking taken high resolution hd 4k stock editorial background copy space'.split(' '));
const CONNECT = new Set(['of', 'la', 'de', 'del', 'the', 'and', 'el', 'san', 'santa']);

// ---------- image bytes ----------
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  return null;
}
// Intrinsic size from the bytes (JPEG SOFn, PNG IHDR, GIF, WebP VP8/VP8L/VP8X).
function dims(buf) {
  const t = sniff(buf);
  if (t === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (t === 'gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (t === 'webp') {
    const k = buf.toString('ascii', 12, 16);
    if (k === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    if (k === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  }
  if (t === 'jpg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const mk = buf[i + 1];
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7) || mk === 0xff) { i += mk === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}
// magick-wasm via SLICC's `convert` shell command (works from node's child_process).
function convert(args) {
  cp.execFileSync('convert', args, { timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = args[args.length - 1];
  if (!fs.existsSync(out) || sniff(fs.readFileSync(out)) !== 'jpg') throw new Error('convert produced no JPEG');
  return out;
}

// ---------- text ----------
const clean = (s) => String(s || '').replace(/[\u201c\u201d"]/g, '"').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function shortTitle(s, max = 70) {
  s = s.replace(/^(wide[- ]angle |overhead |high[- ]resolution )?(photo|photograph|image|picture|shot) of\s+/i, '').replace(/,?\s+(USA|U\.S\.A|United States)\b/g, '');
  s = cap(s);
  if (s.length <= 60) return s;
  // Cut at a clause boundary first ("… including …", "… during …", ", …").
  const m = s.slice(20).match(/\s(including|during|with|while|as seen|on a|and the|in the (spring|summer|fall|autumn|winter)time)\s|,\s/i);
  if (m) s = s.slice(0, 20 + m.index);
  if (s.length <= max) return s;
  let t = s.slice(0, max).replace(/\s+\S*$/, '');
  t = t.replace(/[\s,;:-]+(of|in|on|at|and|the|a|an|with|from|over|including|to|by|for)$/i, '').replace(/[\s,;:-]+$/, '');
  return t;
}
function placeInfo(entity, slug) {
  const [first, ...rest] = entity.split(',').map((x) => x.trim());
  const short = first.replace(/^(city and county|city|town|village|county|borough|township) of\s+/i, '');
  const state = (rest.join(' ') || '').trim();
  const phrases = new Set([short, short.replace(/\s+(county|city|town|parish|borough)$/i, ''), state, STATES[state.toLowerCase()] || '', 'usa', 'u.s.a', 'united states'].map((x) => x.toLowerCase()).filter(Boolean));
  for (const p of slug.split('-')) if (p.length > 2 || Object.values(STATES).includes(p)) phrases.add(p);
  return { short, state, creator: first, phrases: [...phrases].map((p) => p.split(/\s+/)).sort((a, b) => b.length - a.length) };
}
// Token list with original case + position + quoted flag; punctuation splits runs.
function tokens(title) {
  const out = []; let seg = 0; let quoted = false;
  for (const m of title.matchAll(/"|[,;:()/.!?\u2013\u2014]|[A-Za-z0-9][A-Za-z0-9'\u2019&-]*/g)) {
    const t = m[0];
    if (t === '"') { quoted = !quoted; continue; }
    if (/^[,;:()/.!?\u2013\u2014]$/.test(t)) { seg++; continue; }
    out.push({ t: t.replace(/['\u2019]s$/i, '').replace(/['\u2019]/g, ''), lc: t.toLowerCase().replace(/['\u2019]s$/i, '').replace(/['\u2019]/g, ''), seg, quoted, pos: out.length });
  }
  return out;
}
// Mark tokens that belong to a place phrase (city name, state, abbreviation, USA).
function markPlace(tk, phrases) {
  for (let i = 0; i < tk.length; i++) {
    for (const p of phrases) {
      if (i + p.length > tk.length) continue;
      if (p.every((w, k) => tk[i + k].lc === w && tk[i + k].seg === tk[i].seg)) { for (let k = 0; k < p.length; k++) tk[i + k].place = true; break; }
    }
  }
  return tk;
}
// Subject candidates for the file name, best first.
function subjects(title, place) {
  const tk = markPlace(tokens(title), place.phrases);
  const words = tk.filter((x) => /[a-z]/i.test(x.t));
  const isCap = (x) => /^[A-Z]/.test(x.t) || x.quoted;
  // Title Case titles ("Blue Skies Aerial Perspective Downtown") carry no proper-noun signal.
  const content = words.filter((x) => !x.place && !(CONNECT.has(x.lc) || ['in', 'on', 'at', 'over', 'from', 'a', 'an', 'to', 'by', 'for', 'with', 'is'].includes(x.lc)));
  const titleCase = content.length >= 3 && content.filter((x) => /^[A-Z]/.test(x.t)).length / content.length >= 0.9;
  const out = [];
  // 1) proper-noun runs ("Saguaro National Park", "University of Arizona", "A" Mountain) unless the title is Title Case.
  if (!titleCase) {
    let run = [];
    const flush = () => {
      while (run.length && CONNECT.has(run[run.length - 1].lc) && !run[run.length - 1].quoted) run.pop();
      // Drop a leading/trailing city or state ("Tucson Botanical Gardens"), but keep "University of Arizona".
      while (run.length && run[0].place) run.shift();
      while (run.length > 1 && run[run.length - 1].place && !CONNECT.has(run[run.length - 2].lc)) run.pop();
      const real = run.filter((x) => !STOP.has(x.lc) && !x.place);
      const okSingle = run.length === 1 && real.length === 1 && (run[0].pos > 0 || run[0].quoted);
      if ((run.length >= 2 && real.length >= 1) || okSingle) out.push(run.slice(0, 4).map((x) => x.lc));
      run = [];
    };
    for (const x of tk) {
      const last = run[run.length - 1];
      if (last && x.seg !== last.seg) flush();
      if (isCap(x) || (run.length && CONNECT.has(x.lc) && x.lc !== 'the')) run.push(x); else flush();
    }
    flush();
  }
  // 2) plain content words, first three.
  const plain = tk.filter((x) => !x.place && !STOP.has(x.lc) && !/^\d+$/.test(x.lc) && x.lc.length > 1).map((x) => x.lc);
  if (plain.length) out.push(plain.slice(0, 3));
  return { list: out, plain };
}
function pickName(slug, title, place, used) {
  const { list, plain } = subjects(title, place);
  const kebab = (ws) => slugify(ws.join('-'));
  const tries = list.map(kebab).filter(Boolean);
  for (const s of tries) if (!used.has(s)) { used.add(s); return s; }
  // Collision: extend the best subject with a distinguishing content word (max 4 words).
  const base = tries[0] || 'photo';
  for (const w of plain) {
    const s = kebab([...base.split('-'), w].slice(-4));
    if (!base.split('-').includes(w) && !used.has(s)) { used.add(s); return s; }
  }
  for (let n = 2; ; n++) { const s = `${base}-${n}`; if (!used.has(s)) { used.add(s); return s; } }
}
function describe(title, place) {
  const t = cap(clean(title));
  const re = new RegExp('\\b' + place.short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  return re.test(t) ? `${t}.` : `${t} in ${place.short}${place.state ? ', ' + place.state : ''}.`;
}
const humanFile = (n) => cap(String(n || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').replace(/\s+\d+$/, '').trim());

// ---------- main ----------
function makeManifest(imgDir, { slug, entity, pick = [], hero, out, host = HOST, titles = {} } = {}) {
  if (!slug || !entity || !pick.length) throw new Error('need --slug, --entity and --pick');
  const warnings = []; let fallbacks = 0;
  const cj = JSON.parse(fs.readFileSync(path.join(imgDir, 'candidates.json'), 'utf8'));
  const sjPath = path.join(imgDir, 'stock.json');
  const stock = fs.existsSync(sjPath) ? JSON.parse(fs.readFileSync(sjPath, 'utf8')) : { candidates: [] };
  const byId = new Map(cj.candidates.map((c) => [c.id, c]));
  const stockById = new Map((stock.candidates || []).map((c) => [c.id, c]));
  const resolve = (id) => {
    const k = String(id).trim();
    const c = byId.get(k) || byId.get(k.replace(/^c/i, '')) || stockById.get(k);
    if (!c) throw new Error(`unknown id ${k} (have: ${[...byId.keys()].map((x) => (/^\d/.test(x) ? 'c' + x : x)).join(',')})`);
    return { c, s: stockById.get(c.id) || null, label: /^\d/.test(c.id) ? 'c' + c.id : c.id };
  };
  const place = placeInfo(entity, slug);
  const used = new Set();
  const images = []; const report = [];

  for (const id of pick) {
    const { c, s, label } = resolve(id);
    const file = c.file || (s && s.file);
    if (c.error || !file || !fs.existsSync(file)) throw new Error(`${label}: no downloaded file (${c.error || file || 'missing'})`);
    const isStock = c.origin === 'adobe-stock-comp';
    const isCommons = c.origin === 'wikimedia-commons';
    const rawTitle = titles[label] || titles[c.id] || (isStock ? (s && s.title) || c.name : c.alt || (isCommons ? humanFile(c.name) : humanFile(c.name) + ', ' + place.short));
    const title = shortTitle(cap(clean(rawTitle)));
    const subject = pickName(slug, rawTitle, place, used);
    // Real format from the bytes, then a true JPEG for AEM.
    const buf = fs.readFileSync(file); const real = sniff(buf);
    const ext = (path.extname(file).slice(1) || '').toLowerCase().replace('jpeg', 'jpg');
    let useFile = file; let outExt = 'jpg'; let converted = false;
    if (!real) throw new Error(`${label}: ${file} is not an image`);
    if (real !== 'jpg' || ext !== 'jpg') {
      const dst = path.join(imgDir, `${path.basename(file).replace(/\.[^.]+$/, '')}-conv.jpg`);
      try {
        if (real === 'jpg') { fs.copyFileSync(file, dst); } else convert([file, '-quality', '85', dst]);
        useFile = dst; converted = real !== 'jpg';
        if (ext !== real) warnings.push(`${label}: ${path.basename(file)} is really ${real.toUpperCase()}; ${converted ? 'converted to' : 'copied as'} ${path.basename(dst)}`);
      } catch (e) {
        // Fallback: keep the original format under the right extension (aem-assets sets the MIME from it).
        const dst2 = path.join(imgDir, `${path.basename(file).replace(/\.[^.]+$/, '')}-fixed.${real}`);
        fs.copyFileSync(file, dst2); useFile = dst2; outExt = real; fallbacks++;
        warnings.push(`${label}: JPEG conversion failed (${String(e.message || e).split('\n')[0]}); using ${path.basename(dst2)} as ${real.toUpperCase()}`);
      }
    }
    const kw = [...new Set([...((s && s.keywords) || c.keywords || []).map((k) => String(k).toLowerCase().trim()), ...subject.split('-').filter((w) => !STOP.has(w) && w.length > 2)].filter(Boolean))].slice(0, 10);
    const host0 = (() => { try { return new URL(c.url || cj.site).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();
    const img = {
      file: useFile,
      name: `${slug}-${subject}.${outExt}`,
      title,
      description: describe(rawTitle, place),
      descriptionAuto: true,
      keywords: kw,
      source: isStock ? ((s && s.details) || c.url) : isCommons ? (c.page || c.url) : c.url,
      creator: isStock ? ((s && s.creator) || c.artist || '') : isCommons ? (c.artist || '') : place.creator,
      rights: isStock ? `Adobe Stock #${c.stockId || (s && s.stockId)} watermarked comp, unlicensed (demo preview)`
        : isCommons ? `${c.license || 'see file page'} via Wikimedia Commons; ${c.page || c.url}`
          : (c.license || `owned by ${host0} (internal demo use)`),
    };
    images.push(img);
    report.push({ id: label, origin: c.origin, format: real, converted, file: useFile, name: img.name, title });
  }
  if (images.length < 5 || images.length > 6) warnings.push(`${images.length} images picked; the demo expects 5–6`);

  let heroOut = null;
  if (hero) {
    const { c, s, label } = resolve(hero);
    const file = c.file || (s && s.file);
    const buf = fs.readFileSync(file); const d = dims(buf);
    heroOut = path.join(imgDir, 'hero.jpg');
    try {
      if (c.origin === 'adobe-stock-comp') {
        if (!d) throw new Error('cannot read comp size');
        convert([file, '-crop', `${d.w - 60}x${d.h}+60+0`, '-quality', '85', heroOut]);
      } else if (sniff(buf) === 'jpg') fs.copyFileSync(file, heroOut);
      else convert([file, '-quality', '85', heroOut]);
    } catch (e) {
      fallbacks++;
      if (sniff(buf) === 'jpg') { fs.copyFileSync(file, heroOut); warnings.push(`hero ${label}: crop/convert failed (${String(e.message || e).split('\n')[0]}); copied uncropped`); } else { heroOut = null; warnings.push(`hero ${label}: convert failed (${String(e.message || e).split('\n')[0]}); no hero.jpg written`); }
    }
    if (heroOut) {
      const hd = dims(fs.readFileSync(heroOut));
      heroOut = { id: label, file: heroOut, width: hd && hd.w, height: hd && hd.h, cropped: c.origin === 'adobe-stock-comp' && !!hd && !!d && hd.w === d.w - 60 };
    }
  }

  const manifest = { host, parent: 'city-county', parentTitle: 'City-County Demo', slug, entity, images };
  const outPath = out || path.join(imgDir, 'manifest.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  return { manifest: outPath, count: images.length, hero: heroOut, images: report, warnings, fallbacks };
}

module.exports = { makeManifest, sniff, dims };

if (isMain(module)) {
  const a = process.argv.slice(2);
  const VAL = ['--slug', '--entity', '--pick', '--hero', '--out', '--host', '--title'];
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const titles = {};
  a.forEach((x, i) => { if (x === '--title' && a[i + 1]) { const m = a[i + 1].match(/^([^=]+)=(.*)$/); if (m) titles[m[1].trim()] = m[2].trim(); } });
  const pos = a.filter((x, i) => !x.startsWith('--') && !VAL.includes(a[i - 1]));
  const usage = 'usage: make-manifest.cjs <img-dir> --slug <slug> --entity "<City of X, State>" --pick s02,s04,c03,... [--hero c03] [--out <img-dir>/manifest.json] [--host <author>] [--title <id>="<title>"] [--json]';
  if (!pos[0] || !opt('--slug') || !opt('--entity') || !opt('--pick')) { console.error(usage); process.exitCode = 1; }
  else {
    try {
      const r = makeManifest(pos[0], { slug: opt('--slug'), entity: opt('--entity'), pick: opt('--pick').split(',').filter(Boolean), hero: opt('--hero'), out: opt('--out'), host: opt('--host') || HOST, titles });
      if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else {
        for (const x of r.images) console.log(`${x.id.padEnd(4)} ${x.format}${x.converted ? '->jpg' : ''}  ${x.name}  "${x.title}"`);
        if (r.hero) console.log(`hero: ${r.hero.file} (${r.hero.width}x${r.hero.height}${r.hero.cropped ? ', Stock strip cropped' : ''})`);
        r.warnings.forEach((w) => console.log('warning: ' + w));
        console.log(`wrote ${r.manifest} (${r.count} images)`);
      }
      process.exitCode = r.fallbacks ? 2 : 0;
    } catch (e) { console.error('error:', e.message || e); process.exitCode = 1; }
  }
}
