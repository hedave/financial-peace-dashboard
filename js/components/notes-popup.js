import { el } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import { getActiveNotesBoardId } from '../pages/notes.js';

/**
 * Quick sticky access from sidebar — last Notes board viewed, else first board.
 */
export function showNotesPopup() {
  const boards = store.getNoteBoards();
  if (!boards.length) {
    showToast('No notes board yet', 'info');
    return;
  }
  const preferredId = getActiveNotesBoardId();
  const board = boards.find(b => b.id === preferredId) || boards[0];

  const list = el('div', { className: 'quick-sticky-list' });

  function paint() {
    const b = store.getNoteBoards().find(x => x.id === board.id) || store.getNoteBoards()[0];
    list.innerHTML = '';
    if (!b?.stickies?.length) {
      list.appendChild(el('p', { className: 'tx-form-hint' }, 'No stickies yet — add one below.'));
      return;
    }
    b.stickies.slice(0, 12).forEach(n => {
      const preview = (n.title || n.text || 'Empty sticky').trim().slice(0, 80);
      list.appendChild(el('button', {
        type: 'button',
        className: `quick-sticky-item sticky-${n.color || 'yellow'}`,
        onClick: () => {
          modal.close();
          window.appNavigate('notes');
        },
      },
        n.title ? el('strong', {}, n.title) : null,
        el('span', {}, preview),
      ));
    });
  }

  paint();

  const modal = showModal({
    title: 'Quick notes',
    body: el('div', { className: 'notes-popup-body' },
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:0.75rem' },
        `Board: ${board.title} · tap a sticky to open the full board`,
      ),
      list,
    ),
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-accent',
        onClick: () => {
          store.addStickyNote(board.id, { text: '' });
          showToast('Sticky added');
          paint();
          window.appRefresh();
        },
      }, '+ Sticky'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          modal.close();
          window.appNavigate('notes');
        },
      }, 'Open board'),
    ],
  });
  modal.modal.classList.add('modal-wide', 'modal-notes');
}
