import { el, formatDate, formatCurrency } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import { groupArchivedBooklets, paginate, UNDATED_KEY } from '../note-archive.js';

/**
 * Archive shelf (one booklet per month/year) + flip-book viewer.
 * Plain JS/CSS. Every piece of note text goes in as a text node (el() string
 * children / textContent) — never innerHTML.
 */

function prefersReducedMotion() {
  if (document.documentElement.getAttribute('data-reduce-motion') === 'true') return true;
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Notes per flip-book page: one on phones, a few on wider screens. */
export function notesPerPage(width = window.innerWidth) {
  if (width <= 640) return 1;
  if (width < 960) return 2;
  return 4;
}

function localDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return formatDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
}

function linkedTxFor(noteId) {
  const st = store.getState();
  const link = (st.noteLinks || []).find(l => l && l.noteId === noteId);
  if (!link) return null;
  return (st.transactions || []).find(t => t && t.id === link.txId) || null;
}

/** A short teaser from the newest note in the booklet (plain text, one-line-ish). */
function peekText(b) {
  const last = b.notes[b.notes.length - 1]?.note;
  const raw = String(last?.title || '').trim() || String(last?.text || '').trim();
  const flat = raw.replace(/\s+/g, ' ');
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/** Shelf of booklets. Returns a DOM node. `onChange` re-renders the Notes page. */
export function renderArchiveShelf({ onChange } = {}) {
  const booklets = groupArchivedBooklets(store.getState());
  const wrap = el('section', { className: 'booklet-shelf-wrap section', 'aria-labelledby': 'booklet-shelf-title' });
  wrap.appendChild(el('div', { className: 'booklet-shelf-head' },
    el('h3', { className: 'section-title', id: 'booklet-shelf-title' }, 'Archive'),
    el('p', { className: 'card-sub' }, 'Old stickies, bound by month. Tap a booklet to flip through it.'),
  ));
  if (!booklets.length) {
    wrap.appendChild(el('div', { className: 'empty-state booklet-empty', role: 'status' },
      el('div', { className: 'empty-icon', 'aria-hidden': 'true' }, icon('book', 32)),
      el('h3', {}, 'No archived stickies yet'),
      el('p', {}, 'Tap the archive button on a sticky to file it here. You can unarchive it anytime.'),
    ));
    return wrap;
  }
  const shelf = el('div', { className: 'booklet-shelf', role: 'list' });
  booklets.forEach(b => {
    const countLabel = `${b.count} note${b.count === 1 ? '' : 's'}`;
    shelf.appendChild(el('div', { role: 'listitem', className: 'booklet-slot' },
      el('button', {
        type: 'button',
        className: `booklet sticky-${b.color}`,
        'aria-label': `${b.label}, ${countLabel}. Open booklet`,
        onClick: () => openBooklet(b.key, { onChange }),
      },
        el('span', { className: 'booklet-label' },
          el('span', { className: 'booklet-month' }, b.month),
          b.year ? el('span', { className: 'booklet-year' }, b.year) : null,
        ),
        el('span', { className: 'booklet-peek', 'aria-hidden': 'true' }, peekText(b)),
        el('span', { className: 'booklet-count' }, countLabel),
      ),
    ));
  });
  wrap.appendChild(shelf);
  return wrap;
}

export function renderFlipbookNote(entry, { onUnarchive }) {
  const { note, boardTitle } = entry;
  const card = el('article', { className: `flipbook-note sticky-${note.color || 'yellow'}` });
  if (String(note.title || '').trim()) card.appendChild(el('h4', { className: 'flipbook-note-title' }, String(note.title)));
  const body = el('p', { className: 'flipbook-note-text' });
  body.textContent = String(note.text || '').trim() || (note.title ? '' : 'Empty sticky');
  card.appendChild(body);
  const meta = [
    note.createdAt ? `Written ${localDay(note.createdAt)}` : null,
    note.archivedAt ? `Archived ${localDay(note.archivedAt)}` : null,
    `Page: ${boardTitle}`,
  ].filter(Boolean).join(' · ');
  card.appendChild(el('p', { className: 'flipbook-note-meta' }, meta));
  const tx = linkedTxFor(note.id);
  if (tx) {
    card.appendChild(el('p', { className: 'flipbook-note-link' },
      `Linked to ${String(tx.description || 'a transaction')} · ${formatCurrency(Math.abs(Number(tx.amount) || 0))}`));
  }
  card.appendChild(el('div', { className: 'flipbook-note-actions' },
    el('button', {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      'aria-label': `Unarchive back to ${boardTitle}`,
      onClick: () => onUnarchive(note),
    }, 'Unarchive'),
  ));
  return card;
}

/** Open one month's booklet as a flip book (modal). */
export function openBooklet(key, { onChange } = {}) {
  let booklet = groupArchivedBooklets(store.getState()).find(b => b.key === key);
  if (!booklet) return null;
  let perPage = notesPerPage();
  let pageIndex = 0;

  const stage = el('div', { className: 'flipbook-stage', tabIndex: '-1' });
  const prevBtn = el('button', { type: 'button', className: 'flipbook-nav flipbook-prev', 'aria-label': 'Previous page' }, icon('chevronLeft', 22));
  const nextBtn = el('button', { type: 'button', className: 'flipbook-nav flipbook-next', 'aria-label': 'Next page' }, icon('chevron', 22));
  const indicator = el('p', { className: 'flipbook-indicator', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const book = el('div', { className: 'flipbook' },
    stage,
    el('div', { className: 'flipbook-controls' }, prevBtn, indicator, nextBtn),
  );

  const pages = () => paginate(booklet.notes, perPage);

  function onUnarchive(note) {
    const res = store.unarchiveStickyNote(note.id);
    if (!res?.ok) return;
    showToast(`Back on “${res.boardTitle}”`, 'success');
    onChange?.();
    booklet = groupArchivedBooklets(store.getState()).find(b => b.key === key);
    if (!booklet) {
      modal.close();
      return;
    }
    pageIndex = Math.min(pageIndex, pages().length - 1);
    paint(0);
  }

  function paint(direction = 0) {
    const all = pages();
    const total = all.length;
    pageIndex = Math.max(0, Math.min(pageIndex, total - 1));
    const page = el('div', { className: `flipbook-page per-${perPage}` });
    all[pageIndex].forEach(entry => page.appendChild(renderFlipbookNote(entry, { onUnarchive })));
    if (direction && !prefersReducedMotion()) {
      page.classList.add(direction > 0 ? 'flip-in-next' : 'flip-in-prev');
    }
    stage.replaceChildren(page);
    indicator.textContent = `${pageIndex + 1} / ${total}`;
    prevBtn.disabled = pageIndex === 0;
    nextBtn.disabled = pageIndex >= total - 1;
  }

  function go(delta) {
    const total = pages().length;
    const next = Math.max(0, Math.min(pageIndex + delta, total - 1));
    if (next === pageIndex) return;
    pageIndex = next;
    paint(delta);
  }

  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));

  // Swipe (touch / pen / mouse drag) — horizontal only, vertical scroll still works.
  let sx = null; let sy = 0;
  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    sx = e.clientX; sy = e.clientY;
  });
  const endSwipe = e => {
    if (sx == null) return;
    const dx = e.clientX - sx; const dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
  };
  stage.addEventListener('pointerup', endSwipe);
  stage.addEventListener('pointercancel', () => { sx = null; });

  // Keyboard: ←/→ turn pages. Escape closes (modal.js handles Escape for every sheet).
  const onKey = e => {
    if (!document.body.contains(book)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  };
  const onResize = () => {
    const next = notesPerPage();
    if (next === perPage) return;
    const firstNote = pageIndex * perPage;
    perPage = next;
    pageIndex = Math.floor(firstNote / perPage);
    paint(0);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  const label = key === UNDATED_KEY ? 'Undated notes' : booklet.label;
  const modal = showModal({
    title: label,
    body: book,
    onClose: () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    },
  });
  modal.modal.classList.add('modal-booklet');
  paint(0);
  requestAnimationFrame(() => { try { stage.focus({ preventScroll: true }); } catch { /* ignore */ } });
  return modal;
}
