import { getConfig, getMetadata } from '../../scripts/ak.js';
import { loadFragment } from '../fragment/fragment.js';
import { setColorScheme } from '../section-metadata/section-metadata.js';

const { locale, locales: siteLocales } = getConfig();
// Derived from scripts.js locales config — add/remove locales there, not here
const LOCALE_PREFIXES = Object.keys(siteLocales).filter((p) => p !== '');

const HEADER_PATH = '/fragments/nav/header';
const HEADER_ACTIONS = [
  '/tools/widgets/scheme',
  '/tools/widgets/language',
  '/tools/widgets/toggle',
];

function closeAllMenus() {
  const openMenus = document.body.querySelectorAll('header .is-open');
  for (const openMenu of openMenus) {
    openMenu.classList.remove('is-open');
  }
}

function docClose(e) {
  if (e.target.closest('header')) return;
  closeAllMenus();
}

function toggleMenu(menu) {
  const isOpen = menu.classList.contains('is-open');
  closeAllMenus();
  if (isOpen) {
    document.removeEventListener('click', docClose);
    return;
  }

  // Setup the global close event
  document.addEventListener('click', docClose);
  menu.classList.add('is-open');
}

function getBasePath() {
  const { pathname } = window.location;
  for (const prefix of LOCALE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { basePath: pathname.slice(prefix.length) || '/', activePrefix: prefix };
    }
  }
  return { basePath: pathname, activePrefix: '' };
}

async function buildLanguageMenu(section) {
  let menu = section.querySelector('.language.menu');
  if (menu) return menu;

  // Always load the base (English) languages fragment
  const fragment = await loadFragment(`${HEADER_PATH}/languages`);

  // Make each link point to the current page in its locale
  const { basePath, activePrefix } = getBasePath();
  fragment.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href');
    const linkPrefix = raw === '/' ? '' : raw.replace(/\/$/, '');
    a.href = linkPrefix + basePath;
    if (linkPrefix === activePrefix) {
      a.setAttribute('aria-current', 'true');
    }
  });

  const content = document.createElement('div');
  content.className = 'block-content';
  menu = document.createElement('div');
  menu.className = 'language menu';
  menu.append(fragment);
  content.append(menu);
  section.append(content);
  return menu;
}

function decorateLanguage(btn) {
  const section = btn.closest('.section');
  btn.addEventListener('click', async () => {
    await buildLanguageMenu(section);
    toggleMenu(section);
  });
}

function decorateLanguageLink(section) {
  // Handles plain <a> language links (not action-wrapper buttons)
  const link = [...section.querySelectorAll('a')].find(
    (a) => /language/i.test(a.textContent.trim()),
  );
  if (!link) return;
  // Already handled by decorateAction (action-wrapper)
  if (link.closest('.action-wrapper')) return;

  link.addEventListener('click', async (e) => {
    e.preventDefault();
    await buildLanguageMenu(section);
    toggleMenu(section);
  });
}

function decorateScheme(btn) {
  btn.addEventListener('click', async () => {
    const { body } = document;

    let currPref = localStorage.getItem('color-scheme');
    if (!currPref) {
      currPref = matchMedia('(prefers-color-scheme: dark)')
        .matches ? 'dark-scheme' : 'light-scheme';
    }

    const theme = currPref === 'dark-scheme'
      ? { add: 'light-scheme', remove: 'dark-scheme' }
      : { add: 'dark-scheme', remove: 'light-scheme' };

    body.classList.remove(theme.remove);
    body.classList.add(theme.add);
    localStorage.setItem('color-scheme', theme.add);
    // Re-calculatie section schemes
    const sections = document.querySelectorAll('.section');
    for (const section of sections) {
      setColorScheme(section);
    }
  });
}

function decorateNavToggle(btn) {
  btn.addEventListener('click', () => {
    const header = document.body.querySelector('header');
    if (header) header.classList.toggle('is-mobile-open');
  });
}

async function decorateAction(header, pattern) {
  const link = header.querySelector(`[href*="${pattern}"]`);
  if (!link) return;

  const icon = link.querySelector('.icon');
  const text = link.textContent;
  const btn = document.createElement('button');
  if (icon) btn.append(icon);
  if (text) {
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = text;
    btn.append(textSpan);
  }
  const wrapper = document.createElement('div');
  wrapper.className = `action-wrapper ${icon.classList[1].replace('icon-', '')}`;
  wrapper.append(btn);
  link.parentElement.parentElement.replaceChild(wrapper, link.parentElement);

  if (pattern === '/tools/widgets/language') decorateLanguage(btn);
  if (pattern === '/tools/widgets/scheme') decorateScheme(btn);
  if (pattern === '/tools/widgets/toggle') decorateNavToggle(btn);
}

function decorateMenu() {
  // TODO: finish single menu support
  return null;
}

function decorateMegaMenu(li) {
  const menu = li.querySelector('.fragment-content');
  if (!menu) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'mega-menu';
  wrapper.append(menu);
  li.append(wrapper);
  return wrapper;
}

function decorateNavItem(li) {
  li.classList.add('main-nav-item');
  const link = li.querySelector(':scope > p > a');
  if (link) link.classList.add('main-nav-link');
  const menu = decorateMegaMenu(li) || decorateMenu(li);
  if (!(menu || link)) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    toggleMenu(li);
  });
}

function decorateBrandSection(section) {
  section.classList.add('brand-section');
  const brandLink = section.querySelector('a');

  // Replace any existing icon with the city logo
  const existingIcon = brandLink.querySelector('img, svg, .icon');
  const logo = document.createElement('img');
  logo.src = '/img/harrisonburg-logo.png';
  logo.alt = 'City of Harrisonburg';
  logo.className = 'brand-logo';
  if (existingIcon) {
    existingIcon.replaceWith(logo);
  } else {
    brandLink.prepend(logo);
  }

  // Wrap remaining text node as brand-text
  const textNode = [...brandLink.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  if (textNode) {
    const span = document.createElement('span');
    span.className = 'brand-text';
    span.textContent = textNode.textContent.trim();
    textNode.replaceWith(span);
  }

  // Mobile hamburger toggle
  const toggle = document.createElement('button');
  toggle.className = 'mobile-nav-toggle';
  toggle.setAttribute('aria-label', 'Open navigation menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<span class="material-symbols-outlined">menu</span>';
  toggle.addEventListener('click', () => {
    const header = document.body.querySelector('header');
    const isOpen = header.classList.toggle('is-mobile-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.querySelector('.material-symbols-outlined').textContent = isOpen ? 'close' : 'menu';
  });
  section.querySelector('.default-content').append(toggle);
}

function decorateNavSection(section) {
  section.classList.add('main-nav-section');
  const navContent = section.querySelector('.default-content');
  const navList = section.querySelector('ul');
  if (!navList) return;
  navList.classList.add('main-nav-list');

  const nav = document.createElement('nav');
  nav.append(navList);
  navContent.append(nav);

  const mainNavItems = section.querySelectorAll('nav > ul > li');
  for (const navItem of mainNavItems) {
    decorateNavItem(navItem);
  }
}

async function decorateActionSection(section) {
  section.classList.add('actions-section');
  decorateLanguageLink(section);
}

async function decorateHeader(fragment) {
  const sections = fragment.querySelectorAll(':scope > .section');
  if (sections[0]) decorateBrandSection(sections[0]);
  if (sections[1]) decorateNavSection(sections[1]);
  if (sections[2]) decorateActionSection(sections[2]);

  for (const pattern of HEADER_ACTIONS) {
    decorateAction(fragment, pattern);
  }
}

/**
 * loads and decorates the header
 * @param {Element} el The header element
 */
export default async function init(el) {
  const headerMeta = getMetadata('header');
  const path = headerMeta || HEADER_PATH;
  try {
    const fragment = await loadFragment(`${locale.prefix}${path}`);
    fragment.classList.add('header-content');
    await decorateHeader(fragment);
    el.append(fragment);
  } catch (e) {
    throw Error(e);
  }
}
