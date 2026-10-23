#!/usr/bin/env node
// clone-blueprint.cjs — Steps 3–4 of add-city-county-site as one deterministic step:
// copy /blueprint -> /sites/<slug> in DA (docs AND binaries, including the dot-folders
// the DA list API hides), apply every Step 4 rewrite in JS, PUT in parallel, then
// re-list and re-read the tenant and run the Step 4 verify checks. Never previews or
// publishes; the caller batches previews from `previewPaths` in the --json output.
//
// Usage: node clone-blueprint.cjs --slug <slug> --entity "<Display Name>"
//          [--address "<real street address>"] [--tagline "<localized hero line>"] [--keep-examples] [--force]
//          [--dry-run] [--json] [--token <ims>] [--concurrency 8]
// Token: $DA_TOKEN or --token   (TOKEN=$(oauth-token adobe | tr -d '[:space:]'))
// Exit:  0 = cloned and every check passed, 1 = error or a check failed,
//        2 = refused (tenant not empty; use --force), 64 = bad usage.
// Lives next to lib.cjs in the skill's scripts/ folder. The inline fallback (same code)
// only exists so the file also runs standalone, e.g. from /shared/cc-build/clone/.
let lib;
try { lib = require('./lib.cjs'); } catch (e) {
  const path = require('path');
  const UA_BOT = 'SLICC-city-county-demo/1.0 (https://github.com/adobe-pubsec/city-county)';
  lib = {
    async fetchT(url, opts = {}, ms = 15000) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms);
      try { return await fetch(url, { redirect: 'follow', signal: ctl.signal, ...opts, headers: { 'User-Agent': UA_BOT, ...(opts.headers || {}) } }); } finally { clearTimeout(t); }
    },
    isMain: (mod) => !!process.argv[1] && path.resolve(process.argv[1]) === mod.filename,
    slugify: (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, ''),
  };
}
const { fetchT, isMain, slugify } = lib;

const ORG = 'adobe-pubsec';
const REPO = 'city-county';
const SRC = 'blueprint';
const ADMIN = 'https://admin.da.live';
const CANON = `https://main--${REPO}--${ORG}.aem.live`;
const CANON_HOSTS = new Set([`main--${REPO}--${ORG}.aem.live`, `main--${REPO}--${ORG}.aem.page`]);
const CDA = `content.da.live/${ORG}/${REPO}/`;

const MIME = {
  html: 'text/html', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp4: 'video/mp4', ico: 'image/x-icon', woff2: 'font/woff2', txt: 'text/plain',
};
const TEXT_EXT = new Set(['html', 'json']);
const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

// Correct endonyms for the language picker (fragments/nav/header/languages.html). The
// blueprint copy holds each code point truncated to its low byte (e.g. "ñ" survived,
// "日" became 0xE5), so the names are rebuilt from the href language code.
const LANG_NATIVE = {
  en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', hi: 'हिन्दी', ja: '日本語', zh: '中文',
  ko: '한국어', vi: 'Tiếng Việt', ar: 'العربية', ru: 'Русский', pt: 'Português', it: 'Italiano',
  tl: 'Tagalog', pl: 'Polski', ht: 'Kreyòl Ayisyen', fa: 'فارسی', ur: 'اردو', bn: 'বাংলা',
  pa: 'ਪੰਜਾਬੀ', gu: 'ગુજરાતી', ta: 'தமிழ்', te: 'తెలుగు', so: 'Soomaali', am: 'አማርኛ',
  uk: 'Українська', el: 'Ελληνικά', he: 'עברית', th: 'ไทย', km: 'ភាសាខ្មែរ', hmn: 'Hmoob',
  'zh-hant': '繁體中文', 'zh-hans': '简体中文', 'zh-tw': '繁體中文', 'zh-cn': '简体中文',
};

// ---------------------------------------------------------------- small utils
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const count = (s, re) => (s.match(re) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

class DAError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

function makeDA(token, { timeout = 20000 } = {}) {
  const auth = { Authorization: `Bearer ${token}` };
  const url = (kind, p) => `${ADMIN}/${kind}/${ORG}/${REPO}/${p.replace(/^\/+/, '')}`;
  const authHint = (r) => (r.status === 401 || r.status === 403
    ? ` (token rejected — refresh: TOKEN=$(oauth-token adobe | tr -d '[:space:]'))` : '');

  // retry once on network error / timeout / 5xx / 429 — a live demo must not die on one blip
  async function call(method, u, opts = {}, ms = timeout) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchT(u, { method, ...opts, headers: { ...auth, ...(opts.headers || {}) } }, ms);
        if ((r.status >= 500 || r.status === 429) && attempt === 0) { last = new DAError(`${method} ${u} -> ${r.status}`, r.status); await sleep(400); continue; }
        return r;
      } catch (e) { last = e; if (attempt === 0) await sleep(400); }
    }
    throw last;
  }

  return {
    // folder listing; [] for an empty/missing folder. Follows da-continuation-token paging.
    async list(p) {
      const all = [];
      let cont = null;
      for (let page = 0; page < 50; page++) {
        const r = await call('GET', url('list', p), cont ? { headers: { 'da-continuation-token': cont } } : {});
        if (r.status === 404) return all;
        if (!r.ok) throw new DAError(`list ${p} -> ${r.status}${authHint(r)}`, r.status);
        const j = await r.json();
        all.push(...(Array.isArray(j) ? j : j.items || []));
        cont = r.headers.get('da-continuation-token');
        if (!cont) break;
      }
      return all;
    },
    async get(p) { // -> Uint8Array | null (404)
      const r = await call('GET', url('source', p), {}, 60000);
      if (r.status === 404) return null;
      if (!r.ok) throw new DAError(`GET ${p} -> ${r.status}${authHint(r)}`, r.status);
      return new Uint8Array(await r.arrayBuffer());
    },
    async put(p, bytes, type) {
      const fd = new FormData();
      fd.append('data', new Blob([bytes], { type }), p.split('/').pop());
      const r = await call('PUT', url('source', p), { body: fd }, 60000);
      if (!r.ok) throw new DAError(`PUT ${p} -> ${r.status}${authHint(r)}`, r.status);
      return r.status;
    },
  };
}

// recursive walk; returns { files: [{path, ext}], folders: [path] } relative to repo root
async function walk(da, root) {
  const files = [], folders = [];
  let level = [root];
  while (level.length) {
    folders.push(...level);
    const lists = await Promise.all(level.map((f) => da.list(f)));
    const next = [];
    lists.forEach((items) => {
      for (const it of items) {
        const rel = it.path.replace(`/${ORG}/${REPO}/`, '');
        if (it.ext) files.push({ path: rel, ext: String(it.ext).toLowerCase() });
        else next.push(rel);
      }
    });
    level = next;
  }
  return { files, folders };
}

// Dot-folders are invisible in parent listings, so derive them: .<docname>/ for every
// document, plus the known ones. Each found dot-folder is walked (it may nest).
async function discoverDotFolders(da, base, docPaths) {
  const probes = new Set([`${base}/.index`, `${base}/fragments/nav/.header`]);
  for (const d of docPaths) {
    const m = d.match(/^(.*)\/([^/]+)\.(html|json)$/);
    if (m) probes.add(`${m[1]}/.${m[2]}`);
  }
  const res = await Promise.all([...probes].map(async (p) => ({ p, w: await walk(da, p) })));
  const files = [];
  const found = [];
  for (const { p, w } of res) if (w.files.length) { found.push(p); files.push(...w.files); }
  return { probed: [...probes], found, files };
}

// ---------------------------------------------------------------- decoding
function decodeText(bytes) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), utf8: true }; } catch (e) {
    let s = ''; // raw byte -> U+00xx (NOT windows-1252, which would remap 0x80–0x9F)
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return { text: s, utf8: false };
  }
}

// ---------------------------------------------------------------- metadata / classification
function readMetadata(html) {
  const meta = {};
  const at = html.search(/<div class="metadata">/);
  const src = at < 0 ? '' : html.slice(at); // page metadata is the last block on the page
  const re = /<div><div>(?:<p>)?([\s\S]*?)(?:<\/p>)?<\/div><div>(?:<p>)?([\s\S]*?)(?:<\/p>)?<\/div><\/div>/g;
  let m;
  while ((m = re.exec(src))) meta[m[1].replace(/<[^>]+>/g, '').trim().toLowerCase()] = m[2].replace(/<[^>]+>/g, '').trim();
  return meta;
}
function articleKind(relPath, html) {
  if (!/\/(news|events)\/[^/]+\.html$/.test(relPath)) return null;
  const meta = readMetadata(html);
  const tpl = (meta.template || '').toLowerCase();
  if (tpl === 'news-article' || 'publication-date' in meta) return 'news-article';
  if (tpl === 'event-detail' || 'start-date' in meta) return 'event-detail';
  return null; // listing/index page in news/ or events/ — always copied
}

// ---------------------------------------------------------------- rewrites
const C0 = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const HOST_URL = /https?:\/\/([a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.(?:aem|hlx)\.(?:live|page))(\/[^"'\s<>)]*)?/gi;

function fixLanguages(html, notes) {
  let n = 0;
  const out = html.replace(/(<a href="\/([a-z]{2,3}(?:-[a-z]{2,4})?)\/?"[^>]*>)([^<]*)(<\/a>)/gi, (all, open, code, label, close) => {
    const native = LANG_NATIVE[code.toLowerCase()];
    if (!native) { notes.push(`languages: no endonym for "${code}", label left as-is`); return all; }
    // split "<native> <sep> <English>"; the separator is a dash (–, —, 0x13/0x14) or "-"
    const m = label.match(/^(.*?)\s*(?:[\u2013\u2014\x13\x14]|\s-\s)\s*([A-Za-z][A-Za-z ()]*)$/);
    const english = m ? m[2].trim() : null;
    const want = english && english !== native ? `${native} — ${english}` : native;
    if (want !== label) n++;
    return open + want + close;
  });
  return { out, fixed: n };
}

function rewriteText(relSrc, raw, opt, stats, warnings) {
  const { slug, entity, address, tagline, isJson } = opt;
  const base = `sites/${slug}`;
  const enc = isJson ? (s) => JSON.stringify(String(s)).slice(1, -1) : htmlEsc;
  const dec = decodeText(raw);
  let t = dec.text;
  const tally = (k, n) => { if (n) stats[k] = (stats[k] || 0) + n; };

  // 1. language names (mojibake) — before control-char cleanup, which would eat the separators
  if (/\/languages\.html$/.test(relSrc)) {
    const notes = [];
    const r = fixLanguages(t, notes);
    t = r.out; tally('languageNames', r.fixed); warnings.push(...notes);
  } else if (!dec.utf8) {
    warnings.push(`${relSrc}: not valid UTF-8; decoded byte-wise, check non-ASCII text`);
  }
  // 2. control characters: 0x13 -> en dash, 0x14 -> em dash, CRLF -> LF, other C0 removed
  tally('controlChars', count(t, C0));
  t = t.replace(/\x13/g, '–').replace(/\x14/g, '—').replace(/\r\n?/g, '\n').replace(C0, '');
  // 3. chrome-extension://<id>/<path> -> /<path>
  tally('chromeExtension', count(t, /chrome-extension:\/\/[a-z]+/gi));
  t = t.replace(/chrome-extension:\/\/[a-z]+(\/[^"'\s<>]*)?/gi, (m, p) => p || '/');
  // 4. EDS hosts: media_* -> canonical absolute host; every other path -> root-relative link
  t = t.replace(HOST_URL, (m, host, p) => {
    const pathPart = p || '/';
    if (/^\/(?:[^?#"']*\/)?media_[0-9a-f]+/i.test(pathPart)) {
      if (m.startsWith(CANON + '/')) return m;
      tally('mediaToCanon', 1); return CANON + pathPart;
    }
    tally('hostLinkStripped', 1);
    return pathPart;
  });
  //    root-relative /media_ in src/srcset (any position in the attribute) -> canonical
  t = t.replace(/\b(src|srcset)=(["'])([^"']*)\2/gi, (m, attr, q, v) => `${attr}=${q}${v.replace(/(^|[\s,])\/media_/g, (x, sep) => { tally('mediaToCanon', 1); return `${sep}${CANON}/media_`; })}${q}`);
  // 5. /blueprint -> /sites/<slug>  (also rewrites content.da.live/.../blueprint/... refs)
  tally('blueprintPath', count(t, /\/blueprint(?![\w-])/g));
  t = t.replace(/\/blueprint(?![\w-])/g, `/${base}`);
  //    a bare tenant root link 404s without the trailing slash (skill Step 6b.7)
  t = t.replace(new RegExp(`href="/${esc(base)}"`, 'g'), () => { tally('homeTrailingSlash', 1); return `href="/${base}/"`; });
  // 6. entity, longest first
  tally('entityGovernment', count(t, /City County Government/g));
  t = t.replace(/City County Government/g, enc(`${entity} Government`));
  tally('entity', count(t, /City County/g));
  t = t.replace(/City County/g, enc(entity));
  // 7. footer address
  // Blueprint (Oct 23+) uses an explicit {{ADDRESS}} placeholder; older copies have the fictional Thornwick address.
  const ADDR = /\{\{ADDRESS\}\}|Thornwick Municipal Center,[^<"]*?Fairhollow, West Calder 74920/g;
  if (count(t, ADDR)) {
    if (address) { tally('address', count(t, ADDR)); t = t.replace(ADDR, enc(address)); }
    else { tally('addressBlanked', count(t, ADDR)); t = t.replace(ADDR, enc(entity)); warnings.push(`${relSrc}: no --address; address line set to the entity name (pass --address "<street, city, ST zip>")`); }
  }
  // 7b. localized hero tagline: replaces the <em> half of the homepage H1 ("…: <em>Connecting You To Your Local Government</em>")
  if (tagline && /(^|\/)index\.html$/.test(relSrc)) {
    const H1 = /(<h1>[^<]*<em>)Connecting You To Your Local Government(<\/em>)/;
    if (H1.test(t)) { tally('tagline', 1); t = t.replace(H1, (m, a, b) => a + enc(tagline) + b); }
    else warnings.push(`${relSrc}: --tagline given but the hero H1 pattern was not found; left unchanged`);
  }
  // 8. warn on content.da.live refs that point at another tenant/org (left as-is)
  const seen = new Set();
  for (const m of t.matchAll(/https?:\/\/content\.da\.live\/[^"'\s<>]+/g)) {
    if (m[0].includes(`${CDA}${base}/`) || seen.has(m[0])) continue;
    seen.add(m[0]);
    let u = m[0]; try { u = decodeURI(u); } catch (e) { /* keep raw */ }
    const shared = m[0].includes(`${CDA}.index/`);
    const kind = shared ? 'shared-placeholder' : m[0].includes(CDA) ? 'other-tenant' : 'other-org';
    opt.refs.push({ doc: relSrc, url: u, kind });
    if (!shared) warnings.push(`${relSrc}: ${kind} image ref kept as-is: ${u}`);
  }
  for (const m of new Set((t.match(new RegExp(`href="/sites/(?!${esc(slug)}/)[a-z0-9-]+[^"]*"`, 'g')) || []))) warnings.push(`${relSrc}: link into another tenant: ${m}`);
  return t;
}

// ---------------------------------------------------------------- verify
function checkText(t, slug) {
  const hosts = (t.match(/[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.(?:aem|hlx)\.(?:live|page)/gi) || []).filter((h) => !CANON_HOSTS.has(h.toLowerCase()));
  return {
    blueprint: count(t, /\/blueprint(?![\w-])/g),
    foreignHost: hosts.length,
    rootRelativeMedia: count(t, /\b(?:src|srcset)=["'](?:[^"']*[\s,])?\/media_/gi),
    cityCounty: count(t, /City County/g),
    chromeExtension: count(t, /chrome-extension:\/\//gi),
    controlChars: count(t, C0) + count(t, /[\x80-\x9F]/g),
    replacementChar: count(t, /\uFFFD/g),
    placeholder: count(t, /\{\{[A-Z_]+\}\}/g),
  };
}
const sumChecks = (list) => list.reduce((a, c) => { for (const k of Object.keys(c)) a[k] = (a[k] || 0) + c[k]; return a; }, {});

// ---------------------------------------------------------------- main
async function cloneBlueprint(o) {
  const t0 = Date.now();
  const slug = o.slug && slugify(o.slug);
  if (!slug || slug !== o.slug) throw new DAError(`invalid slug "${o.slug}" (lowercase a-z0-9-, e.g. "${slug || 'wake-county'}")`, 64);
  if (!o.entity || !o.entity.trim()) throw new DAError('--entity is required', 64);
  if (/City County/.test(o.entity)) throw new DAError('--entity must not contain the placeholder "City County"', 64);
  if (!o.token) throw new DAError('no token: set DA_TOKEN or pass --token (TOKEN=$(oauth-token adobe | tr -d \'[:space:]\'))', 64);
  const conc = o.concurrency || 8;
  const da = makeDA(o.token);
  const base = `sites/${slug}`;
  const toDst = (p) => base + p.slice(SRC.length);
  const warnings = [];
  const stats = {};
  const timing = {};
  const lap = (k) => { timing[k] = Date.now() - t0; };

  // 1. refuse-to-overwrite pre-check (parallel with the blueprint walk)
  const [existing, existingIdx, existingHdr, bp] = await Promise.all([
    da.list(base), da.list(`${base}/.index`), da.list(`${base}/fragments/nav/.header`), walk(da, SRC),
  ]);
  const occupied = existing.length + existingIdx.length + existingHdr.length;
  if (occupied && !o.force) {
    const e = new DAError(`/${base} already has content (${occupied} entries: ${existing.map((x) => x.name).join(', ')}); refusing to overwrite. Use --force to overwrite.`, 2);
    e.refused = true; throw e;
  }
  if (occupied) warnings.push(`--force: overwriting into non-empty /${base}`);
  lap('listed');

  // 2. dot-folders + fetch docs
  const docs = bp.files.filter((f) => TEXT_EXT.has(f.ext));
  const plainBins = bp.files.filter((f) => !TEXT_EXT.has(f.ext));
  const [dot, docBytes] = await Promise.all([
    discoverDotFolders(da, SRC, docs.map((d) => d.path)),
    pool(docs, conc * 2, (d) => da.get(d.path)),
  ]);
  lap('fetchedDocs');

  // 3. classify docs; skip example articles unless --keep-examples
  const docInfo = docs.map((d, i) => {
    const bytes = docBytes[i];
    const html = bytes ? decodeText(bytes).text : '';
    return { ...d, bytes, html, kind: d.ext === 'html' ? articleKind(d.path, html) : null };
  });
  const skipped = [];
  const copyDocs = docInfo.filter((d) => {
    if (!d.bytes) { warnings.push(`${d.path}: listed but GET returned 404`); return false; }
    if (d.kind && !o.keepExamples) { skipped.push({ path: d.path, reason: `example ${d.kind}` }); return false; }
    return true;
  });
  const skippedDocs = new Set(skipped.map((s) => s.path));
  const ownerDoc = (binPath) => { // "x/.name/a.png" -> "x/name.html"
    const m = binPath.match(/^(.*)\/\.([^/]+)\/.+$/); return m ? `${m[1]}/${m[2]}.html` : null;
  };

  // 4. binaries: listed + dot-folder files, minus those owned by skipped articles; then refs
  const binSet = new Map();
  for (const f of [...plainBins, ...dot.files]) {
    const owner = ownerDoc(f.path);
    if (owner && skippedDocs.has(owner)) { skipped.push({ path: f.path, reason: `media of skipped ${owner}` }); continue; }
    binSet.set(f.path, f.ext);
  }
  const refRe = new RegExp(`https?://${esc(CDA)}(${SRC}/[^"'\\s<>)?#]+)`, 'g');
  const referenced = new Map(); // path -> [docs]
  for (const d of copyDocs) for (const m of d.html.matchAll(refRe)) {
    let p; try { p = decodeURI(m[1]); } catch (e) { p = m[1]; }
    if (!referenced.has(p)) referenced.set(p, []);
    if (!referenced.get(p).includes(d.path)) referenced.get(p).push(d.path);
  }
  const missing = [];
  const refOnly = [...referenced.keys()].filter((p) => !binSet.has(p) && !copyDocs.some((d) => d.path === p));
  const refOnlyBytes = await pool(refOnly, conc * 2, (p) => da.get(p).catch(() => null));
  refOnly.forEach((p, i) => {
    if (refOnlyBytes[i]) { binSet.set(p, extOf(p)); warnings.push(`${p}: found only via a content reference (not in any listing); copied`); }
    else missing.push({ path: p, referencedBy: referenced.get(p) });
  });
  const bins = [...binSet.keys()].map((p) => ({ path: p, ext: binSet.get(p) || extOf(p) }));
  const preFetched = new Map(refOnly.map((p, i) => [p, refOnlyBytes[i]]).filter(([, b]) => b));
  lap('discovered');

  // 5. rewrite text
  const refs = [];
  const outputs = copyDocs.map((d) => {
    const isJson = d.ext === 'json';
    const text = rewriteText(d.path, d.bytes, { slug, entity: o.entity.trim(), address: o.address && o.address.trim(), tagline: o.tagline && o.tagline.trim(), isJson, refs }, stats, warnings);
    return { src: d.path, dst: toDst(d.path), type: MIME[d.ext], text, bytes: new TextEncoder().encode(text) };
  });
  for (const x of outputs) for (const s of skipped.filter((k) => k.reason.startsWith('example'))) {
    const target = '/' + toDst(s.path).replace(/\.html$/, '');
    if (new RegExp(`href="${esc(target)}(?:\\.html)?/?"`).test(x.text)) warnings.push(`${x.dst}: links to skipped example ${target} (dead until news/events are written)`);
  }
  const preChecks = outputs.map((x) => ({ path: x.dst, ...checkText(x.text, slug) }));
  if (!o.address) warnings.unshift('no --address: footer address line shows the entity name only');

  const plan = {
    docs: outputs.map((x) => x.dst),
    binaries: bins.map((b) => toDst(b.path)),
  };

  // 6. write (unless dry run)
  const written = [];
  const failures = [];
  let verify = null;
  if (!o.dryRun) {
    const jobs = [
      ...bins.map((b) => ({ dst: toDst(b.path), type: MIME[b.ext] || 'application/octet-stream', load: async () => preFetched.get(b.path) || da.get(b.path), binary: true, src: b.path })),
      ...outputs.map((x) => ({ dst: x.dst, type: x.type, load: async () => x.bytes, binary: false, src: x.src })),
    ];
    const results = await pool(jobs, conc, async (j) => {
      try {
        const bytes = await j.load();
        if (!bytes) throw new Error(`source ${j.src} vanished`);
        const st = await da.put(j.dst, bytes, j.type);
        return { ...j, status: st, size: bytes.length };
      } catch (e) { return { ...j, error: e.message }; }
    });
    for (const r of results) (r.error ? failures : written).push(r);
    lap('written');

    // 7. verify: re-list (+ dot-folder probes), re-read every doc, size-check binaries
    const tree = await walk(da, base);
    const tdot = await discoverDotFolders(da, base, tree.files.filter((f) => TEXT_EXT.has(f.ext)).map((f) => f.path));
    const listed = new Set([...tree.files, ...tdot.files].map((f) => f.path));
    const expected = new Set(jobs.map((j) => j.dst));
    const notListed = [...expected].filter((p) => !listed.has(p));
    const unexpected = [...listed].filter((p) => !expected.has(p));
    const readBack = await pool(jobs, conc * 2, async (j) => {
      const b = await da.get(j.dst).catch(() => null);
      if (!b) return { path: j.dst, ok: false, error: 'not readable' };
      const w = written.find((x) => x.dst === j.dst);
      if (j.binary) return { path: j.dst, ok: !!w && b.length === w.size, size: b.length };
      const t = decodeText(b).text;
      const c = checkText(t, slug);
      const exp = outputs.find((x) => x.dst === j.dst);
      return { path: j.dst, ok: t === exp.text && Object.values(c).every((v) => v === 0), identical: t === exp.text, checks: c };
    });
    const textChecks = sumChecks(readBack.filter((r) => r.checks).map((r) => r.checks));
    verify = {
      listedCount: listed.size, expectedCount: expected.size, notListed, unexpected,
      readBackFailures: readBack.filter((r) => !r.ok),
      checks: textChecks,
      ok: !failures.length && !notListed.length && readBack.every((r) => r.ok) && Object.values(textChecks).every((v) => v === 0),
    };
    if (unexpected.length) warnings.push(`tenant has ${unexpected.length} entries this run did not write (pre-existing with --force?): ${unexpected.join(', ')}`);
    lap('verified');
  }

  const pre = sumChecks(preChecks.map(({ path, ...c }) => c));
  const preOk = Object.values(pre).every((v) => v === 0);
  const ok = o.dryRun ? preOk && !missing.length : !!verify?.ok && !missing.length;
  const writtenPaths = written.map((w) => w.dst).sort();
  return {
    ok, dryRun: !!o.dryRun, org: ORG, repo: REPO, slug, entity: o.entity.trim(), tenant: `/${base}`,
    durationMs: Date.now() - t0, timing,
    source: { docs: docs.length, binaries: plainBins.length + dot.files.length, dotFoldersProbed: dot.probed.length, dotFoldersFound: dot.found },
    plan, skipped, missing,
    written: writtenPaths,
    writtenDocs: written.filter((w) => !w.binary).map((w) => w.dst).sort(),
    writtenBinaries: written.filter((w) => w.binary).map((w) => w.dst).sort(),
    previewPaths: (o.dryRun ? plan.docs : written.filter((w) => !w.binary).map((w) => w.dst)).map((p) => p.replace(/\.html$/, '')).sort(),
    failures: failures.map((f) => ({ path: f.dst, error: f.error })),
    rewrites: stats, externalImageRefs: refs, preChecks: pre, verify,
    warnings: [...new Set(warnings)],
  };
}

module.exports = { cloneBlueprint, rewriteText, checkText, articleKind, fixLanguages };

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const o = { keepExamples: false, dryRun: false, json: false, force: false };
  const flags = { '--keep-examples': 'keepExamples', '--dry-run': 'dryRun', '--json': 'json', '--force': 'force' };
  const vals = { '--slug': 'slug', '--entity': 'entity', '--address': 'address', '--tagline': 'tagline', '--token': 'token', '--concurrency': 'concurrency' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (flags[k]) o[flags[k]] = true;
    else if (vals[k]) o[vals[k]] = inline !== undefined ? inline : argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new DAError(`unknown argument ${a}`, 64);
  }
  if (o.concurrency) o.concurrency = Math.max(1, parseInt(o.concurrency, 10) || 8);
  o.token = (o.token || process.env.DA_TOKEN || '').trim();
  return o;
}

function printHuman(r) {
  const L = (s) => console.log(s);
  L(`${r.dryRun ? 'DRY RUN — nothing written. ' : ''}/blueprint -> ${r.tenant}  (${r.entity})  ${(r.durationMs / 1000).toFixed(1)}s`);
  L(`source:   ${r.source.docs} docs, ${r.source.binaries} binaries; dot-folders found: ${r.source.dotFoldersFound.join(', ') || '-'}`);
  L(`${r.dryRun ? 'would write' : 'written'}:  ${r.dryRun ? r.plan.docs.length + ' docs, ' + r.plan.binaries.length + ' binaries' : r.writtenDocs.length + ' docs, ' + r.writtenBinaries.length + ' binaries'}`);
  if (r.skipped.length) L(`skipped:  ${r.skipped.length} (${r.skipped.filter((s) => s.reason.startsWith('example')).length} example articles + their media; --keep-examples to copy)`);
  L(`rewrites: ${Object.entries(r.rewrites).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`);
  const c = r.verify ? r.verify.checks : r.preChecks;
  L(`checks${r.verify ? ' (read back)' : ' (in memory)'}: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (r.verify) L(`listing:  ${r.verify.listedCount} listed / ${r.verify.expectedCount} expected${r.verify.notListed.length ? '; MISSING: ' + r.verify.notListed.join(', ') : ''}`);
  for (const f of r.failures) L(`FAIL      ${f.path}: ${f.error}`);
  if (r.verify) for (const f of r.verify.readBackFailures) L(`FAIL read ${f.path}: ${f.error || JSON.stringify(f.checks || { size: f.size })}`);
  for (const m of r.missing) L(`MISSING   ${m.path} (referenced by ${m.referencedBy.join(', ')})`);
  for (const w of r.warnings) L(`warn      ${w}`);
  L(r.ok ? 'OK' : 'FAILED');
}

if (isMain(module)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 64; }
  if (o && (o.help || !o.slug || !o.entity)) {
    console.error('usage: node clone-blueprint.cjs --slug <slug> --entity "<Display Name>" [--address "<street address>"] [--keep-examples] [--force] [--dry-run] [--json] [--token <ims>]');
    process.exitCode = o.help ? 0 : 64;
  } else if (o) {
    cloneBlueprint(o).then((r) => {
      if (o.json) console.log(JSON.stringify(r, null, 2)); else printHuman(r);
      process.exitCode = r.ok ? 0 : 1;
    }).catch((e) => {
      const code = e.status === 2 || e.status === 64 ? e.status : 1;
      if (o.json) console.log(JSON.stringify({ ok: false, refused: !!e.refused, error: e.message, exitCode: code }, null, 2));
      else console.error(`${e.refused ? 'REFUSED' : 'error'}: ${e.message}`);
      process.exitCode = code;
    });
  }
}
