export default function init(el) {
  const paras = [...el.querySelectorAll('p')].map((p) => p.textContent.trim()).filter(Boolean);
  const placeholder = paras[0] || 'Search city services, departments, news, and more...';
  const btnLabel = paras[1] || 'Search';

  el.innerHTML = '';

  const form = document.createElement('form');
  form.className = 'search-form';
  form.setAttribute('action', '/search');
  form.setAttribute('method', 'get');
  form.setAttribute('role', 'search');
  form.setAttribute('aria-label', btnLabel);

  form.innerHTML = `
    <div class="search-input-wrapper">
      <label class="search-label" for="search-input">${btnLabel}</label>
      <div class="search-field">
        <span class="material-symbols-outlined search-icon" aria-hidden="true">search</span>
        <input
          type="search"
          id="search-input"
          name="q"
          placeholder="${placeholder}"
          class="search-input"
          autocomplete="off"
          spellcheck="false"
        >
      </div>
      <button type="submit" class="search-btn btn btn-primary">
        <span class="material-symbols-outlined" aria-hidden="true">search</span>
        <span class="search-btn-label">${btnLabel}</span>
      </button>
    </div>
  `;

  el.append(form);
}
