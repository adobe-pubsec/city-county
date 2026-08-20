import { setColorScheme } from '../../scripts/utils/color-scheme.js';

export { getColorScheme, setColorScheme, applySelfColorScheme } from '../../scripts/utils/color-scheme.js';

async function handleBackground(background, section) {
  delete section.dataset.background;

  // Images
  const isMedia = background.startsWith('http');
  if (isMedia) {
    const mediaUrl = new URL(background, window.location.href);
    // No MP4 support
    if (mediaUrl.pathname.endsWith('.mp4')) return;
    const { createPicture } = await import('../../scripts/utils/picture.js');
    const pic = createPicture({ src: mediaUrl.href });
    section.classList.add('has-background');
    pic.classList.add('section-background');
    section.prepend(pic);
    return;
  }

  // Color
  const BRAND_COLORS = ['primary', 'secondary', 'accent'];
  if (BRAND_COLORS.includes(background)) {
    section.style.backgroundColor = `var(--${background})`;
  } else if (background.startsWith('color-token')) {
    section.style.backgroundColor = `var(${background.replace('color-token', '--color')})`;
  } else {
    section.style.backgroundColor = background;
  }

  setColorScheme(section);
}

async function handleLayout(text, section, type) {
  delete section.dataset[type];

  if (text === '0') return;
  if (type === 'grid') section.classList.add('grid');
  section.classList.add(`${type}-${text}`);
}

/**
 * Splits a section's content into two columns at the point marked by a
 * `column-separator` block, sized according to a "a/b" ratio (e.g. "50/50").
 */
function handleColumns(ratio, section) {
  delete section.dataset.columns;

  const groups = [...section.children];
  const sepGroupIdx = groups.findIndex((g) => g.querySelector(':scope > .column-separator'));
  if (sepGroupIdx === -1) return;

  const sepGroup = groups[sepGroupIdx];
  const separator = sepGroup.querySelector(':scope > .column-separator');
  const sepChildren = [...sepGroup.children];
  const sepIdx = sepChildren.indexOf(separator);
  const before = sepChildren.slice(0, sepIdx);
  const after = sepChildren.slice(sepIdx + 1);
  separator.remove();

  const col1 = document.createElement('div');
  col1.className = 'column';
  const col2 = document.createElement('div');
  col2.className = 'column';

  groups.slice(0, sepGroupIdx).forEach((g) => col1.append(g));
  if (before.length) {
    const beforeWrap = document.createElement('div');
    beforeWrap.className = sepGroup.className;
    before.forEach((c) => beforeWrap.append(c));
    col1.append(beforeWrap);
  }
  if (after.length) {
    const afterWrap = document.createElement('div');
    afterWrap.className = sepGroup.className;
    after.forEach((c) => afterWrap.append(c));
    col2.append(afterWrap);
  }
  groups.slice(sepGroupIdx + 1).forEach((g) => col2.append(g));
  sepGroup.remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'section-columns';
  const [a, b] = ratio.split('/');
  if (a && b) {
    wrapper.style.setProperty('--column-a', `${parseFloat(a) || 1}fr`);
    wrapper.style.setProperty('--column-b', `${parseFloat(b) || 1}fr`);
  }
  wrapper.append(col1, col2);
  section.append(wrapper);
}

export default async function init(section) {
  const {
    grid,
    gap,
    spacing,
    container,
    layout,
    background,
    columns,
  } = section.dataset;
  if (grid) handleLayout(grid, section, 'grid');
  if (gap) handleLayout(gap, section, 'gap');
  if (spacing) handleLayout(spacing, section, 'spacing');
  if (container) handleLayout(container, section, 'container');
  if (background) await handleBackground(background, section);
  if (layout) handleLayout(layout, section, 'layout');
  if (columns) handleColumns(columns, section);
}
