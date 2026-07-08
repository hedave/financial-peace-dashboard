import { el } from '../utils.js';
import { store } from '../store.js';
import { showToast, confirmDialog } from '../components/modal.js';
import { createNotesEditor } from '../components/notes-editor.js';
import { showNotesPopup } from '../components/notes-popup.js';

export function renderNotes(container) {
  const editor = createNotesEditor({ rows: 24 });

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Notes'),
    el('p', {}, 'Private scratchpad for reminders, plans, and money thoughts')
  ));

  container.appendChild(el('div', { className: 'card notes-card section' },
    el('div', { className: 'notes-toolbar' },
      el('span', { className: 'notes-toolbar-label' }, 'Your notes'),
      el('div', { className: 'btn-group' },
        el('button', {
          className: 'btn btn-secondary btn-sm',
          onClick: () => showNotesPopup(),
        }, 'Pop-out'),
        el('button', {
          className: 'btn btn-secondary btn-sm',
          onClick: () => {
            editor.persist();
            const blob = new Blob([store.getNotes()], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'financial-peace-notes.txt';
            a.click();
            URL.revokeObjectURL(url);
            showToast('Notes downloaded');
          },
        }, 'Download'),
        el('button', {
          className: 'btn btn-danger btn-sm',
          onClick: () => {
            confirmDialog('Clear Notes', 'Delete everything in your notes? This cannot be undone.', () => {
              store.clearNotes();
              editor.textarea.value = '';
              editor.statusEl.textContent = 'Start typing — saves automatically';
              showToast('Notes cleared');
            });
          },
        }, 'Clear'),
      ),
    ),
    editor.textarea,
    el('div', { className: 'notes-footer' },
      editor.statusEl,
      el('span', { className: 'notes-hint' }, `${editor.textarea.value.length.toLocaleString()} characters`),
    ),
  ));

  editor.textarea.addEventListener('input', () => {
    const hint = container.querySelector('.notes-hint');
    if (hint) hint.textContent = `${editor.textarea.value.length.toLocaleString()} characters`;
  });

  editor.focus();
}