import { el, formatDate, formatCurrency } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import { groupArchivedBooklets, stickyTilt, UNDATED_KEY } from '../note-archive.js';

/**
 * Archive shelf (one sticky-note stack per month/year) + stack viewer where the
 * top note flips up from its bottom edge, like a pad glued along the top.
 * Plain JS/CSS. Every piece of note text goes in as a text node (el() string
 * children / textContent) — never innerHTML.
 */

/** Notes visible in a stack (top + up to 3 peeking underneath). */
export const STACK_LAYERS = 4;
const FLIP_MS = 520;

function prefersReducedMotion() {
  if (document.documentElement.getAttribute('data-reduce-motion') === 'true') return true;
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Apply a note's stable tilt via CSSOM custom properties (no style-attribute strings). */
function applyTilt(node, noteId, depth = 0) {
  const t = stickyTilt(noteId);
  node.style.setProperty('--tilt', `${t.angle}deg`);
  node.style.setProperty('--dx', `${t.dx + depth * 2}px`);
  node.style.setProperty('--dy', `${t.dy + depth * 4}px`);
  return node;
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

/** Short plain-text teaser (title, else text). */
function teaser(note, max = 80) {
  const raw = String(note?.title || '').trim() || String(note?.text || '').trim();
  const flat = raw.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Peeking notes under a top note: their own colors + their own tilt. */
function underLayers(entries, className) {
  return entries.map((entry, i) => applyTilt(
    el('span', { className: `${className} sticky-${entry.note.color || 'yellow'}`, 'aria-hidden': 'true' }),
    entry.note.id,
    i + 1,
  ));
}

/** Shelf of month stacks. Returns a DOM node. `onChange` re-renders the Notes page. */
export function renderArchiveShelf({ onChange } = {}) {
  const booklets = groupArchivedBooklets(store.getState());
  const wrap = el('section', { className: 'booklet-shelf-wrap section', 'aria-labelledby': 'booklet-shelf-title' });
  wrap.appendChild(el('div', { className: 'booklet-shelf-head' },
    el('h3', { className: 'section-title', id: 'booklet-shelf-title' }, 'Archive'),
    el('p', { className: 'card-sub' }, 'Old stickies, stacked by month. Tap a stack to flip through it.'),
  ));
  if (!booklets.length) {
    wrap.appendChild(el('div', { className: 'empty-state booklet-empty', role: 'status' },
      el('div', { className: 'empty-icon', 'aria-hidden': 'true' }, icon('archive', 32)),
      el('h3', {}, 'No archived stickies yet'),
      el('p', {}, 'Tap the archive button on a sticky to file it here. You can unarchive it anytime.'),
    ));
    return wrap;
  }
  const shelf = el('div', { className: 'stack-shelf', role: 'list' });
  booklets.forEach(b => {
    const countLabel = `${b.count} note${b.count === 1 ? '' : 's'}`;
    const [first, ...rest] = b.notes;
    // Back-to-front: deepest peeking note first so the top note paints last
    const layers = underLayers(rest.slice(0, STACK_LAYERS - 1), 'note-stack-layer').reverse();
    const top = applyTilt(el('span', { className: `note-stack-top sticky-${first.note.color || 'yellow'}` },
      el('span', { className: 'note-stack-month' }, b.month),
      b.year ? el('span', { className: 'note-stack-year' }, b.year) : null,
      el('span', { className: 'note-stack-peek', 'aria-hidden': 'true' }, teaser(first.note)),
      el('span', { className: 'note-stack-count' }, countLabel),
    ), first.note.id, 0);
    shelf.appendChild(el('div', { role: 'listitem', className: 'stack-slot' },
      el('button', {
        type: 'button',
        className: 'note-stack',
        'aria-label': `${b.label}, ${countLabel}. Open stack`,
        onClick: () => openBooklet(b.key, { onChange }),
      }, ...layers, top),
    ));
  });
  wrap.appendChild(shelf);
  return wrap;
}

/** The readable top note of the viewer (exported for tests). */
export function renderFlipbookNote(entry, { onUnarchive }) {
  const { note, boardTitle } = entry;
  const card = el('article', { className: `flipstack-note sticky-${note.color || 'yellow'}` });
  if (String(note.title || '').trim()) card.appendChild(el('h4', { className: 'flipstack-note-title' }, String(note.title)));
  const body = el('p', { className: 'flipstack-note-text' });
  body.textContent = String(note.text || '').trim() || (note.title ? '' : 'Empty sticky');
  card.appendChild(body);
  const meta = [
    note.createdAt ? `Written ${localDay(note.createdAt)}` : null,
    note.archivedAt ? `Archived ${localDay(note.archivedAt)}` : null,
    `Page: ${boardTitle}`,
  ].filter(Boolean).join(' · ');
  card.appendChild(el('p', { className: 'flipstack-note-meta' }, meta));
  const tx = linkedTxFor(note.id);
  if (tx) {
    card.appendChild(el('p', { className: 'flipstack-note-link' },
      `Linked to ${String(tx.description || 'a transaction')} · ${formatCurrency(Math.abs(Number(tx.amount) || 0))}`));
  }
  card.appendChild(el('div', { className: 'flipstack-note-actions' },
    el('button', {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      'aria-label': `Unarchive back to ${boardTitle}`,
      onClick: () => onUnarchive(note),
    }, 'Unarchive'),
  ));
  return card;
}

/** Open one month as a sticky stack; the top note flips up to reveal the next. */
export function openBooklet(key, { onChange } = {}) {
  let booklet = groupArchivedBooklets(store.getState()).find(b => b.key === key);
  if (!booklet) return null;
  let index = 0;
  let peeling = null; // outgoing note mid-flip

  const stack = el('div', { className: 'flipstack-stack' });
  const stage = el('div', { className: 'flipstack-stage', tabIndex: '-1' }, stack);
  const prevBtn = el('button', { type: 'button', className: 'flipstack-nav flipstack-prev', 'aria-label': 'Previous note' }, icon('chevronLeft', 22));
  const nextBtn = el('button', { type: 'button', className: 'flipstack-nav flipstack-next', 'aria-label': 'Next note' }, icon('chevron', 22));
  const indicator = el('p', { className: 'flipstack-indicator', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const view = el('div', { className: 'flipstack' },
    stage,
    el('div', { className: 'flipstack-controls' }, prevBtn, indicator, nextBtn),
  );

  function finishPeel() {
    if (!peeling) return;
    clearTimeout(peeling.timer);
    peeling.node.remove();
    peeling = null;
  }

  function buildTop(entry) {
    return applyTilt(renderFlipbookNote(entry, { onUnarchive }), entry.note.id, 0);
  }

  /** direction: 0 = instant, 1 = top note flips up and away, -1 = previous note flips back down */
  function paint(direction = 0) {
    finishPeel();
    const notes = booklet.notes;
    index = Math.max(0, Math.min(index, notes.length - 1));
    const animate = direction !== 0 && !prefersReducedMotion();
    const outgoing = stack.querySelector('.flipstack-note');

    const under = underLayers(notes.slice(index + 1, index + STACK_LAYERS), 'flipstack-layer').reverse();
    const top = buildTop(notes[index]);
    top.classList.add('is-top');
    stack.replaceChildren(...under, top);

    if (animate && direction > 0 && outgoing) {
      // Old top lifts from its bottom edge, hinges on its top edge, flips up and away.
      outgoing.classList.remove('is-top');
      outgoing.classList.add('flipstack-peel', 'peel-up');
      outgoing.setAttribute('aria-hidden', 'true');
      outgoing.inert = true;
      stack.appendChild(outgoing);
      peeling = { node: outgoing, timer: setTimeout(finishPeel, FLIP_MS + 120) };
      outgoing.addEventListener('animationend', finishPeel, { once: true });
    } else if (animate && direction < 0) {
      // Previous note flips back down onto the stack (same hinge, reversed).
      top.classList.add('peel-down');
      top.addEventListener('animationend', () => top.classList.remove('peel-down'), { once: true });
    }
    indicator.textContent = `${index + 1} / ${notes.length}`;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index >= notes.length - 1;
  }

  function go(delta) {
    const next = Math.max(0, Math.min(index + delta, booklet.notes.length - 1));
    if (next === index) return;
    index = next;
    paint(delta);
  }

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
    paint(0);
  }

  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));

  // Swipe: up (or left) = next, down (or right) = back. Touch events still fire when
  // the browser scrolls, so a long note scrolls first and only a non-scroll swipe flips.
  const body = () => stage.closest('.modal-body');
  let start = null;
  const begin = (x, y) => { start = { x, y, scroll: body()?.scrollTop || 0 }; };
  const end = (x, y) => {
    if (!start) return;
    const dx = x - start.x; const dy = y - start.y;
    const scrolled = Math.abs((body()?.scrollTop || 0) - start.scroll) > 2;
    start = null;
    if (scrolled) return;
    if (Math.abs(dy) > 45 && Math.abs(dy) > Math.abs(dx) * 1.3) go(dy < 0 ? 1 : -1);
    else if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) go(dx < 0 ? 1 : -1);
  };
  stage.addEventListener('touchstart', e => {
    if (e.target.closest('button') || e.touches.length !== 1) { start = null; return; }
    begin(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  stage.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    if (t) end(t.clientX, t.clientY);
  }, { passive: true });
  stage.addEventListener('touchcancel', () => { start = null; }, { passive: true });
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.target.closest('button')) return;
    begin(e.clientX, e.clientY);
  });
  stage.addEventListener('pointerup', e => {
    if (e.pointerType !== 'mouse') return;
    end(e.clientX, e.clientY);
  });

  // Keyboard: ←/→ flip. Escape closes (modal.js handles Escape for every sheet).
  const onKey = e => {
    if (!document.body.contains(view)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  };
  document.addEventListener('keydown', onKey);

  const label = key === UNDATED_KEY ? 'Undated notes' : booklet.label;
  const modal = showModal({
    title: label,
    body: view,
    onClose: () => {
      finishPeel();
      document.removeEventListener('keydown', onKey);
    },
  });
  modal.modal.classList.add('modal-booklet');
  paint(0);
  requestAnimationFrame(() => { try { stage.focus({ preventScroll: true }); } catch { /* ignore */ } });
  return modal;
}
