import { getSiteBase } from './site-config.js';

const TARGETS = {
  news: '/news-index.json',
  events: '/events-index.json',
};

/**
 * Resolves the query-index URL for a content section ('news' or 'events').
 * Both indices are shared and cross-tenant — see helix-query.yaml, where
 * `include` covers /blueprint/<section>/** and /sites/*<section>/** into
 * one flat file — so callers must filter the returned rows by site (see
 * filterBySite below).
 *
 * @param {string} section - 'news' or 'events'
 * @returns {string} Resolved index URL
 */
export function resolveIndexUrl(section) {
  return TARGETS[section];
}

/**
 * Filters rows from a shared, cross-tenant query-index down to just the
 * current site, using its site-base (from metadata.json — see site-config.js).
 * Fails open (returns all rows unfiltered) if no site-base can be resolved,
 * rather than risking an empty result for an unrecognized path.
 *
 * @param {Array<{path: string}>} rows
 * @returns {Promise<Array>} rows under the current site's base path
 */
export async function filterBySite(rows) {
  const siteBase = await getSiteBase();
  if (!siteBase) return rows;
  return rows.filter((row) => row.path === siteBase || row.path.startsWith(`${siteBase}/`));
}
