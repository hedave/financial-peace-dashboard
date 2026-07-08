import { el } from '../utils.js';
import { showModal } from './modal.js';
import { createNotesEditor } from './notes-editor.js';

export function showNotesPopup() {
  const editor = createNotesEditor({ rows: 14 });

  const { close, modal } = showModal({
    title: 'Quick Notes',
    body: el('div', { className: 'notes-popup-body' },
      editor.textarea,
      editor.statusEl,
    ),
    footer: [
      el('button', {
        className: 'btn btn-secondary',
        onClick: function() {
          editor.persist();
          this.closest('.modal-backdrop').remove();
        },
      }, 'Close'),
      el('button', {
        className: 'btn btn-primary',
        onClick: () => {
          editor.persist();
          close();
          window.appNavigate('notes');
        },
      }, 'Open Full Page'),
    ],
    onClose: () => editor.persist(),
  });

  modal.classList.add('modal-wide', 'modal-notes');
  setTimeout(() => editor.focus(), 50);
}