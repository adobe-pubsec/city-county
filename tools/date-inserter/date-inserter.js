/* eslint-disable import/no-unresolved */

import DA_SDK from 'https://da.live/nx/utils/sdk.js';

/**
 * Gets current date and time in ISO format (YYYY-MM-DDTHH:MM)
 * @returns {string} Current date and time in ISO format
 */
function getNowISO() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Formats date and optional time into ISO format
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {string} [time] - Optional time in HH:MM format
 * @returns {string} Formatted date/datetime string
 */
function formatDateTime(date, time) {
  if (time) {
    return `${date}T${time}`;
  }
  return date;
}

/**
 * Detects if running in standalone mode (not in DA iframe)
 * @returns {boolean} True if standalone
 */
function isStandalone() {
  return window.self === window.top;
}

/**
 * Mock actions for standalone testing
 */
const mockActions = {
  sendText: (text) => {
    // eslint-disable-next-line no-console
    console.log('sendText called with:', text);
    // eslint-disable-next-line no-alert
    alert(`Inserted: ${text}`);
  },
  closeLibrary: () => {
    // eslint-disable-next-line no-console
    console.log('closeLibrary called');
  },
};

/**
 * Inserts text and closes the library
 * @param {Object} actions - DA SDK actions
 * @param {string} text - Text to insert
 * @param {HTMLElement} feedback - Feedback element
 */
function insertText(actions, text, feedback) {
  if (!actions?.sendText) {
    feedback.textContent = 'Cannot insert: Editor not available';
    feedback.classList.add('error');
    feedback.classList.remove('success');
    return;
  }

  actions.sendText(text);
  feedback.textContent = 'Inserted!';
  feedback.classList.add('success');
  feedback.classList.remove('error');

  // Close library after short delay
  setTimeout(() => {
    actions.closeLibrary();
  }, 500);
}

/**
 * Main initialization function
 */
(async function init() {
  let actions;

  if (isStandalone()) {
    // eslint-disable-next-line no-console
    console.log('Date Inserter running in standalone mode (testing)');
    actions = mockActions;
  } else {
    const sdk = await DA_SDK;
    actions = sdk.actions;
  }

  const todayDisplay = document.getElementById('today-date');
  const insertTodayBtn = document.getElementById('insert-today-btn');
  const datePicker = document.getElementById('date-picker');
  const timePicker = document.getElementById('time-picker');
  const insertCustomBtn = document.getElementById('insert-custom-btn');
  const feedback = document.getElementById('feedback');

  // Display current date/time and update every minute
  function updateNowDisplay() {
    todayDisplay.textContent = getNowISO();
  }
  updateNowDisplay();
  setInterval(updateNowDisplay, 60000);

  // Insert current date/time on button click
  insertTodayBtn.addEventListener('click', () => {
    insertText(actions, getNowISO(), feedback);
  });

  // Update button state when inputs change
  function updateButtonState() {
    insertCustomBtn.disabled = !datePicker.value;
  }

  datePicker.addEventListener('input', updateButtonState);
  timePicker.addEventListener('input', updateButtonState);

  // Insert custom date/time on button click
  insertCustomBtn.addEventListener('click', () => {
    if (datePicker.value) {
      const formatted = formatDateTime(datePicker.value, timePicker.value);
      insertText(actions, formatted, feedback);
    }
  });

  // Allow pressing Enter to insert
  function handleEnter(e) {
    if (e.key === 'Enter' && datePicker.value) {
      e.preventDefault();
      const formatted = formatDateTime(datePicker.value, timePicker.value);
      insertText(actions, formatted, feedback);
    }
  }

  datePicker.addEventListener('keydown', handleEnter);
  timePicker.addEventListener('keydown', handleEnter);
}());
