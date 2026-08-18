const SITE_CONFIG_PATH = '/metadata.json';

/**
 * Matches a metadata.json row's url pattern against the current pathname.
 * Only a single trailing '/**' wildcard is supported (e.g. '/blueprint/**').
 * @param {string} pattern
 * @param {string} pathname
 */
function matchesPattern(pattern, pathname) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }
  return pathname === pattern;
}

async function loadSiteConfig() {
  try {
    const resp = await fetch(SITE_CONFIG_PATH);
    if (!resp.ok) return {};
    const { data = [] } = await resp.json();
    const { pathname } = window.location;
    return data.find((row) => matchesPattern(row.url, pathname)) || {};
  } catch {
    return {};
  }
}

let configPromise;

/**
 * Fetches (once) and returns the metadata.json row matching the current site,
 * e.g. { url, 'site-base', 'color-primary', 'color-accent', 'color-secondary' }.
 * @returns {Promise<object>}
 */
export default function getSiteConfig() {
  configPromise ??= loadSiteConfig();
  return configPromise;
}

/**
 * @returns {Promise<string>} the site-base path (e.g. '/blueprint'), or '' if unset
 */
export async function getSiteBase() {
  const config = await getSiteConfig();
  return config['site-base'] || '';
}
