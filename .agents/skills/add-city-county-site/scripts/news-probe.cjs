#!/usr/bin/env node
// news-probe.cjs — will this city's REAL news and events show up? Answer in ~5–15 s,
// read-only (no DA token used, nothing written). Run it on likely audience picks off the
// clock, and on the clock right after resolve-place so you know before the audience does.
//
// Usage: node news-probe.cjs "<place name or https://site>" ["<another>" …] [--tz America/Denver] [--budget 30] [--json]
// Exit:  0 = all GREEN; 2 = some YELLOW (partial / meetings-only / stale); 1 = some RED (news will be samples) or unresolved.
const { fetchT, isMain, UA_BROWSER } = require('./lib.cjs');
const { resolvePlace } = require('./resolve-place.cjs');
const { newsEvents } = require('./news-events.cjs');

// Platform fingerprints (homepage HTML). `known` = news-events has a reader for it.
const PLATFORMS = [
  { name: 'CivicPlus HCMS (Engage 6)', re: /hcmsClientToken|content\.civicplus\.com\/app\//i, known: true },
  { name: 'CivicPlus classic', re: /CivicAlerts\.aspx|\/RSSFeed\.aspx|civicplus\.com/i, known: true },
  { name: 'OpenCities', re: /opencities|seamlessdocs|oc-core/i, known: true },
  { name: 'WordPress', re: /\/wp-content\/|\/wp-json\//i, known: true },
  { name: 'Drupal', re: /data-drupal|Drupal\.settings|\/sites\/default\/files\//i, known: false },
  { name: 'Granicus govAccess', re: /granicus|govaccess|vision(?:live|internet)/i, known: false },
  { name: 'Localist calendar', re: /localist/i, known: false },
  { name: 'Trumba calendar', re: /trumba/i, known: false },
  { name: 'CivicClerk', re: /civicclerk/i, known: false },
  { name: 'Legistar', re: /legistar\.com/i, known: true },
];
const MEETING = /\b(meeting|commission|board|council|committee|session|hearing|authority|agenda)\b/i;

async function platformsOf(site) {
  try {
    const r = await fetchT(site, { headers: { 'User-Agent': UA_BROWSER } }, 10000);
    const html = await r.text();
    let hit = PLATFORMS.filter((p) => p.re.test(html));
    if (hit.some((p) => /HCMS/.test(p.name))) hit = hit.filter((p) => p.name !== 'CivicPlus classic'); // HCMS pages also mention civicplus.com
    return hit.map((p) => (p.known ? p.name : `${p.name} (no reader)`));
  } catch (e) { return [`homepage unreachable (${e.name === 'AbortError' ? 'timeout' : e.message})`]; }
}

async function probe(target, { tz = 'America/New_York', budget = 30 } = {}) {
  const out = { target, verdict: 'RED', reasons: [] };
  let site = target;
  if (!/^https?:\/\//i.test(target)) {
    const rp = await resolvePlace(target);
    out.resolved = rp.best ? { title: rp.best.title, website: rp.best.website, live: rp.best.live, status: rp.status } : null;
    if (!rp.best || !rp.best.website || !/^verified/.test(rp.status)) { out.reasons.push(`could not resolve a live official site (${rp.status})`); return out; }
    site = rp.best.website;
    if (rp.status === 'verified-ambiguous') out.ambiguous = (rp.alternates || []).map((x) => x.title).slice(0, 3);
  }
  out.site = site;
  const [plat, r] = await Promise.all([platformsOf(site), newsEvents({ site, sourceOnly: true, budget, tz, token: '' })]);
  out.platforms = plat; const nNeed = 3;
  const s = r.sourcing || { news: {}, events: {} };
  const realN = (r.news || []).filter((x) => x.origin === 'real');
  const realE = (r.events || []).filter((x) => x.origin === 'real');
  out.news = { real: realN.length, via: s.news.winner || null, items: realN.map((x) => `${x.date}  ${x.title}`) };
  out.events = { real: realE.length, via: s.events.winner || null, items: realE.map((x) => `${x.startDate} ${x.startTime || ''}  ${x.title}`.replace(/\s+/g, ' ')) };
  out.elapsedS = r.elapsedS;
  // verdict
  if (realN.length === 0) out.reasons.push('no real news: all 3 will be blueprint samples');
  else if (realN.length < 3) out.reasons.push(`only ${realN.length}/3 real news (rest are samples)`);
  if (realE.length === 0) out.reasons.push('no real events: all 3 will be blueprint samples');
  else if (realE.length < 3) out.reasons.push(`only ${realE.length}/3 real events`);
  if (realE.length && realE.every((x) => MEETING.test(x.title))) out.reasons.push('events are all public meetings (real, but dry on stage)');
  const newest = realN.map((x) => x.date).sort().pop();
  if (newest) { const age = Math.round((Date.now() - Date.parse(newest)) / 864e5); if (age > 60) out.reasons.push(`newest news is ${age} days old`); }
  const unknown = plat.filter((p) => /no reader/.test(p));
  if (!realN.length && unknown.length) out.reasons.push(`site uses ${unknown.join(', ')}`);
  if (realN.length === nNeed && realE.length === nNeed) out.platforms = plat.map((p) => p.replace(' (no reader)', ''));
  out.verdict = realN.length === 0 ? 'RED' : out.reasons.length ? 'YELLOW' : 'GREEN';
  return out;
}

function print(p) {
  const L = (s) => console.log(s);
  L(`\n${p.verdict.padEnd(6)} ${p.target}${p.site && p.site !== p.target ? `  ->  ${p.site}` : ''}${p.elapsedS != null ? `  (${p.elapsedS}s)` : ''}`);
  if (p.ambiguous && p.ambiguous.length) L(`       ? ambiguous name; also: ${p.ambiguous.join(' | ')} (pass "Place, State")`);
  if (p.platforms && p.platforms.length) L(`       platform: ${p.platforms.join(', ')}`);
  if (p.news) { L(`       news ${p.news.real}/3${p.news.via ? ` via ${p.news.via}` : ''}`); p.news.items.forEach((t) => L(`         ${t}`)); }
  if (p.events) { L(`       events ${p.events.real}/3${p.events.via ? ` via ${p.events.via}` : ''}`); p.events.items.forEach((t) => L(`         ${t}`)); }
  p.reasons.forEach((x) => L(`       ! ${x}`));
}

module.exports = { probe };

if (isMain(module)) {
  const a = process.argv.slice(2); const opts = {}; const targets = []; let json = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--json') json = true;
    else if (a[i] === '--tz') opts.tz = a[++i];
    else if (a[i] === '--budget') opts.budget = Number(a[++i]);
    else targets.push(a[i]);
  }
  if (!targets.length) { console.error('usage: node news-probe.cjs "<place or https://site>" ["<another>" …] [--tz <IANA>] [--budget 30] [--json]'); process.exitCode = 64; }
  else (async () => {
    const res = [];
    for (const t of targets) { // sequential: news-events keeps one runtime per call
      try { res.push(await probe(t, opts)); } catch (e) { res.push({ target: t, verdict: 'RED', reasons: [`probe error: ${e.message || e}`] }); }
      if (!json) print(res[res.length - 1]);
    }
    if (json) console.log(JSON.stringify(res, null, 2));
    else if (res.length > 1) console.log(`\n${res.map((r) => `${r.verdict[0]} ${r.target}`).join('   ')}`);
    const worst = res.some((r) => r.verdict === 'RED') ? 1 : res.some((r) => r.verdict === 'YELLOW') ? 2 : 0;
    process.exitCode = worst;
    setTimeout(() => process.exit(worst), 50); // abandoned fetches must not hold the process open
  })();
}
