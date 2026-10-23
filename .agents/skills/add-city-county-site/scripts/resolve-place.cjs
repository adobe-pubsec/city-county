#!/usr/bin/env node
// resolve-place.cjs — audience-supplied place name ("Boise", "Fairfax County") ->
// verified official website, via Wikipedia search -> Wikidata (P856 official website).
// Wikidata's own search is unreliable for place names, so search Wikipedia and use
// each hit's wikibase_item. US places only (P17 = Q30).
//
// Usage: node resolve-place.cjs "<place name>" [--json]
// Exit:  0 = verified live site (status "verified" or "verified-ambiguous" — ask the
//        user to pick when ambiguous), 2 = found but site not verified, 1 = nothing.
const { fetchT, getJson, isMain } = require('./lib.cjs');

const PLACE = /\b(city|town|county|village|borough|township|municipality|parish|consolidated city-county|independent city|county seat|charter township|state capital|big city|metropolis)\b/i;
const REJECT = /\b(metropolitan|statistical area|airport|university|team|ship|neighborhood|film|album|census-designated)\b/i;

async function resolvePlace(q) {
  const wp = await getJson('https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=8&prop=pageprops&ppprop=wikibase_item&gsrsearch=' + encodeURIComponent(q));
  const pages = Object.values(wp?.query?.pages || {}).filter((p) => p.pageprops?.wikibase_item).sort((a, b) => a.index - b.index);
  if (!pages.length) return { query: q, status: 'not-found', alternates: [] };

  const ids = pages.map((p) => p.pageprops.wikibase_item);
  const wd = await getJson('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|labels|descriptions&languages=en&ids=' + ids.join('|'));
  const vals = (e, p) => (e.claims?.[p] || []).filter((c) => c.rank !== 'deprecated').map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
  const classIds = new Set();
  for (const id of ids) for (const v of vals(wd.entities[id] || {}, 'P31')) classIds.add(v.id);
  const cl = classIds.size ? await getJson('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=' + [...classIds].slice(0, 50).join('|')) : { entities: {} };
  const label = (id) => cl.entities?.[id]?.labels?.en?.value || id;

  const cands = [];
  for (const p of pages) {
    const id = p.pageprops.wikibase_item;
    const e = wd.entities[id] || {};
    const classes = vals(e, 'P31').map((v) => label(v.id));
    if (!vals(e, 'P17').some((v) => v.id === 'Q30')) continue;
    if (!classes.some((c) => PLACE.test(c)) || classes.every((c) => REJECT.test(c))) continue;
    const sites = (e.claims?.P856 || []).filter((c) => c.rank !== 'deprecated')
      .sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'))
      .map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
    cands.push({ title: p.title, wikidata: id, description: e.descriptions?.en?.value || '', classes, website: sites[0] || null, commonsCategory: vals(e, 'P373')[0] || null });
  }
  if (!cands.length) return { query: q, status: 'no-us-place', alternates: [] };

  for (const c of cands.slice(0, 3)) {
    if (!c.website) { c.live = 'no-website-on-wikidata'; continue; }
    try {
      const r = await fetchT(c.website, { headers: { 'User-Agent': require('./lib.cjs').UA_BROWSER } });
      c.httpStatus = r.status; c.finalUrl = r.url || c.website;
      c.live = r.status < 400 ? 'live' : r.status === 403 ? 'blocked-bot-likely-live' : 'error';
    } catch (err) { c.live = 'unreachable'; }
  }
  const best = cands[0];
  const ambiguous = cands.length > 1 && cands[1].title.split(',')[0].toLowerCase().includes(q.split(',')[0].toLowerCase().replace(/\s+(county|city)$/, ''));
  const ok = best.live === 'live' || best.live === 'blocked-bot-likely-live';
  return { query: q, status: ok ? (ambiguous ? 'verified-ambiguous' : 'verified') : 'needs-pick', best, alternates: cands.slice(1, 4) };
}

module.exports = { resolvePlace };

if (isMain(module)) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const q = args.filter((a) => a !== '--json').join(' ').trim();
  if (!q) { console.error('usage: resolve-place.cjs "<place name>" [--json]'); process.exitCode = 1; }
  else resolvePlace(q).then((res) => {
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`query:   ${res.query}\nstatus:  ${res.status}`);
      const b = res.best;
      if (b) console.log(`best:    ${b.title} (${b.wikidata}) — ${b.description}\nsite:    ${b.website || '-'} -> ${b.live}${b.finalUrl && b.finalUrl !== b.website ? ' (final ' + b.finalUrl + ')' : ''}\ncommons: ${b.commonsCategory || '-'}`);
      for (const a of res.alternates || []) console.log(`  alt:   ${a.title} (${a.wikidata}) ${a.website || '-'}${a.live ? ' -> ' + a.live : ''}`);
    }
    process.exitCode = res.status.startsWith('verified') ? 0 : res.best ? 2 : 1;
  }).catch((e) => { console.error('error:', e.message || e); process.exitCode = 1; });
}
