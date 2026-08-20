export default function init(el) {
  const inner = el.querySelector(':scope > div');
  inner.classList.add('card-inner');
  const pic = el.querySelector('picture');
  if (pic) {
    // Picture is usually authored as its own <p> (a dedicated table row/
    // cell), but content can also land with it as a bare wrapping <div>
    // instead (e.g. pasted/rebuilt content) — handle both, otherwise a
    // bare-div picture is left unclassed and gets mistaken for the content
    // div below (which itself would then be left with no styling at all).
    const picWrap = pic.closest('p') || (pic.parentElement !== inner ? pic.parentElement : null);
    if (picWrap) {
      const picDiv = document.createElement('div');
      picDiv.className = 'card-picture-container';
      picDiv.append(pic);
      inner.insertAdjacentElement('afterbegin', picDiv);
      picWrap.remove();
    }
  }
  // Decorate content
  const con = inner.querySelector(':scope > div:not([class])');
  if (!con) return;
  con.classList.add('card-content-container');

  // Decorate CTA
  const ctaPara = inner.querySelector(':scope > div:last-of-type > p:last-of-type');
  if (!ctaPara) return;
  const cta = ctaPara.querySelector('a');
  if (!cta) return;
  const hashAware = el.classList.contains('hash-aware');
  if (hashAware) {
    cta.href = `${cta.getAttribute('href')}${window.location.hash}`;
  }
  ctaPara.classList.add('card-cta-container');
  inner.append(ctaPara);
}
