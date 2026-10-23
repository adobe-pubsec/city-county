#!/usr/bin/env node
// place-nickname.cjs — localized hero line source: a place's nickname(s) and motto from its
// Wikipedia infobox (nickname/nicknames/motto), with Wikidata P1449 as a fallback. ~0.3 s.
// Usage: node place-nickname.cjs "<Wikipedia title>" [--json]
const UA = { 'User-Agent': 'SLICC-city-county-demo/1.0 (https://github.com/adobe-pubsec/city-county)' };
async function f(u, ms = 12000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { return await fetch(u, { headers: UA, signal: c.signal }); } finally { clearTimeout(t); } }

function field(w, names) {
  for (const n of names) {
    const m = w.match(new RegExp('\\|\\s*' + n + '\\s*=\\s*([\\s\\S]*?)\\n\\s*(?:\\||\\}\\})'));
    if (m && m[1].trim()) return m[1];
  }
  return '';
}
function clean(raw, splitCommas = true) {
  let s = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '');
  s = s.replace(/\{\{(?:efn|sfn|refn|cn|citation needed|force singular|nbsp)[^{}]*\}\}/gi, '');
  s = s.replace(/\{\{lang\|[^|}]*\|([^}]*)\}\}/gi, '$1').replace(/\{\{nowrap\|([^}]*)\}\}/gi, '$1');
  s = s.replace(/\{\{(?:hlist|flatlist|unbulleted list|plainlist|ubl|plain list)\s*\|?/gi, '|').replace(/\}\}/g, '').replace(/\{\{[^|}]*\|?/g, '');
  s = s.replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1').replace(/'''?/g, '').replace(/<br\s*\/?>/gi, '|').replace(/<[^>]+>/g, '');
  return s.split(splitCommas ? /[|;\n*•]|,(?![^(]*\))/ : /[|;\n*•]/).map((x) => x.replace(/\(.*?\)/g, '').replace(/^[\s"“”']+|[\s"“”'.]+$/g, '').replace(/^and\s+/i, '').trim())
    .filter((x) => x.length > 2 && x.length < 60 && !/=|^(nicknames?|motto)$/i.test(x));
}

async function placeNickname(title) {
  const r = await f('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=revisions|pageprops&ppprop=wikibase_item&rvprop=content&rvslots=main&rvsection=0&titles=' + encodeURIComponent(title));
  const p = (await r.json()).query?.pages?.[0] || {};
  const w = p.revisions?.[0]?.slots?.main?.content || '';
  let nicknames = clean(field(w, ['nicknames', 'nickname']));
  const motto = clean(field(w, ['motto', 'mottoes']), false)[0] || null;
  if (!nicknames.length && p.pageprops?.wikibase_item) {
    const id = p.pageprops.wikibase_item;
    const e = (await (await f(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${id}`)).json()).entities?.[id] || {};
    nicknames = (e.claims?.P1449 || []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v && (!v.language || v.language === 'en')).map((v) => v.text);
  }
  // "Scenic City (official)" -> prefer one marked official; drop pure abbreviations (AVL, Chatt) for hero copy
  const heroable = nicknames.filter((n) => /\s/.test(n) || /^(the\s)?[A-Z][a-z]+ City$/.test(n));
  return { title: p.title || title, nicknames, heroable, motto };
}
module.exports = { placeNickname };
if (require('./lib.cjs').isMain(module)) {
  const a = process.argv.slice(2); const q = a.filter((x) => x !== '--json').join(' ');
  placeNickname(q).then((r) => console.log(a.includes('--json') ? JSON.stringify(r, null, 2) : `${r.title}: nicknames=${JSON.stringify(r.nicknames)} heroable=${JSON.stringify(r.heroable)} motto=${JSON.stringify(r.motto)}`)).catch((e) => { console.error('error:', e.message); process.exitCode = 1; });
}
