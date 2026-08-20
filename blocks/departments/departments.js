import { applySelfColorScheme } from '../../scripts/utils/color-scheme.js';

export default function init(el) {
  const rows = [...el.querySelectorAll(':scope > div')];
  if (rows.length < 1) return;

  const cells = [...rows[0].querySelectorAll(':scope > div')];
  const leftCell = cells[0];
  const rightCell = cells[1];

  // ── Left: text content ──────────────────────────────────────────────────
  const left = document.createElement('div');
  left.className = 'dept-left';

  if (leftCell) {
    // Style heading
    const heading = leftCell.querySelector('h2');
    if (heading) heading.className = 'dept-heading';

    // Style description paragraphs (non-link ones)
    leftCell.querySelectorAll('p:not(:has(a))').forEach((p) => {
      p.className = 'dept-desc';
    });

    // Convert link paragraphs into a CTA row
    const linkParas = [...leftCell.querySelectorAll('p:has(a)')];
    if (linkParas.length) {
      const ctas = document.createElement('div');
      ctas.className = 'dept-ctas';
      linkParas.forEach((p, i) => {
        const a = p.querySelector('a');
        if (!a) return;
        a.className = i === 0 ? 'btn dept-btn-primary' : 'btn dept-btn-outline';
        ctas.append(a);
      });
      linkParas.forEach((p) => p.remove());
      leftCell.append(ctas);
    }

    left.append(...leftCell.childNodes);
  }

  // ── Right: department cards ─────────────────────────────────────────────
  const grid = document.createElement('div');
  grid.className = 'dept-grid';

  if (rightCell) {
    // Group: each department starts with a <picture> and is followed by an
    // <h3> and an optional <p><a> link. Walk children and collect groups.
    const children = [...rightCell.children];
    let current = null;

    children.forEach((child) => {
      const tag = child.tagName.toLowerCase();

      if (tag === 'picture' || (tag === 'p' && child.querySelector('picture'))) {
        // Start a new group
        current = { picture: child.querySelector('picture') || child, h3: null, link: null };
      } else if (tag === 'h3' && current) {
        current.h3 = child;
      } else if (tag === 'p' && current) {
        const a = child.querySelector('a');
        if (a) current.link = a.href;
        // If we've seen an h3, the group is complete — flush it
        if (current.h3) {
          grid.append(buildCard(current));
          current = null;
        }
      }
    });

    // Flush any trailing group without a link paragraph
    if (current?.h3) grid.append(buildCard(current));
  }

  el.innerHTML = '';
  el.append(left, grid);

  // --secondary (default bg) and --accent (hover bg) are both site-specific
  // with no guaranteed contrast to the assumed text color — recompute on
  // every bg change (initial render, hover, focus).
  const primaryBtn = el.querySelector('.dept-btn-primary');
  if (primaryBtn) {
    const refreshBtnScheme = () => applySelfColorScheme(primaryBtn);
    refreshBtnScheme();
    ['mouseenter', 'mouseleave', 'focus', 'blur'].forEach((evt) => {
      primaryBtn.addEventListener(evt, refreshBtnScheme);
    });
  }
}

function buildCard({ picture, h3, link }) {
  const card = document.createElement(link ? 'a' : 'div');
  card.className = 'dept-card';
  if (link) {
    card.href = link;
    card.setAttribute('aria-label', h3?.textContent?.trim() || '');
  }

  if (picture) {
    picture.className = 'dept-card-icon';
    card.append(picture);
  }

  if (h3) {
    const label = document.createElement('span');
    label.className = 'dept-card-label';
    label.textContent = h3.textContent.trim();
    card.append(label);
  }

  return card;
}
