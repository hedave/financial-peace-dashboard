import { el } from '../utils.js';
import { store } from '../store.js';

function formatNotesStatus(updatedAt) {
  if (!updatedAt) return 'Start typing — saves automatically';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return 'Saved';
  return `Saved ${date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

export function createNotesEditor({ rows = 16, placeholder = 'Reminders, plans, money thoughts…' } = {}) {
  const textarea = el('textarea', {
    className: 'notes-editor',
    rows: String(rows),
    placeholder,
  });
  textarea.value = store.getNotes();

  const statusEl = el('div', { className: 'notes-status' }, formatNotesStatus(store.getNotesUpdatedAt()));
  let debounceTimer = null;

  function persist() {
    store.setNotes(textarea.value);
    statusEl.textContent = formatNotesStatus(store.getNotesUpdatedAt());
  }

  textarea.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    statusEl.textContent = 'Saving…';
    debounceTimer = setTimeout(persist, 600);
  });

  textarea.addEventListener('blur', () => {
    clearTimeout(debounceTimer);
    persist();
  });

  return {
    textarea,
    statusEl,
    persist,
    focus: () => textarea.focus(),
  };
}