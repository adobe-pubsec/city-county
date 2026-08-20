import { getColorScheme, setColorScheme } from '../section-metadata/section-metadata.js';

function decorateCols(cols) {
  cols.forEach((col, idx) => {
    col.classList.add('col', `col-${idx + 1}`);
  });
}

function decorateRows(rows) {
  rows.forEach((row, idx) => {
    row.classList.add('row', `row-${idx + 1}`);
    decorateCols([...row.children]);
  });
}

export default function init(el) {
  const rows = [...el.children];
  decorateRows(rows);

  // --primary (card bg) is site-specific and has no guaranteed contrast
  // relationship with the hardcoded white text/icon — pick readable colors
  // off each card's actual rendered background instead.
  el.querySelectorAll('.col').forEach((col) => {
    setColorScheme(col);

    // The icon <picture> is authored inside a <p> (content tables wrap
    // images in a paragraph), so it's a grandchild, not a direct child —
    // setColorScheme's :scope > * only reaches the wrapping <p>. Apply the
    // same scheme directly to <picture> itself so the chip tint/icon
    // filter CSS (keyed off picture.light-scheme/.dark-scheme) can match.
    const scheme = getColorScheme(col);
    const picture = col.querySelector('picture');
    if (scheme && picture) {
      picture.classList.remove('light-scheme', 'dark-scheme');
      picture.classList.add(scheme);
    }
  });
}
