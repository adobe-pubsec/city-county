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
}
