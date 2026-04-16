import { getConfig } from '../ak.js';

/**
 * Resolves the query-index URL for a given content section ('news' or 'events'),
 * preferring a locale-specific index when one exists.
 *
 * For English (empty locale prefix) the default index is returned immediately
 * with no extra network request. For other locales a HEAD probe checks whether
 * /{locale}/{section}/query-index.json exists; on success that URL is returned,
 * otherwise falls back to the default /{section}/query-index.json.
 *
 * @param {string} section - e.g. 'news' or 'events'
 * @returns {Promise<string>} Resolved index URL
 */
export async function resolveIndexUrl(section) {
  const { locale } = getConfig();
  const prefix = locale?.prefix || '';
  const defaultUrl = `/${section}/query-index.json`;

  if (!prefix) return defaultUrl;

  const localizedUrl = `${prefix}/${section}/query-index.json`;
  try {
    const probe = await fetch(localizedUrl, { method: 'HEAD' });
    if (probe.ok) return localizedUrl;
  } catch {
    // Network error — fall through to default
  }
  return defaultUrl;
}
