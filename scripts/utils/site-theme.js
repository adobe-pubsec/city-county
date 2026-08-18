import getSiteConfig from './site-config.js';

// metadata.json column -> CSS custom property (styles/styles.css :root)
const TOKEN_MAP = {
  'color-primary': '--primary',
  'color-accent': '--accent',
  'color-secondary': '--secondary',
};

/**
 * Reads color-primary/accent/secondary from the matching metadata.json row
 * and, if present, writes a <style> override into <head> so per-site colors
 * from da.live/.../sites/<site> skin this instance without editing styles.css.
 */
export default async function applySiteTheme() {
  const config = await getSiteConfig();
  const overrides = Object.entries(TOKEN_MAP)
    .filter(([key]) => config[key])
    .map(([key, token]) => `${token}: ${config[key]};`);
  if (!overrides.length) return;

  const style = document.createElement('style');
  style.id = 'site-theme';
  style.textContent = `:root { ${overrides.join(' ')} }`;
  document.head.append(style);
}
