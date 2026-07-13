import { el } from '../utils.js';
import { store } from '../store.js';
import { showToast, confirmDialog, showModal } from '../components/modal.js';

const STICKY_COLORS = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'pink', label: 'Pink' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'purple', label: 'Purple' },
  { id: 'orange', label: 'Orange' },
];

let activeBoardId = null;
const stickyTimers = new Map();

export function renderNotes(container) {
  const boards = store.getNoteBoards();
  if (!activeBoardId || !boards.some(b => b.id === activeBoardId)) {
    activeBoardId = boards[0]?.id || null;
  }
  const board = boards.find(b => b.id === activeBoardId) || boards[0];

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header notes-page-header' },
    el('div', {},
      el('h2', {}, 'Sticky notes'),
      el('p', {}, 'Multiple pages · add, color, and toss stickies like a light Miro board'),
    ),
    el('div', { className: 'notes-header-actions' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: () => {
          if (!board) return;
          store.addStickyNote(board.id, { title: '', text: '', color: 'yellow' });
          showToast('Sticky added');
          window.appRefresh();
        },
      }, '+ Sticky'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary btn-sm',
        onClick: () => {
          const title = window.prompt('Name for this notes page', 'Shopping');
          if (title == null) return;
          activeBoardId = store.addNoteBoard(title);
          showToast('Page added');
          window.appRefresh();
        },
      }, '+ Page'),
    ),
  ));

  // Page tabs
  const tabs = el('div', { className: 'sticky-board-tabs section' });
  boards.forEach(b => {
    const tab = el('button', {
      type: 'button',
      className: `sticky-board-tab${b.id === board?.id ? ' active' : ''}`,
      onClick: () => {
        activeBoardId = b.id;
        window.appRefresh();
      },
    }, b.title || 'Page');

    // Double-click to rename
    tab.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const next = window.prompt('Rename page', b.title);
      if (next == null) return;
      store.renameNoteBoard(b.id, next);
      window.appRefresh();
    });

    tabs.appendChild(tab);
  });

  if (board && boards.length > 1) {
    tabs.appendChild(el('button', {
      type: 'button',
      className: 'sticky-board-tab sticky-board-tab-danger',
      title: 'Delete this page',
      onClick: () => {
        confirmDialog(
          'Delete this page?',
          `Remove “${board.title}” and all its stickies?`,
          () => {
            store.deleteNoteBoard(board.id);
            activeBoardId = null;
            showToast('Page deleted');
            window.appRefresh();
          },
        );
      },
    }, '🗑'));
  }

  container.appendChild(tabs);
  container.appendChild(el('p', { className: 'sticky-board-hint' },
    'Tip: double-click a page tab to rename · stickies autosave · colors via 🎨',
  ));

  if (!board) {
    container.appendChild(el('div', { className: 'empty-state' },
      el('div', { className: 'empty-icon' }, '🗒️'),
      el('h3', {}, 'No boards yet'),
      el('p', {}, 'Add a page to start sticking notes.'),
    ));
    return;
  }

  const boardEl = el('div', { className: 'sticky-board', id: 'sticky-board' });

  if (!board.stickies?.length) {
    boardEl.appendChild(el('div', { className: 'sticky-board-empty' },
      el('p', {}, 'This page is empty.'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          store.addStickyNote(board.id);
          window.appRefresh();
        },
      }, '+ Add your first sticky'),
    ));
  } else {
    board.stickies.forEach(note => {
      boardEl.appendChild(renderSticky(board.id, note));
    });
  }

  container.appendChild(boardEl);
}

function renderSticky(boardId, note) {
  const color = note.color || 'yellow';
  const card = el('article', {
    className: `sticky-note sticky-${color}`,
    'data-note-id': note.id,
  });

  const titleIn = el('input', {
    type: 'text',
    className: 'sticky-note-title',
    placeholder: 'Title',
    value: note.title || '',
  });
  const bodyIn = el('textarea', {
    className: 'sticky-note-body',
    placeholder: 'Write something…',
    rows: '5',
  });
  bodyIn.value = note.text || '';

  const scheduleSave = () => {
    const key = note.id;
    clearTimeout(stickyTimers.get(key));
    stickyTimers.set(key, setTimeout(() => {
      store.patchStickyNote(boardId, note.id, {
        title: titleIn.value,
        text: bodyIn.value,
      });
    }, 400));
  };

  titleIn.addEventListener('input', scheduleSave);
  bodyIn.addEventListener('input', scheduleSave);
  titleIn.addEventListener('blur', scheduleSave);
  bodyIn.addEventListener('blur', scheduleSave);

  const colorBtn = el('button', {
    type: 'button',
    className: 'sticky-note-tool',
    title: 'Change color',
    onClick: (e) => {
      e.stopPropagation();
      openColorPicker(boardId, note, card);
    },
  }, '🎨');

  const delBtn = el('button', {
    type: 'button',
    className: 'sticky-note-tool sticky-note-del',
    title: 'Delete sticky',
    onClick: (e) => {
      e.stopPropagation();
      confirmDialog('Delete sticky?', 'This cannot be undone.', () => {
        store.deleteStickyNote(boardId, note.id);
        showToast('Sticky removed');
        window.appRefresh();
      });
    },
  }, '×');

  card.appendChild(el('div', { className: 'sticky-note-bar' },
    el('span', { className: 'sticky-note-grip' }, '···'),
    el('div', { className: 'sticky-note-tools' }, colorBtn, delBtn),
  ));
  card.appendChild(titleIn);
  card.appendChild(bodyIn);

  return card;
}

function openColorPicker(boardId, note, cardEl) {
  const body = el('div', { className: 'sticky-color-grid' },
    ...STICKY_COLORS.map(c => el('button', {
      type: 'button',
      className: `sticky-color-swatch sticky-${c.id}${note.color === c.id ? ' active' : ''}`,
      title: c.label,
      onClick: () => {
        store.patchStickyNote(boardId, note.id, { color: c.id });
        modal.close();
        window.appRefresh();
      },
    })),
  );

  const modal = showModal({
    title: 'Sticky color',
    body,
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Cancel'),
    ],
  });
}
