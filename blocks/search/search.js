export default function init(el) {
  const placeholder = el.querySelector('p')?.textContent?.trim()
    || 'Search city services, departments, news, and more...';

  el.innerHTML = '';

  const form = document.createElement('form');
  form.className = 'search-form';
  form.setAttribute('action', '/search');
  form.setAttribute('method', 'get');
  form.setAttribute('role', 'search');
  form.setAttribute('aria-label', 'Site search');

  form.innerHTML = `
    <div class="search-input-wrapper">
      <label class="search-label" for="search-input">Search</label>
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
        <span class="search-btn-label">Search</span>
      </button>
    </div>
  `;

  el.append(form);
}
