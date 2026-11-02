#!/usr/bin/env node
// find-address.cjs — the tenant's real government street address for the footer, without asking the requester.
// Order: (1) schema.org PostalAddress on the official homepage, (2) a "<street> <city>, <ST> <zip>" pattern in the
// homepage text (footer half preferred), (3) OpenStreetMap Nominatim lookup of "<City Hall | County Government Center>,
// <place>, <state>" restricted to townhall / government offices. Read-only, ~1-6 s, hard cap 20 s.
//
// Usage: node find-address.cjs --entity "City of Chicago" --state "Illinois" [--site https://www.chicago.gov/] [--json]
// Exit 0 + address on stdout (one line) when found; exit 2 + empty stdout when not (then omit --address; the footer
// shows the entity name). Never invent an address.
const { fetchT, isMain, UA_BROWSER } = require('./lib.cjs');

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const ABBR = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));
const stAbbr = (s) => { const t = String(s || '').trim(); return STATES[t.toUpperCase()] ? t.toUpperCase() : ABBR[t.toLowerCase()] || ''; };

const SUFFIX = '(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Way|Pl|Place|Plaza|Sq|Square|Ln|Lane|Pkwy|Parkway|Ct|Court|Hwy|Highway|Ter|Terrace|Cir|Circle|Trl|Trail|Pike|Row|Mall|Center|Ctr)';
const ST_RE = `(?:${Object.keys(STATES).join('|')}|${Object.values(STATES).join('|')})`;
const ADDR_RE = new RegExp(`\\b(\\d{1,6}(?:-\\d+)?\\s+(?:[NSEW]\\.?\\s+|North\\s+|South\\s+|East\\s+|West\\s+)?[A-Z0-9][\\w.'’-]*(?:\\s+[A-Z0-9][\\w.'’-]*){0,4}\\s+${SUFFIX}\\.?(?:\\s+[NSEW]{1,2}\\.?)?)(?:,?\\s+(?:Suite|Ste\\.?|Room|Rm\\.?|Floor|Fl\\.?|#)\\s*[\\w-]+)?(?:,?\\s+P\\.?\\s?O\\.?\\s+Box\\s+\\d+)?,?\\s+([A-Z][a-zA-Z.'’ -]{1,30}?),?\\s+(${ST_RE})\\.?,?\\s+(\\d{5})(?:-\\d{4})?\\b`, 'g');

const fmt = (street, city, st, zip) => `${street.replace(/\s+/g, ' ').trim()}, ${city.trim()}, ${stAbbr(st) || st} ${zip}`;
const placeOf = (entity) => String(entity).replace(/^(City|Town|Village|Borough|Township|County) of\s+/i, '').replace(/\s+(County|Parish|Borough)$/i, '').trim();
const isCounty = (entity) => /\bcounty\b|\bparish\b/i.test(entity);

function pageText(h) {
  return h.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, ', ')
    .replace(/<\/(p|div|li|span|address|td|a)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/\s*,\s*(,\s*)+/g, ', ').replace(/\s+/g, ' ');
}
function fromLd(h, state) {
  for (const m of h.matchAll(/"streetAddress"\s*:\s*"([^"]{4,80})"([\s\S]{0,400})/g)) {
    const city = (m[2].match(/"addressLocality"\s*:\s*"([^"]+)"/) || [])[1];
    const reg = (m[2].match(/"addressRegion"\s*:\s*"([^"]+)"/) || [])[1];
    const zip = (m[2].match(/"postalCode"\s*:\s*"(\d{5})/) || [])[1];
    if (city && zip && /\d/.test(m[1]) && (!state || !reg || stAbbr(reg) === stAbbr(state))) return fmt(m[1], city, reg || state, zip);
  }
  return '';
}
function fromText(h, state, place) {
  const t = pageText(h);
  const hits = [...t.matchAll(ADDR_RE)].map((m) => ({ street: m[1], city: m[2], st: m[3], zip: m[4], pos: m.index / t.length }))
    .filter((x) => !state || stAbbr(x.st) === stAbbr(state));
  if (!hits.length) return '';
  const score = (x) => (x.pos > 0.5 ? 2 : 0) + (place && x.city.toLowerCase().includes(place.toLowerCase()) ? 2 : 0) + hits.filter((y) => y.street === x.street).length * 0.1;
  hits.sort((a, b) => score(b) - score(a) || b.pos - a.pos);
  const b = hits[0];
  return fmt(b.street, b.city, b.st, b.zip);
}
async function fromOsm(entity, state) {
  const place = placeOf(entity);
  const names = isCounty(entity)
    ? [`${place} County Government Center`, `${place} County Administration Building`, `${place} County Courthouse`]
    : [`${place} City Hall`, `${place} Town Hall`, `${place} Municipal Building`];
  for (const n of names) {
    const q = `${n}, ${STATES[stAbbr(state)] || state}`;
    try {
      const r = await fetchT(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'adobe-pubsec-city-county-demo/1.0 (foxx@adobe.com)' } }, 8000);
      if (!r.ok) continue;
      for (const x of await r.json()) {
        const a = x.address || {};
        const gov = (x.category === 'amenity' && /townhall|courthouse/.test(x.type)) || (x.category === 'office' && x.type === 'government');
        const city = a.city || a.town || a.village || a.hamlet || '';
        if (gov && a.house_number && a.road && a.postcode && city && (!state || stAbbr(a.state) === stAbbr(state))) return { address: fmt(`${a.house_number} ${a.road}`, city, a.state, a.postcode.slice(0, 5)), name: x.name };
      }
    } catch (e) { /* next */ }
    await new Promise((res) => setTimeout(res, 1100)); // Nominatim: max 1 req/s
  }
  return null;
}

async function findAddress({ entity, state, site }) {
  const place = placeOf(entity);
  if (site) {
    try {
      const r = await fetchT(site, { headers: { 'User-Agent': UA_BROWSER } }, 10000);
      if (r.ok) {
        const h = await r.text();
        const ld = fromLd(h, state); if (ld) return { address: ld, source: 'site-jsonld', site };
        const tx = fromText(h, state, place); if (tx) return { address: tx, source: 'site-text', site };
      }
    } catch (e) { /* fall through to OSM */ }
  }
  if (entity && state) { const o = await fromOsm(entity, state); if (o) return { address: o.address, source: 'openstreetmap', building: o.name }; }
  return { address: '', source: 'none' };
}

if (isMain(module)) {
  const a = process.argv.slice(2); const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const entity = get('--entity'); const state = get('--state'); const site = get('--site');
  if (!entity) { console.error('usage: node find-address.cjs --entity "City of X" --state "<State or ST>" [--site <url>] [--json]'); process.exitCode = 64; }
  else {
    const kill = setTimeout(() => { console.error('find-address: 20 s cap reached'); if (a.includes('--json')) console.log(JSON.stringify({ address: '', source: 'timeout' })); process.exit(2); }, 20000);
    findAddress({ entity, state, site }).then((r) => {
      clearTimeout(kill);
      if (a.includes('--json')) console.log(JSON.stringify(r)); else if (r.address) console.log(r.address);
      process.exitCode = r.address ? 0 : 2;
    });
  }
}
module.exports = { findAddress, stAbbr };
