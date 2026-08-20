/**
 * Converts a CSS color value to RGB values
 * @param {string} color - CSS color value (hex, rgb, rgba, hsl, hsla, or named color)
 * @returns {Object|null} Object with r, g, b values (0-255) or null if invalid
 */
function parseColor(section) {
  if (!section) return null;

  const computedBg = getComputedStyle(section).backgroundColor;
  const rgbMatch = computedBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!rgbMatch) return null;
  return {
    r: parseInt(rgbMatch[1], 10),
    g: parseInt(rgbMatch[2], 10),
    b: parseInt(rgbMatch[3], 10),
  };
}

function getRelativeLuminance({ r, g, b }) {
  // Convert to sRGB
  const rsRGB = r / 255;
  const gsRGB = g / 255;
  const bsRGB = b / 255;

  // Apply gamma correction
  const rLinear = rsRGB <= 0.03928 ? rsRGB / 12.92 : ((rsRGB + 0.055) / 1.055) ** 2.4;
  const gLinear = gsRGB <= 0.03928 ? gsRGB / 12.92 : ((gsRGB + 0.055) / 1.055) ** 2.4;
  const bLinear = bsRGB <= 0.03928 ? bsRGB / 12.92 : ((bsRGB + 0.055) / 1.055) ** 2.4;

  // Calculate relative luminance
  return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
}

/**
 * Determines if a CSS color value is light or dark
 * @param {string} color - CSS color value
 * @param {number} threshold - Luminance threshold (default: 0.5)
 * @returns {boolean} true if light, false if dark, null if invalid color
 */
export function getColorScheme(section) {
  const rgb = parseColor(section);
  if (!rgb) return null;

  return getRelativeLuminance(rgb) > 0.5 ? 'light-scheme' : 'dark-scheme';
}

/**
 * Reads a section's own rendered background color and tags its direct
 * children light-scheme/dark-scheme accordingly — for a container that has
 * a bg color but whose colored text lives in separate child elements (e.g.
 * a calendar date chip: bg on the chip, text in day/month spans).
 */
export function setColorScheme(section) {
  const scheme = getColorScheme(section);
  if (!scheme) return;
  section.querySelectorAll(':scope > *').forEach((el) => {
    // Reset any pre-made color schemes
    el.classList.remove('light-scheme', 'dark-scheme');
    el.classList.add(scheme);
  });
}

/**
 * Like setColorScheme, but for a single element that carries both its own
 * background (e.g. a pill/chip/button colored with --primary/--secondary/
 * --accent) and its own text — puts the light-scheme/dark-scheme class on
 * the element itself rather than its children. A no-op (safe) on elements
 * with a transparent/no background (e.g. outline buttons).
 */
export function applySelfColorScheme(el) {
  const scheme = getColorScheme(el);
  if (!scheme) return;
  el.classList.remove('light-scheme', 'dark-scheme');
  el.classList.add(scheme);
}

/**
 * Classifies a raw CSS color value (e.g. 'var(--accent)') as light-scheme
 * or dark-scheme on its own — no rendered background needed. For cases
 * where text sits on something we can't sample (a photo, a fixed-color
 * overlay) but still need to know whether the *color itself* is dark
 * enough to risk disappearing against a known-dark backdrop.
 */
export function getColorSchemeForValue(colorValue) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute; visibility:hidden; pointer-events:none;';
  probe.style.backgroundColor = colorValue;
  document.body.append(probe);
  const scheme = getColorScheme(probe);
  probe.remove();
  return scheme;
}
