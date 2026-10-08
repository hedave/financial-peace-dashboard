import { el, labelFor } from '../utils.js';

export function formatStickyStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function stickyTimeLabel(note) {
  const created = note?.createdAt || note?.updatedAt || '';
  if (!created) return { added: '', edited: '' };
  const createdMs = new Date(created).getTime();
  const updated = note?.updatedAt || '';
  const updatedMs = updated ? new Date(updated).getTime() : createdMs;
  const edited = Number.isFinite(updatedMs)
    && Number.isFinite(createdMs)
    && updatedMs - createdMs > 60 * 1000;
  return {
    added: `Added ${formatStickyStamp(created)}`,
    edited: edited ? `Edited ${formatStickyStamp(updated)}` : '',
    created,
    updated: edited ? updated : '',
  };
}

function paintStickyWhen(host, note) {
  const label = stickyTimeLabel(note);
  host.replaceChildren();
  if (!label.added) return;
  host.appendChild(el('time', { dateTime: label.created }, label.added));
  if (label.edited) {
    host.appendChild(el('time', { dateTime: label.updated }, label.edited));
  }
}
import { store } from '../store.js';
import { showToast, confirmDialog, showModal, showUndoToast } from '../components/modal.js';
import { icon } from '../icons.js';
import { activeStickies, countArchived } from '../note-archive.js';
import { renderArchiveShelf } from '../components/note-booklets.js';

const STICKY_COLORS = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'pink', label: 'Pink' },
  { id: 'blue', label: 'Blue' },
  { id: 'green', label: 'Green' },
  { id: 'purple', label: 'Purple' },
  { id: 'orange', label: 'Orange' },
];

let activeBoardId = null;
let notesSearch = '';
/** 'board' (live stickies) | 'archive' (booklet shelf) */
let notesView = 'board';

/** For Quick Notes popup — last board viewed on the Notes page. */
export function getActiveNotesBoardId() {
  return activeBoardId;
}
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
      el('h2', {}, 'Notes'),
      el('p', {}, 'Pages of stickies · tap to type · autosaves to the household'),
    ),
    el('div', { className: 'notes-header-actions' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          if (!board) return;
          store.addStickyNote(board.id, { title: '', text: '', color: 'yellow' });
          showToast('Sticky added');
          window.appRefresh();
        },
      }, '+ Sticky'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => openPageNameModal({
          title: 'New notes page',
          value: '',
          confirmLabel: 'Add page',
          onSave: (name) => {
            activeBoardId = store.addNoteBoard(name);
            showToast('Page added');
            window.appRefresh();
          },
        }),
      }, '+ Page'),
    ),
  ));

  const inArchive = notesView === 'archive';
  const archivedCount = countArchived(store.getState());
  const tabs = el('div', { className: 'sticky-board-tabs section' });
  boards.forEach(b => {
    const tab = el('button', {
      type: 'button',
      className: `sticky-board-tab${!inArchive && b.id === board?.id ? ' active' : ''}`,
      'aria-pressed': !inArchive && b.id === board?.id ? 'true' : 'false',
      onClick: () => {
        activeBoardId = b.id;
        notesView = 'board';
        notesSearch = '';
        window.appRefresh();
      },
    }, b.title || 'Page');
    tabs.appendChild(tab);
  });
  tabs.appendChild(el('button', {
    type: 'button',
    className: `sticky-board-tab sticky-archive-tab${inArchive ? ' active' : ''}`,
    'aria-pressed': inArchive ? 'true' : 'false',
    'aria-label': `Archive, ${archivedCount} archived ${archivedCount === 1 ? 'sticky' : 'stickies'}`,
    onClick: () => {
      notesView = 'archive';
      notesSearch = '';
      window.appRefresh();
    },
  }, icon('archive', 16), 'Archive', archivedCount ? el('span', { className: 'sticky-archive-count' }, String(archivedCount)) : null));
  container.appendChild(tabs);

  if (inArchive) {
    container.appendChild(renderArchiveShelf({ onChange: () => window.appRefresh() }));
    return;
  }

  let boardEl = null;
  if (board) {
    const tools = el('div', { className: 'notes-board-tools section' },
      el('input', {
        type: 'search',
        className: 'notes-search',
        placeholder: 'Search this page…',
        'aria-label': 'Search notes on this page',
        value: notesSearch,
        onInput: (e) => {
          notesSearch = e.target.value;
          paintBoard(boardEl, board);
        },
      }),
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => openPageNameModal({
          title: 'Rename page',
          value: board.title || '',
          confirmLabel: 'Save name',
          onSave: (name) => {
            store.renameNoteBoard(board.id, name);
            window.appRefresh();
          },
        }),
      }, 'Rename'),
      boards.length > 1
        ? el('button', {
          type: 'button',
          className: 'btn btn-sm btn-danger',
          onClick: () => {
            confirmDialog(
              'Delete this page?',
              `Remove “${board.title}” and its stickies? Archived stickies from this page stay in the Archive (they move to your first page).`,
              () => {
                store.deleteNoteBoard(board.id);
                activeBoardId = null;
                showToast('Page deleted');
                window.appRefresh();
              },
            );
          },
        }, 'Delete page')
        : null,
    );
    container.appendChild(tools);
  }

  if (!board) {
    container.appendChild(el('div', { className: 'empty-state' },
      el('div', { className: 'empty-icon' }, '🗒️'),
      el('h3', {}, 'No pages yet'),
      el('p', {}, 'Add a page, then tap + Sticky.'),
    ));
    return;
  }

  boardEl = el('div', { className: 'sticky-board', id: 'sticky-board' });
  paintBoard(boardEl, board);
  container.appendChild(boardEl);
}

function paintBoard(boardEl, board) {
  const q = String(notesSearch || '').trim().toLowerCase();
  const live = activeStickies(board);
  const stickies = live.filter(n => {
    if (!q) return true;
    const hay = `${n.title || ''} ${n.text || ''}`.toLowerCase();
    return hay.includes(q);
  });

  boardEl.innerHTML = '';
  if (!live.length) {
    const archivedHere = (board.stickies || []).length - live.length;
    boardEl.appendChild(el('div', { className: 'sticky-board-empty' },
      el('p', {}, archivedHere
        ? `Nothing on this page right now · ${archivedHere} archived (see Archive).`
        : 'Nothing on this page yet.'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          store.addStickyNote(board.id);
          window.appRefresh();
        },
      }, '+ Add a sticky'),
    ));
    return;
  }
  if (!stickies.length) {
    boardEl.appendChild(el('div', { className: 'sticky-board-empty' },
      el('p', {}, `No stickies match “${notesSearch.trim()}”.`),
    ));
    return;
  }
  stickies.forEach(note => {
    boardEl.appendChild(renderSticky(board.id, note));
  });
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

  const savedEl = el('span', { className: 'sticky-note-saved' }, '');
  const whenEl = el('div', { className: 'sticky-note-when' });
  paintStickyWhen(whenEl, note);
  let savedTitle = note.title || '';
  let savedText = note.text || '';

  const scheduleSave = () => {
    if (titleIn.value === savedTitle && bodyIn.value === savedText) return;
    const key = note.id;
    savedEl.textContent = 'Saving…';
    clearTimeout(stickyTimers.get(key));
    stickyTimers.set(key, setTimeout(() => {
      const saved = store.patchStickyNote(boardId, note.id, {
        title: titleIn.value,
        text: bodyIn.value,
      });
      savedTitle = titleIn.value;
      savedText = bodyIn.value;
      if (saved) paintStickyWhen(whenEl, saved);
      savedEl.textContent = 'Saved';
    }, 400));
  };

  titleIn.addEventListener('input', scheduleSave);
  bodyIn.addEventListener('input', scheduleSave);
  titleIn.addEventListener('blur', scheduleSave);
  bodyIn.addEventListener('blur', scheduleSave);

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

  const archiveBtn = el('button', {
    type: 'button',
    className: 'sticky-note-tool sticky-note-archive',
    title: 'Archive sticky',
    'aria-label': 'Archive sticky',
    onClick: (e) => {
      e.stopPropagation();
      // Flush a pending autosave first so the archived copy has the latest text
      const pending = stickyTimers.get(note.id);
      if (pending) {
        clearTimeout(pending);
        stickyTimers.delete(note.id);
        store.patchStickyNote(boardId, note.id, { title: titleIn.value, text: bodyIn.value });
      }
      const res = store.archiveStickyNote(note.id);
      if (!res?.ok) return;
      window.appRefresh();
      showUndoToast('Sticky archived', () => {
        store.unarchiveStickyNote(note.id);
        window.appRefresh();
      });
    },
  }, icon('archive', 18));

  const swatches = el('div', { className: 'sticky-note-swatches' },
    ...STICKY_COLORS.map(c => el('button', {
      type: 'button',
      className: `sticky-note-swatch sticky-${c.id}${note.color === c.id ? ' is-on' : ''}`,
      title: c.label,
      'aria-label': `${c.label} note`,
      'aria-pressed': note.color === c.id ? 'true' : 'false',
      onClick: (e) => {
        e.stopPropagation();
        store.patchStickyNote(boardId, note.id, { color: c.id });
        window.appRefresh();
      },
    })),
  );

  card.appendChild(el('div', { className: 'sticky-note-bar' },
    swatches,
    el('div', { className: 'sticky-note-tools' }, savedEl, archiveBtn, delBtn),
  ));
  card.appendChild(whenEl);
  card.appendChild(titleIn);
  card.appendChild(bodyIn);

  return card;
}

function openPageNameModal({ title, value, confirmLabel, onSave }) {
  const input = el('input', {
    type: 'text',
    placeholder: 'Shopping, Kids, This week…',
    value: value || '',
  });
  const modal = showModal({
    title,
    body: el('div', { className: 'form-group' },
      labelFor('Page name', input),
      input,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Cancel'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const name = input.value.trim();
          if (!name) {
            showToast('Enter a page name', 'info');
            return;
          }
          modal.close();
          onSave(name);
        },
      }, confirmLabel || 'Save'),
    ],
  });
}
