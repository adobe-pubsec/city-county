#!/usr/bin/env node
// remove-site.cjs — remove ONE city-county tenant and every trace of it, in two phases.
//
//   1. PLAN (read-only):  node remove-site.cjs <slug> [--json]
//      Inventories everything the tenant owns, prints exactly what will be removed, saves the plan
//      to /tmp/remove-<slug>-plan.json and prints a one-time CONFIRMATION PHRASE. Nothing changes.
//   2. EXECUTE:           node remove-site.cjs <slug> --execute --confirm "<phrase the requester typed>"
//      Only runs with the exact phrase from a plan less than 30 minutes old, and only if the tenant
//      has not gained new files since. Backs up first, then removes, then verifies.
//
// What it removes, in order: live (aem.live) pages -> preview (aem.page) pages -> every DA file
// and folder under /sites/<slug> (including hidden dot-folders the DA list API omits) -> the
// tenant's row in the shared /metadata.json (re-checked against concurrent writers, then the sheet
// is re-published) -> the AEM Assets folder /content/dam/city-county/<slug> (when an AEM author
// session is available). The news/events indexes drop the tenant's rows as a side effect.
//
// AEM: the plan step REFUSES (exit 4) if the AEM author session can't be checked (not logged in, hibernated),
// so the AEM Assets folder is never left behind. There is no override.
// Exit: 0 = plan written / removal verified; 1 = failed or not fully verified; 3 = refused; 4 = AEM not checkable; 64 = usage.
const fs = require('fs'); const pathMod = require('path');
const { fetchT, isMain } = require('./lib.cjs');
const { registerTenant } = require('./register-tenant.cjs');

const ORG = 'adobe-pubsec'; const REPO = 'city-county';
const DA = `https://admin.da.live`; const ADMIN = `https://admin.hlx.page`;
const PAGE = `https://main--${REPO}--${ORG}.aem.page`; const LIVE = `https://main--${REPO}--${ORG}.aem.live`;
const AEM = 'https://author-p129103-e1259846.adobeaemcloud.com';
const PROTECTED = new Set(['blueprint']);          // never removable
const SHOWCASE = new Set(['raleigh', 'new-haven']); // polished demo tenants: need --allow-showcase
const PLAN_TTL_MS = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const planFile = (slug) => `/tmp/remove-${slug}-plan.json`;

async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const webPath = (p) => '/' + p.replace(/\.html$/, '').replace(/(^|\/)index$/, '$1');   // sites/x/index.html -> /sites/x/
const adminPath = (p) => p.replace(/\.html$/, '');                                       // sites/x/news/a.html -> sites/x/news/a

// ------------------------------------------------------------------ AEM Assets (browser session)
// state: 'present' | 'absent' | 'no-login' | 'hibernated' | 'error'. Only present/absent are "checked".
async function aemProbe(slug) {
  const aem = { host: AEM, folder: `/content/dam/city-county/${slug}`, state: 'error', assets: [], subfolders: [] };
  try {
    const u = await fetchT(`${AEM}/libs/granite/security/currentuser.json`, {}, 20000);
    const ut = await u.text();
    if (/hibernat/i.test(ut) || /devconsole/i.test(u.headers.get('x-backend') || '') || u.status === 503) { aem.state = 'hibernated'; aem.detail = 'AEM author is hibernated or starting'; return aem; }
    let id = null; try { id = JSON.parse(ut).authorizableId; } catch (e) { /* login page */ }
    if (!id || id === 'anonymous') { aem.state = 'no-login'; aem.detail = `not logged in to ${AEM} in this browser`; return aem; }
    aem.user = id;
    const r = await fetchT(`${AEM}/api/assets/city-county/${slug}.json`, {}, 20000);
    if (r.status === 404) { aem.state = 'absent'; return aem; }
    if (r.status !== 200) { aem.state = 'error'; aem.detail = `Assets API HTTP ${r.status}`; return aem; }
    const j = await r.json();
    aem.state = 'present';
    for (const e of j.entities || []) {
      const p = e.properties || {}; const cls = (e.class || []).join(',');
      if (/folder/.test(cls)) aem.subfolders.push(p.name); else aem.assets.push({ name: p.name, title: (p.metadata && p.metadata['dc:title']) || '' });
    }
  } catch (e) { aem.state = 'error'; aem.detail = e.name === 'AbortError' ? 'timeout' : e.message; }
  return aem;
}
const aemChecked = (a) => a.state === 'present' || a.state === 'absent';

// ------------------------------------------------------------------ inventory (read-only)
async function inventory(slug, token) {
  const auth = { Authorization: 'Bearer ' + token };
  const base = `sites/${slug}`;
  const files = new Set(); const folders = new Set([base]); const notes = [];
  const list = async (p) => {
    const r = await fetchT(`${DA}/list/${ORG}/${REPO}/${p}`, { headers: auth }, 20000);
    if (r.status === 404) return [];
    if (r.status !== 200) throw new Error(`DA list ${p} HTTP ${r.status}`);
    return r.json();
  };
  const walk = async (p) => {
    const items = await list(p);
    if (items.length) folders.add(p);
    await pool(items, 4, async (it) => { const rel = it.path.replace(`/${ORG}/${REPO}/`, ''); if (it.ext) files.add(rel); else { folders.add(rel); await walk(rel); } });
  };
  await walk(base);
  // DA hides dot-folders from /list: probe the known ones, each doc's ".<name>/" media folder,
  // and any /sites/<slug>/… folder referenced from content.da.live inside the docs.
  const probes = new Set([`${base}/.index`, `${base}/fragments/nav/.header`, `${base}/fragments/.header`]);
  for (const f of files) if (f.endsWith('.html')) probes.add(f.replace(/([^/]+)\.html$/, '.$1'));
  const htmlFiles = [...files].filter((f) => f.endsWith('.html'));
  await pool(htmlFiles, 4, async (f) => {
    const r = await fetchT(`${DA}/source/${ORG}/${REPO}/${f}`, { headers: auth }, 20000);
    if (r.status !== 200) return;
    const html = await r.text();
    const re = new RegExp(`content\\.da\\.live/${ORG}/${REPO}/(${base.replace('/', '\\/')}/[^"'\\s)?#]+)`, 'g');
    for (const m of html.matchAll(re)) { const p = decodeURIComponent(m[1]); probes.add(p.replace(/\/[^/]*$/, '')); }
  });
  const seen = new Set();
  const probeWalk = async (p) => { if (seen.has(p) || !p.startsWith(base)) return; seen.add(p); const items = await list(p); if (!items.length) return; folders.add(p); for (const it of items) { const rel = it.path.replace(`/${ORG}/${REPO}/`, ''); if (it.ext) files.add(rel); else { folders.add(rel); await probeWalk(rel); } } };
  for (const p of probes) await probeWalk(p);
  // parents of every file are folders too
  for (const f of files) { let d = pathMod.dirname(f); while (d.startsWith(base)) { folders.add(d); d = pathMod.dirname(d); } }

  // preview / live state of every page and sheet
  const docs = [...files].filter((f) => /\.(html|json)$/.test(f)).sort();
  const pages = await pool(docs, 4, async (f) => {
    const r = await fetchT(`${ADMIN}/status/${ORG}/${REPO}/main/${adminPath(f)}`, { headers: auth }, 20000);
    const j = r.status === 200 ? await r.json() : {};
    return { file: f, web: webPath(f), preview: j.preview ? j.preview.status : `HTTP ${r.status}`, live: j.live ? j.live.status : `HTTP ${r.status}`, by: (j.preview && j.preview.lastModifiedBy) || (j.live && j.live.lastModifiedBy) || null };
  });
  // shared sheet row(s)
  const mr = await fetchT(`${DA}/source/${ORG}/${REPO}/metadata.json?nc=${Date.now()}`, { headers: auth }, 20000);
  const meta = mr.status === 200 ? await mr.json() : null;
  const metaRows = meta && Array.isArray(meta.data) ? meta.data.filter((x) => x.url === `/${base}/**` || x['site-base'] === `/${base}`) : [];
  // index rows (informational; unpublish/unpreview removes them)
  const idx = {};
  for (const [host, h] of [['preview', PAGE], ['live', LIVE]]) for (const name of ['news-index', 'events-index']) {
    try { const r = await fetchT(`${h}/${name}.json?limit=2000&nc=${Date.now()}`, {}, 15000); const j = r.status === 200 ? await r.json() : { data: [] }; idx[`${host}/${name}`] = (j.data || []).filter((x) => String(x.path || '').startsWith(`/${base}/`)).length; } catch (e) { idx[`${host}/${name}`] = '?'; }
  }
  // AEM Assets folder (needs an AEM author login in this browser)
  const aem = await aemProbe(slug);
  // who is asking, who built it
  let me = null;
  try { const p = await (await fetchT('https://ims-na1.adobelogin.com/ims/profile/v1', { headers: auth }, 15000)).json(); me = p.email || null; } catch (e) { /* unknown */ }
  const owners = [...new Set(pages.map((p) => p.by).filter(Boolean))];
  return { slug, base, files: [...files].sort(), folders: [...folders].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? 1 : -1)), pages, metaRows, idx, aem, me, owners, notes };
}

function phraseFor(slug, nonce, others) { return `delete ${slug} ${nonce}${others ? ' including others work' : ''}`; }
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();

function describe(inv, plan) {
  const L = []; const p = (s = '') => L.push(s);
  const live = inv.pages.filter((x) => x.live === 200); const prev = inv.pages.filter((x) => x.preview === 200);
  const bins = inv.files.filter((f) => !/\.(html|json)$/.test(f));
  p(`REMOVAL PLAN for "${inv.slug}"  (nothing has been changed yet)`);
  p(`Site: ${PAGE}/${inv.base}/`);
  p(`Requested by: ${inv.me || 'unknown user'}${inv.owners.length ? `   Built/last edited by: ${inv.owners.join(', ')}` : ''}`);
  if (plan.others) p(`!! WARNING: parts of this site were last edited by someone other than you (${inv.owners.filter((o) => o !== inv.me).join(', ')}).`);
  if (SHOWCASE.has(inv.slug)) p(`!! WARNING: "${inv.slug}" is a showcase demo tenant.`);
  p('');
  p(`1. Unpublish ${live.length} page(s) from aem.live${live.length ? ':' : ''}`); live.forEach((x) => p(`     ${x.web}`));
  p(`2. Remove ${prev.length} page(s) from preview (aem.page)${prev.length ? ':' : ''}`); prev.forEach((x) => p(`     ${x.web}`));
  p(`3. Delete ${inv.files.length} file(s) in Document Authoring under /${inv.base}/ (${inv.files.length - bins.length} documents/sheets, ${bins.length} images/other), then ${inv.folders.length} folder(s):`);
  inv.files.forEach((f) => p(`     ${f.replace(inv.base + '/', '')}`));
  p(`4. Remove ${inv.metaRows.length} row(s) for /${inv.base}/** from the shared /metadata.json and re-publish it${inv.metaRows.length ? '' : ' (no row found: nothing to remove)'}`);
  if (inv.aem.state === 'present') { p(`5. Delete the AEM Assets folder ${inv.aem.folder} on ${inv.aem.host.replace('https://', '')} and its ${inv.aem.assets.length} image(s)${inv.aem.subfolders.length ? ` and ${inv.aem.subfolders.length} subfolder(s)` : ''}:`); inv.aem.assets.forEach((x) => p(`     ${x.name}${x.title ? `  (${x.title})` : ''}`)); inv.aem.subfolders.forEach((x) => p(`     ${x}/  (subfolder, with everything in it)`)); }
  else if (inv.aem.state === 'absent') p(`5. AEM Assets: checked, no folder ${inv.aem.folder} exists (nothing to delete)`);
  p(`6. Verify: every page 404 on preview and live, DA folder gone, no metadata row, no news/events index rows (now: ${Object.entries(inv.idx).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  p('');
  p(`A backup of every DA file, the metadata row${inv.aem.state === 'present' ? ', and every AEM image (original + metadata)' : ''} is saved first (in this SLICC, under /shared/city-county-removed/).`);
  p(`Cannot be removed (no API): image copies already cached by Edge Delivery under unlisted media_<hash> URLs, and copies other people saved.`);
  p('');
  p(`To proceed, the requester must TYPE this phrase exactly:   ${plan.phrase}`);
  p(`It expires at ${new Date(plan.expires).toLocaleTimeString()} (30 minutes).`);
  return L.join('\n');
}

async function makePlan(slug, opts) {
  const token = opts.token || process.env.DA_TOKEN;
  const inv = await inventory(slug, token);
  if (!aemChecked(inv.aem)) return { ok: false, refused: true, aemBlocked: true, reason: `the AEM Assets folder could not be checked: ${inv.aem.detail}. Log in to ${AEM} in this browser${inv.aem.state === 'hibernated' ? ' (after de-hibernating it in Cloud Manager)' : ''} and plan again. Removal always includes the AEM folder.` };
  const exists = inv.files.length || inv.metaRows.length || inv.aem.state === 'present';
  if (!exists) return { ok: false, refused: true, reason: `nothing found for "${slug}": no DA files under /sites/${slug}, no metadata row, no AEM folder${inv.aem.state.startsWith('not-checked') ? ' (AEM not checked)' : ''}` };
  const others = !!(inv.me && inv.owners.some((o) => o.toLowerCase() !== inv.me.toLowerCase()));
  const nonce = String(1000 + Math.floor(Math.random() * 9000));
  const plan = { slug, created: Date.now(), expires: Date.now() + PLAN_TTL_MS, phrase: phraseFor(slug, nonce, others), others, me: inv.me, inventory: inv };
  fs.writeFileSync(planFile(slug), JSON.stringify(plan, null, 1));
  return { ok: true, planFile: planFile(slug), phrase: plan.phrase, expires: new Date(plan.expires).toISOString(), others, text: describe(inv, plan), inventory: inv };
}

// ------------------------------------------------------------------ execute
async function execute(slug, opts) {
  const token = opts.token || process.env.DA_TOKEN; const auth = { Authorization: 'Bearer ' + token };
  const log = []; const t0 = Date.now(); const L = (s) => { const line = `${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`; log.push(line); if (!opts.json) console.log(line); };
  const res = { ok: false, slug, log };
  if (!fs.existsSync(planFile(slug))) return { ...res, refused: true, reason: `no plan for "${slug}": run the plan step first (node remove-site.cjs ${slug})` };
  const plan = JSON.parse(fs.readFileSync(planFile(slug), 'utf8'));
  if (plan.slug !== slug) return { ...res, refused: true, reason: 'plan is for a different site' };
  if (Date.now() > plan.expires) return { ...res, refused: true, reason: 'plan expired (30 min): run the plan step again and show the requester the new plan' };
  if (norm(opts.confirm) !== norm(plan.phrase)) return { ...res, refused: true, reason: `confirmation phrase does not match. The requester must type exactly: ${plan.phrase}` };
  // re-inventory: refuse if the site gained anything the requester was not shown
  const inv = await inventory(slug, token);
  const newFiles = inv.files.filter((f) => !plan.inventory.files.includes(f));
  const planNames = new Set((plan.inventory.aem.assets || []).map((x) => x.name));
  const newAem = inv.aem.state === 'present' && (plan.inventory.aem.state !== 'present' || inv.aem.assets.some((x) => !planNames.has(x.name)) || inv.aem.subfolders.length > (plan.inventory.aem.subfolders || []).length);
  if (!aemChecked(inv.aem)) return { ...res, refused: true, reason: `the AEM session was lost since the plan (${inv.aem.detail}): log in to AEM again and re-run --execute with the same phrase` };
  const newAssets = newAem;
  if (newFiles.length || newAssets) return { ...res, refused: true, reason: `the site changed since the plan was shown (${newFiles.length} new file(s)${newAssets ? ', AEM folder now visible' : ''}): re-plan and show it again`, newFiles };
  fs.unlinkSync(planFile(slug)); // one use only
  // 0. backup
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const B = opts.backup || `/shared/city-county-removed/${slug}-${stamp}`;
  fs.mkdirSync(B, { recursive: true });
  let backed = 0;
  await pool(inv.files, 4, async (f) => {
    const r = await fetchT(`${DA}/source/${ORG}/${REPO}/${f}`, { headers: auth }, 30000);
    if (r.status !== 200) throw new Error(`backup failed for ${f} (HTTP ${r.status}); nothing was removed`);
    const out = pathMod.join(B, f); fs.mkdirSync(pathMod.dirname(out), { recursive: true }); fs.writeFileSync(out, Buffer.from(await r.arrayBuffer())); backed++;
  });
  if (inv.aem.state === 'present') {
    let ab = 0;
    await pool(inv.aem.assets, 3, async (x) => {
      const base = `${AEM}${inv.aem.folder}/${encodeURIComponent(x.name)}`;
      const o = await fetchT(`${base}/jcr:content/renditions/original`, {}, 120000);
      if (o.status !== 200) throw new Error(`AEM backup failed for ${x.name} (HTTP ${o.status}); nothing was removed`);
      const dir = pathMod.join(B, 'aem', inv.aem.folder.replace(/^\//, '')); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(pathMod.join(dir, x.name), Buffer.from(await o.arrayBuffer()));
      const m = await fetchT(`${base}/jcr:content/metadata.json`, {}, 30000);
      if (m.status === 200) fs.writeFileSync(pathMod.join(dir, x.name + '.metadata.json'), await m.text());
      ab++;
    });
    L(`backup: ${ab}/${inv.aem.assets.length} AEM images (original + metadata)${inv.aem.subfolders.length ? `; ${inv.aem.subfolders.length} subfolder(s) NOT backed up` : ''}`);
  }
  fs.writeFileSync(pathMod.join(B, 'removal-plan.json'), JSON.stringify({ ...plan, inventoryAtExecute: inv }, null, 1));
  L(`backup: ${backed}/${inv.files.length} files + plan -> ${B}`);
  res.backup = B;
  const fails = [];
  // 1. unpublish, 2. unpreview
  for (const [op, key] of [['live', 'live'], ['preview', 'preview']]) {
    const targets = inv.pages.filter((x) => x[key] === 200);
    const st = await pool(targets, 4, async (x) => (await fetchT(`${ADMIN}/${op}/${ORG}/${REPO}/main/${adminPath(x.file)}`, { method: 'DELETE', headers: auth }, 30000)).status);
    st.forEach((s, i) => { if (![204, 200, 404].includes(s)) fails.push(`${op} DELETE ${targets[i].web} HTTP ${s}`); });
    L(`${op === 'live' ? 'unpublished' : 'unpreviewed'} ${st.filter((s) => s === 204 || s === 200).length}/${targets.length}`);
  }
  // 3. DA files, then folders (deepest first)
  const fst = await pool(inv.files, 4, async (f) => (await fetchT(`${DA}/source/${ORG}/${REPO}/${f}`, { method: 'DELETE', headers: auth }, 30000)).status);
  fst.forEach((s, i) => { if (![200, 204, 404].includes(s)) fails.push(`DA DELETE ${inv.files[i]} HTTP ${s}`); });
  for (const d of inv.folders) { const s = (await fetchT(`${DA}/source/${ORG}/${REPO}/${d}`, { method: 'DELETE', headers: auth }, 30000)).status; if (![200, 204, 404].includes(s)) fails.push(`DA DELETE folder ${d} HTTP ${s}`); }
  L(`DA: deleted ${fst.filter((s) => s === 200 || s === 204).length}/${inv.files.length} files and ${inv.folders.length} folders`);
  // 4. metadata row (concurrency-safe) + republish
  if (inv.metaRows.length) {
    fs.writeFileSync(pathMod.join(B, 'metadata-rows.json'), JSON.stringify(inv.metaRows, null, 1));
    const r = await registerTenant({ slug, remove: true, publish: true, settle: 6, token });
    r.log.forEach((x) => L(`  metadata: ${x.replace(/^\S+ /, '')}`));
    if (!r.ok) fails.push(`metadata row removal not confirmed: ${r.error}`);
    L(`metadata.json: row ${r.ok ? 'removed and sheet re-published' : 'NOT confirmed'}`);
  } else L('metadata.json: no row (skip)');
  // 5. AEM folder
  if (inv.aem.state === 'present') {
    try {
      const csrf = (await (await fetchT(`${AEM}/libs/granite/csrf/token.json`, {}, 20000)).json()).token;
      const d = await fetchT(`${AEM}/api/assets/city-county/${slug}`, { method: 'DELETE', headers: { 'CSRF-Token': csrf } }, 60000);
      L(`AEM: deleted folder ${inv.aem.folder} with ${inv.aem.assets.length} image(s) (HTTP ${d.status})`);
      if (![200, 204].includes(d.status)) fails.push(`AEM folder delete HTTP ${d.status}`);
    } catch (e) { fails.push(`AEM folder delete failed: ${e.message}`); }
  } else L('AEM: no folder (checked)');
  // 6. verify (index rebuilds can take a little while: poll)
  const v = { problems: [] };
  const left = await fetchT(`${DA}/list/${ORG}/${REPO}/${inv.base}`, { headers: auth }, 20000);
  const leftItems = left.status === 200 ? await left.json() : [];
  if (leftItems.length) v.problems.push(`DA /${inv.base} still lists ${leftItems.length} item(s)`);
  const still = await pool(inv.pages, 4, async (x) => { const j = await (await fetchT(`${ADMIN}/status/${ORG}/${REPO}/main/${adminPath(x.file)}`, { headers: auth }, 20000)).json(); return (j.preview && j.preview.status === 200) || (j.live && j.live.status === 200) ? x.web : null; });
  still.filter(Boolean).forEach((w) => v.problems.push(`still served: ${w}`));
  const mr = await (await fetchT(`${DA}/source/${ORG}/${REPO}/metadata.json?nc=${Date.now()}`, { headers: auth }, 20000)).json();
  if ((mr.data || []).some((x) => x.url === `/${inv.base}/**`)) v.problems.push('metadata.json still has the row');
  let idxLeft = {};
  for (let i = 0; i < 18; i++) { // index rebuilds lag the unpublish: ~1-3 min observed
    idxLeft = {};
    for (const [host, h] of [['preview', PAGE], ['live', LIVE]]) for (const name of ['news-index', 'events-index']) {
      try { const j = await (await fetchT(`${h}/${name}.json?limit=2000&nc=${Date.now()}`, {}, 15000)).json(); const n = (j.data || []).filter((x) => String(x.path || '').startsWith(`/${inv.base}/`)).length; if (n) idxLeft[`${host}/${name}`] = n; } catch (e) { /* ignore */ }
    }
    if (!Object.keys(idxLeft).length) break;
    await sleep(8000);
  }
  if (Object.keys(idxLeft).length) v.notes = [`news/events index rows still present after ~2.5 min (the pages are gone; the index clears on its own, usually within a few minutes): ${JSON.stringify(idxLeft)}`];
  let aemAfter = inv.aem.state === 'present' ? 'gone' : 'none';
  if (inv.aem.state === 'present') {
    let st = 0; for (let i = 0; i < 6; i++) { st = (await fetchT(`${AEM}/api/assets/city-county/${slug}.json`, {}, 20000)).status; if (st === 404) break; await sleep(3000); }
    const q = await fetchT(`${AEM}/bin/querybuilder.json?path=${encodeURIComponent(inv.aem.folder)}&type=dam:Asset&p.limit=1`, {}, 20000).then((r) => r.json()).catch(() => ({}));
    if (st !== 404) { v.problems.push(`AEM folder still answers HTTP ${st}`); aemAfter = 'STILL THERE'; }
    else if (q.total > 0) { v.problems.push(`AEM query still finds ${q.total} asset(s) under the folder`); aemAfter = 'assets still indexed'; }
  }
  const home = await fetchT(`${PAGE}/${inv.base}/?nc=${Date.now()}`, {}, 15000);
  L(`verify: DA folder ${leftItems.length ? 'NOT empty' : 'gone'}; pages still served ${still.filter(Boolean).length}; metadata row ${v.problems.some((x) => /metadata/.test(x)) ? 'PRESENT' : 'gone'}; index rows ${Object.keys(idxLeft).length ? JSON.stringify(idxLeft) : 'gone'}; AEM folder ${aemAfter}; ${PAGE}/${inv.base}/ -> HTTP ${home.status}`);
  res.failures = fails; res.verify = v; res.ok = !fails.length && !v.problems.length;
  res.elapsedS = +((Date.now() - t0) / 1000).toFixed(1);
  return res;
}

async function main(argv) {
  const a = argv.slice(2); const o = {}; const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--execute') o.execute = true; else if (a[i] === '--json') o.json = true; else if (a[i] === '--allow-showcase') o.allowShowcase = true;
    else if (a[i] === '--confirm') o.confirm = a[++i]; else if (a[i] === '--backup') o.backup = a[++i]; else if (a[i] === '--token') o.token = a[++i];
    else if (a[i].startsWith('--')) { console.error(`unknown flag ${a[i]}`); return 64; } else pos.push(a[i]);
  }
  const slug = (pos[0] || '').replace(/^\/?sites\//, '').replace(/\/+$/, '');
  if (!slug) { console.error('usage: node remove-site.cjs <slug> [--json]   then   node remove-site.cjs <slug> --execute --confirm "<typed phrase>"'); return 64; }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { console.error(`refused: "${slug}" is not a tenant slug (a-z, 0-9, -)`); return 3; }
  if (PROTECTED.has(slug)) { console.error(`refused: "${slug}" is protected and can never be removed with this tool`); return 3; }
  if (SHOWCASE.has(slug) && !o.allowShowcase) { console.error(`refused: "${slug}" is a showcase tenant; only its owner may remove it, with --allow-showcase`); return 3; }
  if (!(o.token || process.env.DA_TOKEN)) { console.error('DA_TOKEN not set: export DA_TOKEN=$(oauth-token adobe | tr -d "[:space:]")'); return 64; }
  if (!o.execute) {
    const r = await makePlan(slug, o);
    if (o.json) console.log(JSON.stringify(r, null, 2)); else console.log(r.ok ? r.text : `refused: ${r.reason}`);
    return r.ok ? 0 : r.aemBlocked ? 4 : 3;
  }
  if (!o.confirm) { console.error('refused: --execute needs --confirm "<the phrase the requester typed>"'); return 3; }
  const r = await execute(slug, o);
  if (o.json) console.log(JSON.stringify(r, null, 2));
  else if (r.refused) console.log(`refused: ${r.reason}`);
  else { (r.failures || []).forEach((f) => console.log(`FAIL ${f}`)); (r.verify.problems || []).forEach((f) => console.log(`NOT VERIFIED ${f}`)); (r.verify.notes || []).forEach((f) => console.log(`note: ${f}`)); console.log(r.ok ? `\nREMOVED "${slug}" and verified (${r.elapsedS}s). Backup: ${r.backup}` : `\nNOT FULLY REMOVED: see the lines above. Backup: ${r.backup}`); }
  return r.refused ? 3 : r.ok ? 0 : 1;
}

module.exports = { inventory, makePlan, execute };
if (isMain(module)) main(process.argv).then((c) => { process.exitCode = c; setTimeout(() => process.exit(c), 50); }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
