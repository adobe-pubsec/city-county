// Shared helpers for the add-city-county-site scripts (SLICC Node: CommonJS only).
const path = require('path');

const UA_BOT = 'SLICC-city-county-demo/1.0 (https://github.com/adobe-pubsec/city-county)';
const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// fetch with a hard timeout so a slow host can never hang a live demo.
async function fetchT(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { redirect: 'follow', signal: ctl.signal, ...opts, headers: { 'User-Agent': UA_BOT, 'Api-User-Agent': UA_BOT, ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}
const getJson = async (url, opts, ms) => (await fetchT(url, opts, ms)).json();

// True when the file is executed directly (node x.cjs), false when require()d.
const isMain = (mod) => !!process.argv[1] && path.resolve(process.argv[1]) === mod.filename;

const slugify = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

module.exports = { UA_BOT, UA_BROWSER, fetchT, getJson, isMain, slugify };
