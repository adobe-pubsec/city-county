import { getConfig, getMetadata } from '../../scripts/ak.js';
import { loadFragment } from '../fragment/fragment.js';

const FOOTER_PATH = '/fragments/nav/footer';

function buildBrand(cell) {
  const brand = document.createElement('div');
  brand.className = 'footer-brand';

  // City logo (wrapped in white pill so it's legible on dark navy)
  const logoWrap = document.createElement('div');
  logoWrap.className = 'footer-logo-wrap';
  const logo = document.createElement('img');
  logo.src = '/img/harrisonburg-logo.png';
  logo.alt = 'City of Harrisonburg';
  logo.className = 'footer-logo';
  logoWrap.append(logo);
  brand.append(logoWrap);

  // Retain the name, address, phone paragraphs
  [...cell.querySelectorAll('p')].forEach((p) => {
    p.className = p.querySelector('strong') ? 'footer-brand-name' : 'footer-brand-detail';
    brand.append(p);
  });

  return brand;
}

function buildCol(cell) {
  const col = document.createElement('div');
  col.className = 'footer-col';

  const heading = cell.querySelector('strong');
  if (heading) {
    const btn = document.createElement('button');
    btn.className = 'footer-col-heading';
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = heading.textContent.trim();
    btn.addEventListener('click', () => {
      const open = col.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', String(open));
    });
    col.append(btn);
  }

  const ul = cell.querySelector('ul');
  if (ul) {
    const listWrap = document.createElement('div');
    listWrap.className = 'footer-col-list';
    listWrap.append(ul);
    col.append(listWrap);
  }

  return col;
}

function buildFooterNav(columnsBlock) {
  const nav = document.createElement('div');
  nav.className = 'footer-nav';

  const cells = [...columnsBlock.querySelectorAll('.col')];
  cells.forEach((cell, i) => {
    nav.append(i === 0 ? buildBrand(cell) : buildCol(cell));
  });

  return nav;
}

function buildBottom(legal, copyright) {
  const bottom = document.createElement('div');
  bottom.className = 'footer-bottom';

  // Copyright
  const copy = document.createElement('p');
  copy.className = 'footer-copyright';
  copy.innerHTML = copyright?.querySelector('p')?.innerHTML || '';
  bottom.append(copy);

  // Legal links
  const legalLinks = document.createElement('nav');
  legalLinks.className = 'footer-legal';
  legalLinks.setAttribute('aria-label', 'Legal');
  const ul = legal?.querySelector('ul');
  if (ul) legalLinks.append(ul);
  bottom.append(legalLinks);

  return bottom;
}

export default async function init(el) {
  const { locale } = getConfig();
  const footerMeta = getMetadata('footer');
  const path = footerMeta || FOOTER_PATH;

  try {
    const fragment = await loadFragment(`${locale.prefix}${path}`);
    const sections = [...fragment.querySelectorAll(':scope > .section')];

    // Last two sections are copyright and legal
    const copyright = sections.pop();
    const legal = sections.pop();

    // First section contains the columns footer-columns block
    const columnsBlock = sections[0]?.querySelector('.columns');

    const wrapper = document.createElement('div');
    wrapper.className = 'footer-content';

    if (columnsBlock) wrapper.append(buildFooterNav(columnsBlock));
    wrapper.append(buildBottom(legal, copyright));

    el.append(wrapper);
  } catch (e) {
    throw Error(e);
  }
}
