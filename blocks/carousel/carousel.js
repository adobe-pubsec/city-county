/*
 * Carousel Block — Section 508 / WCAG 2.1 AA compliant
 *
 * Authoring (DA Live table):
 * | Carousel            |                          |
 * |---------------------|--------------------------|
 * | [image]             | Caption for slide one    |
 * | [image]             | Caption for slide two    |
 * | [image]             | Caption for slide three  |
 *
 * The second column is optional. If omitted, the img alt attribute is used.
 *
 * Keyboard support:
 *   ArrowLeft / ArrowRight — previous / next slide
 *   Home / End             — first / last slide
 *   Tab                    — moves focus through controls
 *   Enter / Space          — activates focused control
 */

const CHEVRON_LEFT = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <polyline points="15 18 9 12 15 6" stroke="currentColor" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

const CHEVRON_RIGHT = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <polyline points="9 18 15 12 9 6" stroke="currentColor" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

// Visually-hidden utility
function srOnly(text) {
  const span = document.createElement('span');
  span.className = 'carousel-sr-only';
  span.textContent = text;
  return span;
}

function buildCarousel(slides, labelledById) {
  const total = slides.length;

  /* ── Root ──────────────────────────────────────────────────────────── */
  const root = document.createElement('section');
  root.setAttribute('aria-roledescription', 'carousel');
  root.setAttribute('aria-labelledby', labelledById);

  /* ── Screen-reader live region ─────────────────────────────────────── */
  const live = document.createElement('div');
  live.className = 'carousel-live';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  root.append(live);

  /* ── Stage (image area + overlaid controls) ────────────────────────── */
  const stage = document.createElement('div');
  stage.className = 'carousel-stage';

  /* Track */
  const track = document.createElement('div');
  track.className = 'carousel-track';
  track.setAttribute('aria-label', 'Slides');

  slides.forEach(({ picture, caption, alt }, i) => {
    const slide = document.createElement('figure');
    slide.className = 'carousel-slide';
    slide.setAttribute('role', 'group');
    slide.setAttribute('aria-roledescription', 'slide');
    slide.setAttribute('aria-label', `Slide ${i + 1} of ${total}`);
    slide.setAttribute('aria-hidden', i !== 0 ? 'true' : 'false');
    if (i !== 0) slide.inert = true;

    if (picture) {
      // Ensure meaningful alt text
      const img = picture.querySelector('img');
      if (img && !img.alt.trim()) img.alt = caption || `Slide ${i + 1}`;
      slide.append(picture);
    }

    track.append(slide);
  });

  stage.append(track);

  /* ── Prev / Next buttons ───────────────────────────────────────────── */
  const prevBtn = document.createElement('button');
  prevBtn.className = 'carousel-btn carousel-btn-prev';
  prevBtn.type = 'button';
  prevBtn.innerHTML = CHEVRON_LEFT;
  prevBtn.append(srOnly('Previous slide'));

  const nextBtn = document.createElement('button');
  nextBtn.className = 'carousel-btn carousel-btn-next';
  nextBtn.type = 'button';
  nextBtn.innerHTML = CHEVRON_RIGHT;
  nextBtn.append(srOnly('Next slide'));

  stage.append(prevBtn, nextBtn);

  /* ── Slide counter (visual) ────────────────────────────────────────── */
  const counter = document.createElement('div');
  counter.className = 'carousel-counter';
  counter.setAttribute('aria-hidden', 'true');
  counter.textContent = `1 / ${total}`;
  stage.append(counter);

  root.append(stage);

  /* ── Caption bar ───────────────────────────────────────────────────── */
  const captionBar = document.createElement('div');
  captionBar.className = 'carousel-caption-bar';
  const captionText = document.createElement('p');
  captionText.className = 'carousel-caption';
  captionBar.append(captionText);
  root.append(captionBar);

  /* ── Dot indicators ────────────────────────────────────────────────── */
  const dotsWrap = document.createElement('div');
  dotsWrap.className = 'carousel-dots';
  dotsWrap.setAttribute('role', 'group');
  dotsWrap.setAttribute('aria-label', 'Choose slide to display');

  const dots = slides.map((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'carousel-dot';
    dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
    dot.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    dotsWrap.append(dot);
    return dot;
  });

  root.append(dotsWrap);

  /* ── State & navigation ────────────────────────────────────────────── */
  let current = 0;
  const slideEls = [...track.querySelectorAll('.carousel-slide')];

  function goTo(index, focusBtn = null) {
    const next = ((index % total) + total) % total;

    // Deactivate current
    slideEls[current].setAttribute('aria-hidden', 'true');
    slideEls[current].inert = true;
    dots[current].setAttribute('aria-pressed', 'false');

    current = next;

    // Activate next
    slideEls[current].setAttribute('aria-hidden', 'false');
    slideEls[current].inert = false;
    dots[current].setAttribute('aria-pressed', 'true');

    // Translate track
    track.style.transform = `translateX(-${current * 100}%)`;

    // Update counter
    counter.textContent = `${current + 1} / ${total}`;

    // Update caption
    const cap = slides[current].caption;
    captionText.textContent = cap || '';
    captionBar.hidden = !cap;

    // Announce to screen readers
    const announcement = `Slide ${current + 1} of ${total}${cap ? ': ' + cap : ''}`;
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = announcement; });

    // Return focus to whichever button triggered the change
    if (focusBtn) focusBtn.focus();
  }

  /* Init first caption */
  const firstCap = slides[0].caption;
  captionText.textContent = firstCap || '';
  captionBar.hidden = !firstCap;

  /* Button listeners */
  prevBtn.addEventListener('click', () => goTo(current - 1, prevBtn));
  nextBtn.addEventListener('click', () => goTo(current + 1, nextBtn));

  /* Dot listeners */
  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => goTo(i, dot));
  });

  /* Keyboard navigation on the stage */
  stage.addEventListener('keydown', (e) => {
    const handled = {
      ArrowLeft: () => goTo(current - 1, prevBtn),
      ArrowRight: () => goTo(current + 1, nextBtn),
      Home: () => goTo(0, prevBtn),
      End: () => goTo(total - 1, nextBtn),
    }[e.key];
    if (handled) { e.preventDefault(); handled(); }
  });

  /* Touch / swipe */
  let touchStartX = 0;
  let touchStartY = 0;
  track.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  track.addEventListener('touchend', (e) => {
    const dx = touchStartX - e.changedTouches[0].clientX;
    const dy = Math.abs(touchStartY - e.changedTouches[0].clientY);
    if (Math.abs(dx) > 40 && dy < 60) {
      goTo(dx > 0 ? current + 1 : current - 1);
    }
  }, { passive: true });

  return root;
}

export default function init(el) {
  const rows = [...el.querySelectorAll(':scope > div')];

  // Parse authored slides from block rows
  const slides = rows.map((row) => {
    const cells = [...row.querySelectorAll(':scope > div')];
    const picture = cells[0]?.querySelector('picture') || null;
    const caption = cells[1]?.textContent.trim() || '';
    const alt = picture?.querySelector('img')?.alt?.trim() || '';
    return { picture, caption, alt };
  }).filter((s) => s.picture);

  if (!slides.length) return;

  // Create a unique ID for aria-labelledby pointing to a visually-hidden heading
  const labelId = `carousel-label-${Math.random().toString(36).slice(2, 7)}`;
  const hiddenLabel = document.createElement('h2');
  hiddenLabel.id = labelId;
  hiddenLabel.className = 'carousel-sr-only';
  hiddenLabel.textContent = el.dataset.label || 'Image gallery';

  el.innerHTML = '';
  el.append(hiddenLabel, buildCarousel(slides, labelId));
}
