import { loadArea, setConfig } from './ak.js';
import applySiteTheme from './utils/site-theme.js';
import buildBreadcrumbs from './utils/breadcrumbs.js';

const hostnames = ['authorkit.dev'];

const locales = {
  '': { lang: 'en' },
  '/de': { lang: 'de' },
  '/es': { lang: 'es' },
  '/fr': { lang: 'fr' },
  '/hi': { lang: 'hi' },
  '/ja': { lang: 'ja' },
  '/zh': { lang: 'zh' },
};

const linkBlocks = [
  { fragment: '/fragments/' },
  { schedule: '/schedules/' },
  { youtube: 'https://www.youtube' },
];

// Blocks with self-managed styles
const components = ['fragment', 'schedule'];

// How to decorate an area before loading it
const decorateArea = ({ area = document }) => {
  const eagerLoad = (parent, selector) => {
    const img = parent.querySelector(selector);
    if (!img) return;
    img.removeAttribute('loading');
    img.fetchPriority = 'high';
  };

  eagerLoad(area, 'img');
};

export async function loadPage() {
  setConfig({ hostnames, locales, linkBlocks, components, decorateArea });
  // Must resolve before decoration starts: contrast-aware components
  // (buttons, pills, cards — see scripts/utils/color-scheme.js) read the
  // site's --primary/--secondary/--accent via getComputedStyle the moment
  // they're decorated, so the metadata.json override has to already be
  // in <head> or they'll compute contrast against the pre-override default
  // colors and never re-check.
  await applySiteTheme();
  await loadArea();

  // Global, for any interior page — see scripts/utils/breadcrumbs.js
  await buildBreadcrumbs();

  // Load template JS if a template is specified (AK only loads template CSS)
  const templateMeta = document.head.querySelector('meta[name="template"]');
  if (templateMeta) {
    const template = templateMeta.content.replaceAll(' ', '-').toLowerCase();
    try {
      const mod = await import(`../templates/${template}/${template}.js`);
      if (mod.default) mod.default();
    } catch { /* no JS for this template */ }
  }
}
await loadPage();


/**
 * Sa11y Accessibility Checker - Sidekick Toggle Plugin
 * Injects/removes Sa11y when the Accessibility button is clicked.
 * https://sa11y.netlify.app/
 */
const SA11Y_VERSION = '4';
const SA11Y_CSS_URL = `https://cdn.jsdelivr.net/gh/ryersondmp/sa11y@${SA11Y_VERSION}/dist/css/sa11y.min.css`;
const SA11Y_LANG_URL = `https://cdn.jsdelivr.net/gh/ryersondmp/sa11y@${SA11Y_VERSION}/dist/js/lang/en.umd.js`;
const SA11Y_JS_URL = `https://cdn.jsdelivr.net/gh/ryersondmp/sa11y@${SA11Y_VERSION}/dist/js/sa11y.umd.min.js`;

let sa11yActive = false;
let sa11yLoaded = false;

function injectCSS(url, id) {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = url;
    link.onload = resolve;
    link.onerror = () => reject(new Error('Failed to load Sa11y CSS'));
    document.head.appendChild(link);
  });
}

function injectScript(url, id) {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const script = document.createElement('script');
    script.id = id;
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Sa11y script'));
    document.head.appendChild(script);
  });
}

async function loadSa11y() {
  if (sa11yLoaded) return;

  await injectCSS(SA11Y_CSS_URL, 'sa11y-injected-styles');
  await injectScript(SA11Y_LANG_URL, 'sa11y-lang-script');
  await new Promise((r) => { setTimeout(r, 100); });
  await injectScript(SA11Y_JS_URL, 'sa11y-main-script');

  // Wait for Sa11y to be available
  await new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts += 1;
      if (window.Sa11y && window.Sa11yLangEn) resolve();
      else if (attempts > 50) reject(new Error('Sa11y load timeout'));
      else setTimeout(check, 100);
    };
    check();
  });

  window.Sa11y.Lang.addI18n(window.Sa11yLangEn.strings);
  sa11yLoaded = true;
}

async function startSa11y() {
  if (sa11yActive) return;

  try {
    await loadSa11y();

    window.sa11yInstance = new window.Sa11y.Sa11y({
      checkRoot: 'main, [role="main"], .main-content, body',
      containerIgnore: '.sidekick-library, .hlx-sk, #hlx-sk, [data-aue-type], .aue-edit',
      showGoodLinkButton: true,
      showHinPageOutline: true,
      detectPageLanguage: true,
      panelPosition: 'left',
    });

    sa11yActive = true;
    // eslint-disable-next-line no-console
    console.log('[Sa11y] Started');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Sa11y] Error starting:', error);
  }
}

function stopSa11y() {
  if (!sa11yActive) return;

  try {
    if (window.sa11yInstance) {
      try { window.sa11yInstance.destroy(); } catch (e) { /* ignore */ }
      delete window.sa11yInstance;
    }

    // Remove Sa11y UI elements (keep scripts/styles loaded for re-use)
    [
      '#sa11y-container', '#sa11y-panel', '#sa11y-toast-container',
      '#sa11y-control-panel', '.sa11y-annotation', '.sa11y-instance',
    ].forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        try { el.remove(); } catch (e) { /* ignore */ }
      });
    });

    // Remove Sa11y custom elements (web components with shadow DOM)
    [
      'sa11y-control-panel', 'sa11y-panel', 'sa11y-annotation',
      'sa11y-heading-label', 'sa11y-heading-anchor', 'sa11y-tooltips',
    ].forEach((tagName) => {
      document.querySelectorAll(tagName).forEach((el) => {
        try { el.remove(); } catch (e) { /* ignore */ }
      });
    });

    sa11yActive = false;
    // eslint-disable-next-line no-console
    console.log('[Sa11y] Stopped');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Sa11y] Error stopping:', error);
  }
}

function toggleSa11y() {
  if (sa11yActive) {
    stopSa11y();
  } else {
    startSa11y();
  }
}

// Listen for sidekick sa11y event
function initSa11ySidekick() {
  const sk = document.querySelector('aem-sidekick');
  if (sk) {
    sk.addEventListener('custom:sa11y', toggleSa11y);
  } else {
    document.addEventListener('sidekick-ready', () => {
      document.querySelector('aem-sidekick')?.addEventListener('custom:sa11y', toggleSa11y);
    }, { once: true });
  }
}

initSa11ySidekick();

(function da() {
  const { searchParams } = new URL(window.location.href);
  const hasPreview = searchParams.has('dapreview');
  if (hasPreview) import('../tools/da/da.js').then((mod) => mod.default(loadPage));
  const hasQE = searchParams.has('quick-edit');
  if (hasQE) import('../tools/quick-edit/quick-edit.js').then((mod) => mod.default());
}());
