#!/usr/bin/env node
// preflight.cjs — run BEFORE the audience picks a place (off the clock).
// Checks every dependency the stage run needs, in parallel, in a few seconds:
//   DA token + repo access, Admin API (preview) reachability, AEM author session (CSRF),
//   AEM Assets parent folder, Adobe Stock search, Wikipedia/Wikidata, companion skills, magick-wasm.
// Usage: DA_TOKEN=$(oauth-token adobe | tr -d '[:space:]') node preflight.cjs [--aem <author host>] [--json]
// Exit 0 = all green; 1 = something the demo depends on is broken (fix it before going on stage).
const fs = require('fs');
const { fetchT, isMain } = require('./lib.cjs');

const ORG = 'adobe-pubsec';
const REPO = 'city-county';
const DEFAULT_AEM = 'https://author-p129103-e1259846.adobeaemcloud.com';

async function check(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); return { name, ok: true, ms: Date.now() - t0, detail }; }
  catch (e) { return { name, ok: false, ms: Date.now() - t0, detail: String(e.message || e) }; }
}

async function preflight({ token = process.env.DA_TOKEN, aem = DEFAULT_AEM } = {}) {
  const H = aem.replace(/\/$/, '');
  const auth = token ? { Authorization: 'Bearer ' + token } : {};
  const results = await Promise.all([
    check('companion skills', async () => {
      const need = ['da-content', 'da-auth'];
      const missing = need.filter((s) => !fs.existsSync(`/workspace/skills/${s}/SKILL.md`));
      if (missing.length) throw new Error('missing: ' + missing.join(', ') + ' (upskill adobe/skills --skill <name>)');
      return 'da-content, da-auth present';
    }),
    check('image tools (hero crop)', async () => {
      const p = '/shared/lib/node_modules/@imagemagick/magick-wasm/package.json';
      if (!fs.existsSync(p)) throw new Error('magick-wasm missing (ipk add -g @imagemagick/magick-wasm@0.0.44): needed to crop the Stock ID strip off the hero');
      return 'magick-wasm ' + JSON.parse(fs.readFileSync(p, 'utf8')).version;
    }),
    check('DA token + repo', async () => {
      if (!token) throw new Error('DA_TOKEN not set: DA_TOKEN=$(oauth-token adobe | tr -d "[:space:]")');
      const r = await fetchT(`https://admin.da.live/list/${ORG}/${REPO}/sites`, { headers: auth }, 15000);
      if (r.status !== 200) throw new Error('list /sites HTTP ' + r.status + ' (token expired? run oauth-token adobe)');
      const j = await r.json();
      return `${j.length} tenants: ${j.map((x) => x.name).join(', ')}`;
    }),
    check('DA blueprint', async () => {
      const r = await fetchT(`https://admin.da.live/source/${ORG}/${REPO}/blueprint/index.html`, { headers: auth }, 15000);
      if (r.status !== 200) throw new Error('blueprint/index.html HTTP ' + r.status);
      return 'readable';
    }),
    check('Admin API (preview)', async () => {
      const r = await fetchT(`https://admin.hlx.page/status/${ORG}/${REPO}/main/metadata.json`, { headers: auth }, 15000);
      if (r.status !== 200) throw new Error('status HTTP ' + r.status);
      const j = await r.json();
      return `metadata.json preview ${j.preview?.status}, live ${j.live?.status}`;
    }),
    check('AEM author session (CSRF)', async () => {
      const r = await fetchT(H + '/libs/granite/csrf/token.json', {}, 20000);
      const j = r.ok ? await r.json().catch(() => ({})) : {};
      if (!j.token) throw new Error(`HTTP ${r.status}: log in to ${H} in the LEADER browser, then re-run`);
      const u = await (await fetchT(H + '/libs/granite/security/currentuser.json', {}, 15000)).json();
      if (!u.authorizableId || u.authorizableId === 'anonymous') throw new Error('author session is anonymous: log in to ' + H);
      return 'logged in as ' + u.authorizableId;
    }),
    check('AEM author is up', async () => {
      const r = await fetchT(H + '/libs/granite/core/content/login.html', {}, 20000);
      const b = await r.text();
      if (/hibernated/i.test(b)) throw new Error('environment HIBERNATED: de-hibernate in Cloud Manager (takes minutes)');
      if (!/coral-Form/.test(b)) throw new Error('environment still starting (no login form yet)');
      return 'fully up';
    }),
    check('AEM Assets parent folder', async () => {
      const r = await fetchT(H + '/content/dam/city-county.json', {}, 15000);
      if (r.status === 404) return 'not yet created (aem-assets.cjs creates it)';
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return '/content/dam/city-county exists';
    }),
    check('AEM search index', async () => {
      const r = await fetchT(H + '/bin/querybuilder.json?path=/content/dam/city-county&type=dam:Asset&fulltext=city-county-demo&p.limit=1', {}, 20000);
      const j = await r.json();
      if (!(j.total > 0)) throw new Error('search returns 0: index may be stalled; on stage show the folder, not a search');
      return `${j.total} demo assets searchable`;
    }),
    check('Adobe Stock search', async () => {
      const r = await fetchT('https://stock.adobe.io/Rest/Media/1/Search/Files?search_parameters%5Bwords%5D=Asheville&search_parameters%5Blimit%5D=1&result_columns%5B%5D=nb_results', { headers: { 'x-api-key': 'AdobeStockClient1', 'X-Product': 'SLICC-city-county/1.0' } }, 15000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return `${(await r.json()).nb_results} results for "Asheville"`;
    }),
    check('Wikipedia + Wikidata', async () => {
      const [a, b] = await Promise.all([
        fetchT('https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=Boise&srlimit=1', {}, 15000),
        fetchT('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&ids=Q35775&props=info', {}, 15000),
      ]);
      if (!a.ok || !b.ok) throw new Error(`wikipedia ${a.status}, wikidata ${b.status}`);
      return 'reachable';
    }),
  ]);
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { preflight };

if (isMain(module)) {
  const a = process.argv.slice(2);
  const ai = a.indexOf('--aem');
  preflight({ aem: ai >= 0 ? a[ai + 1] : DEFAULT_AEM }).then((r) => {
    if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      for (const x of r.results) console.log(`${x.ok ? 'OK  ' : 'FAIL'}  ${x.name.padEnd(26)} ${String(x.ms).padStart(5)}ms  ${x.detail}`);
      console.log(r.ok ? '\nALL GREEN: ready for the audience.' : '\nNOT READY: fix the FAIL lines above before going on stage.');
    }
    process.exitCode = r.ok ? 0 : 1;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
