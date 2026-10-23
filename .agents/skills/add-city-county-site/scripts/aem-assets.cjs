#!/usr/bin/env node
// aem-assets.cjs — create /content/dam/<parent>/<slug>/ on an AEM as a Cloud Service
// author and upload the picked tenant images with searchable metadata.
//
// Auth: the browser's existing AEM author login (SLICC's fetch carries the session
// cookie). Log in to the author in the leader browser before running. No MCP needed.
//
// Flow (all verified on 129103/1259846, Oct 22 2026):
//   1. CSRF token  -> 2. create folders (Assets HTTP API, 409 = already exists)
//   3. direct binary upload per file: <folder>.initiateUpload.json -> PUT blob URI(s) -> completeURI
//   4. WAIT for dam:assetState=processed (~2 min). Metadata written while processing is
//      silently WIPED by extraction even though the write returns 200.
//   5. Sling POST dc:* to <asset>/jcr:content/metadata, then re-read to verify.
//
// Usage: node aem-assets.cjs <manifest.json>
// manifest: { "host": "https://author-pX-eY.adobeaemcloud.com", "parent": "city-county",
//   "parentTitle": "City-County Demo", "slug": "boise-id", "entity": "Boise, Idaho",
//   "images": [ { "file": "/tmp/x/c01.jpg", "name": "boise-id-skyline.jpg",
//     "title": "...", "description": "...", "keywords": ["..."],
//     "source": "<original url>", "creator": "...", "rights": "..." } ] }
const fs = require('fs');
const { isMain } = require('./lib.cjs');

async function f(url, opts = {}, ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, ...opts }); } finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mimeOf = (n) => (/\.png$/i.test(n) ? 'image/png' : /\.webp$/i.test(n) ? 'image/webp' : 'image/jpeg');

async function csrfToken(H) {
  const r = await f(H + '/libs/granite/csrf/token.json', {}, 20000);
  const j = r.ok ? await r.json().catch(() => ({})) : {};
  if (!j.token) throw new Error(`no CSRF token (HTTP ${r.status}) — log in to ${H} in the leader browser, then retry`);
  return j.token;
}

async function ensureFolder(H, csrf, apiPath, title) {
  const r = await f(H + apiPath, { method: 'POST', headers: { 'CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ class: 'assetFolder', properties: { 'jcr:title': title } }) });
  if (r.status === 201) return 'created';
  if (r.status === 409) return 'exists';
  throw new Error(`folder ${apiPath}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function uploadBinary(H, csrf, damFolder, file, name) {
  const bin = fs.readFileSync(file); const mime = mimeOf(name);
  const init = await f(`${H}${damFolder}.initiateUpload.json`, { method: 'POST', headers: { 'CSRF-Token': csrf, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ fileName: name, fileSize: String(bin.length) }).toString() });
  if (!init.ok) throw new Error(`initiateUpload ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const ij = await init.json(); const fi = ij.files[0];
  let part = Math.ceil(bin.length / fi.uploadURIs.length);
  if (part > fi.maxPartSize) throw new Error('file too large for issued URIs');
  if (part < fi.minPartSize && fi.uploadURIs.length > 1) part = fi.minPartSize;
  let off = 0;
  for (const u of fi.uploadURIs) {
    if (off >= bin.length) break;
    const chunk = bin.subarray(off, Math.min(off + part, bin.length));
    const r = await f(u, { method: 'PUT', body: chunk, headers: { 'Content-Type': mime } }, 120000);
    if (!r.ok) throw new Error(`PUT part ${r.status}`);
    off += chunk.length;
  }
  const done = await f(H + ij.completeURI, { method: 'POST', headers: { 'CSRF-Token': csrf, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ fileName: name, mimeType: mime, uploadToken: fi.uploadToken, fileSize: String(bin.length) }).toString() });
  if (!done.ok) throw new Error(`completeUpload ${done.status}: ${(await done.text()).slice(0, 200)}`);
  return bin.length;
}

async function waitProcessed(H, assetPath, maxMs = 300000) {
  const t0 = Date.now(); let state = 'unknown';
  while (Date.now() - t0 < maxMs) {
    const r = await f(`${H}${assetPath}/jcr:content.json?t=${Date.now()}`, {}, 20000);
    if (r.ok) { state = (await r.json())['dam:assetState'] || 'unknown'; if (state === 'processed') return state; }
    await sleep(10000);
  }
  return state;
}

async function setMetadata(H, csrf, assetPath, meta) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) { v.forEach((x) => body.append(k, x)); body.append(k + '@TypeHint', 'String[]'); } else body.append(k, v);
  }
  const r = await f(`${H}${assetPath}/jcr:content/metadata`, { method: 'POST', headers: { 'CSRF-Token': csrf }, body });
  if (!r.ok) throw new Error(`metadata POST ${r.status}`);
  const back = await (await f(`${H}${assetPath}/jcr:content/metadata.json?v=${Date.now()}`)).json();
  return Object.keys(meta).filter((k) => meta[k] != null && meta[k] !== '' && back[k] === undefined);
}

async function uploadTenantImages(m) {
  const H = m.host.replace(/\/$/, '');
  const parent = m.parent || 'city-county';
  const dam = `/content/dam/${parent}/${m.slug}`;
  const csrf = await csrfToken(H);
  const folders = {
    parent: await ensureFolder(H, csrf, `/api/assets/${parent}`, m.parentTitle || 'City-County Demo'),
    tenant: await ensureFolder(H, csrf, `/api/assets/${parent}/${m.slug}`, m.entity),
  };
  // Upload all in parallel so the ~2 min processing overlaps.
  const results = await Promise.all(m.images.map(async (img) => {
    const path = `${dam}/${img.name}`;
    try { return { name: img.name, path, bytes: await uploadBinary(H, csrf, dam, img.file, img.name), img }; }
    catch (e) { return { name: img.name, path, error: String(e.message || e), img }; }
  }));
  // Then wait + metadata + verify, also in parallel.
  await Promise.all(results.filter((r) => !r.error).map(async (r) => {
    r.state = await waitProcessed(H, r.path);
    const meta = {
      'dc:title': r.img.title, 'dc:description': r.img.description,
      'dc:subject': [...new Set([...(r.img.keywords || []), m.entity, m.entity.split(',')[0], 'city-county-demo'])],
      'dc:source': r.img.source, 'dc:creator': r.img.creator ? [r.img.creator] : undefined, 'dc:rights': r.img.rights,
    };
    try { r.missingMetadata = await setMetadata(H, await csrfToken(H), r.path, meta); }
    catch (e) { r.error = String(e.message || e); }
  }));
  // Search check: the entity's short name should find every uploaded asset.
  const q = encodeURIComponent(m.entity.split(',')[0]);
  const hits = await (await f(`${H}/bin/querybuilder.json?path=${dam}&type=dam:Asset&fulltext=${q}&p.limit=50`)).json().catch(() => ({ total: -1 }));
  return {
    folder: dam, folders, searchTerm: m.entity.split(',')[0], searchHits: hits.total,
    assetsUrl: `${H}/ui#/aem/assets.html${dam}`,
    assets: results.map(({ img, ...r }) => r),
    ok: results.every((r) => !r.error && r.state === 'processed' && !(r.missingMetadata || []).length) && hits.total >= results.length,
  };
}

module.exports = { uploadTenantImages };

if (isMain(module)) {
  const mf = process.argv[2];
  if (!mf) { console.error('usage: aem-assets.cjs <manifest.json>'); process.exitCode = 1; }
  else uploadTenantImages(JSON.parse(fs.readFileSync(mf, 'utf8'))).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 2;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
