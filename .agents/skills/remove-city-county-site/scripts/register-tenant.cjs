#!/usr/bin/env node
// register-tenant.cjs — Step 7, safely: add (or update) this tenant's row in the SHARED
// /metadata.json sheet, then re-read until the row has survived other people's writes.
//
// Why: every tenant build does GET -> append -> PUT on the same sheet. When several SCs build
// at once, a PUT based on a stale GET silently drops rows written in between (the site then
// renders without its palette). This script re-reads after a short, jittered settle and
// re-applies its row if someone else's save removed it. Other writers running this script
// do the same, so concurrent builds converge to "every row present".
//
// Usage:
//   DA_TOKEN=… node register-tenant.cjs --slug <slug> --primary '#1F4477' --secondary '#237F9F' --accent '#B43001'
//        [--publish]        preview + publish metadata.json once the row is confirmed, then check the delivered copy
//        [--settle 8]       seconds of re-reads after the write (default 8)
//        [--remove]         remove the tenant's row instead (cleanup), same safety loop
//        [--sheet <path>]   DA path of the sheet (default metadata.json; for tests only)
//        [--json]
// Exit: 0 = row confirmed (and delivered, with --publish); 1 = could not confirm; 64 = bad usage.
const { fetchT, isMain } = require('./lib.cjs');

const ORG = 'adobe-pubsec'; const REPO = 'city-county';
const SRC = `https://admin.da.live/source/${ORG}/${REPO}/`;
const ADMIN = `https://admin.hlx.page`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
const HEX = /^#[0-9a-f]{6}$/i;

function rowFor(o) {
  return { url: `/sites/${o.slug}/**`, 'site-base': `/sites/${o.slug}`, 'color-primary': o.primary, 'color-accent': o.accent, 'color-secondary': o.secondary };
}
const sameRow = (a, b) => a && b && Object.keys(b).every((k) => String(a[k] || '').toLowerCase() === String(b[k] || '').toLowerCase());

async function readSheet(auth, sheet) {
  const r = await fetchT(`${SRC}${sheet}?nc=${Date.now()}`, { headers: { ...auth, 'Cache-Control': 'no-cache' } }, 15000);
  if (r.status !== 200) throw new Error(`GET ${sheet} HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.data) || j[':type'] !== 'sheet') throw new Error(`${sheet} is not a single DA sheet (keys: ${Object.keys(j || {}).join(',')}); refusing to write`);
  return j;
}
async function writeSheet(auth, sheet, j) {
  j.total = j.data.length; j.limit = j.data.length; j.offset = 0;
  const fd = new FormData();
  fd.append('data', new Blob([JSON.stringify(j)], { type: 'application/json' }), sheet.split('/').pop());
  const r = await fetchT(`${SRC}${sheet}`, { method: 'PUT', headers: auth, body: fd }, 20000);
  if (![200, 201].includes(r.status)) throw new Error(`PUT ${sheet} HTTP ${r.status}`);
}
// state of our row in a sheet: 'ok' (as wanted), 'missing', 'differs', 'absent-ok' (remove mode)
function stateOf(j, o, want) {
  const hits = j.data.filter((x) => x.url === want.url);
  if (o.remove) return hits.length ? 'present' : 'ok';
  if (hits.length === 1 && sameRow(hits[0], want)) return 'ok';
  return hits.length ? (hits.length > 1 ? 'duplicated' : 'differs') : 'missing';
}

async function registerTenant(opts) {
  const o = { settle: 8, sheet: 'metadata.json', ...opts };
  const token = o.token || process.env.DA_TOKEN;
  if (!token) throw Object.assign(new Error('DA_TOKEN not set: DA_TOKEN=$(oauth-token adobe | tr -d "[:space:]")'), { code: 64 });
  if (!o.slug || !/^[a-z0-9][a-z0-9-]*$/.test(o.slug) || o.slug === 'blueprint') throw Object.assign(new Error('--slug <a-z0-9-> is required (not "blueprint")'), { code: 64 });
  if (!o.remove) for (const k of ['primary', 'secondary', 'accent']) if (!HEX.test(o[k] || '')) throw Object.assign(new Error(`--${k} must be a #rrggbb hex color`), { code: 64 });
  const auth = { Authorization: 'Bearer ' + token };
  const want = rowFor(o);
  const log = []; const t0 = Date.now(); const t = () => +((Date.now() - t0) / 1000).toFixed(1);
  const report = { ok: false, slug: o.slug, mode: o.remove ? 'remove' : 'upsert', sheet: o.sheet, row: o.remove ? undefined : want, writes: 0, log };
  let seenUrls = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    // 1. fresh read -> apply -> write (read and write back-to-back to keep the race window small)
    const j = await readSheet(auth, o.sheet);
    if (!seenUrls) seenUrls = new Set(j.data.map((x) => x.url));
    const st = stateOf(j, o, want);
    if (st !== 'ok') {
      if (o.remove) j.data = j.data.filter((x) => x.url !== want.url);
      else {
        const i = j.data.findIndex((x) => x.url === want.url);
        const others = j.data.filter((x, k) => x.url !== want.url || k === i);
        if (i >= 0) { const k = others.findIndex((x) => x.url === want.url); others[k] = { ...others[k], ...want }; } else others.push(want);
        j.data = others;
      }
      await writeSheet(auth, o.sheet, j); report.writes++;
      log.push(`${t()}s attempt ${attempt}: row ${st} -> wrote (${j.data.length} rows)`);
    } else log.push(`${t()}s attempt ${attempt}: row already ${o.remove ? 'absent' : 'correct'}`);
    // 2. settle: re-read a few times; another writer's stale PUT shows up as our row missing
    let lost = false; const until = Date.now() + o.settle * 1000;
    while (Date.now() < until) {
      await sleep(Math.min(jitter(1500, 3000), Math.max(0, until - Date.now())));
      const k = await readSheet(auth, o.sheet);
      const s2 = stateOf(k, o, want);
      if (s2 !== 'ok') { lost = true; log.push(`${t()}s re-read: row ${s2} (someone else saved over it); re-applying`); break; }
      for (const u of seenUrls) if (u !== want.url && !k.data.some((x) => x.url === u)) { log.push(`${t()}s note: row ${u} disappeared (another writer; their own check should restore it)`); seenUrls.delete(u); }
    }
    if (lost) { await sleep(jitter(500, 2500)); continue; }
    // 3. optional publish, then check the delivered copy (preview reads DA at publish time)
    if (o.publish) {
      const pv = await fetchT(`${ADMIN}/preview/${ORG}/${REPO}/main/${o.sheet}`, { method: 'POST', headers: auth }, 30000);
      const lv = pv.status === 200 ? await fetchT(`${ADMIN}/live/${ORG}/${REPO}/main/${o.sheet}`, { method: 'POST', headers: auth }, 30000) : { status: 'skipped' };
      log.push(`${t()}s preview ${pv.status}, live ${lv.status}`);
      if (pv.status !== 200 || lv.status !== 200) { report.error = `publish failed (preview ${pv.status}, live ${lv.status}); re-run with --publish`; report.elapsedS = t(); return report; }
      let delivered = null;
      for (let i = 0; i < 4 && delivered !== 'ok'; i++) {
        const r = await fetchT(`https://main--${REPO}--${ORG}.aem.page/${o.sheet}?nc=${Date.now()}`, {}, 15000);
        delivered = r.status === 200 ? stateOf({ data: (await r.json()).data || [] }, o, want) : `HTTP ${r.status}`;
        if (delivered !== 'ok') await sleep(1500);
      }
      log.push(`${t()}s delivered aem.page copy: row ${delivered}`);
      if (delivered !== 'ok') { await sleep(jitter(500, 2500)); continue; } // clobbered between check and publish: go again
      report.published = true;
    }
    report.ok = true; break;
  }
  if (!report.ok && !report.error) report.error = 'row could not be confirmed after 6 attempts (very heavy concurrent editing?); re-run this command';
  report.elapsedS = t();
  return report;
}

module.exports = { registerTenant };

if (isMain(module)) {
  const a = process.argv.slice(2); const o = {}; let json = false;
  const val = { '--slug': 'slug', '--primary': 'primary', '--secondary': 'secondary', '--accent': 'accent', '--settle': 'settle', '--sheet': 'sheet', '--token': 'token' };
  for (let i = 0; i < a.length; i++) {
    if (val[a[i]]) o[val[a[i]]] = a[++i];
    else if (a[i] === '--publish') o.publish = true;
    else if (a[i] === '--remove') o.remove = true;
    else if (a[i] === '--json') json = true;
    else { console.error(`unknown argument ${a[i]}`); process.exitCode = 64; }
  }
  if (o.settle) o.settle = Number(o.settle);
  if (!process.exitCode) registerTenant(o).then((r) => {
    if (json) console.log(JSON.stringify(r, null, 2));
    else { r.log.forEach((l) => console.log(l)); console.log(r.ok ? `OK  ${r.mode} ${r.slug} confirmed${r.published ? ' and published' : ''} in ${r.elapsedS}s (${r.writes} write${r.writes === 1 ? '' : 's'})` : `NOT OK  ${r.error}`); }
    process.exitCode = r.ok ? 0 : 1;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = e.code || 1; });
}
