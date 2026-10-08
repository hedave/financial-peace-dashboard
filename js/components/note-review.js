import { el, formatCurrency, formatDate } from '../utils.js';
import { store } from '../store.js';
import { showToast } from './modal.js';
import { noteMemoSnippet, noteDay } from '../note-matcher.js';

/**
 * "Notes to review" card for the Log page.
 * All note / memo / merchant text goes in as text nodes (el() string children,
 * never innerHTML). Owner login only — the notes-only login can't write transactions.
 */
const MAX_REVIEW_ROWS = 10;
const MAX_LINK_ROWS = 20;

const REASON_LABEL = {
  ambiguous: 'More than one transaction fits',
  weak: 'Possible match — amount fits, merchant or date is loose',
  taken: 'That transaction already has a linked note',
  shared: 'Another note fits the same transaction',
  long: 'Memo is too long to add this note automatically',
};

function txSummary(tx) {
  const desc = String(tx?.description || '').trim() || 'Transaction';
  const parts = [formatDate(String(tx?.date || '').slice(0, 10)), formatCurrency(Math.abs(Number(tx?.amount) || 0))];
  return { desc, meta: parts.join(' · ') };
}

function noteLabel(note) {
  return noteMemoSnippet(note) || 'Empty note';
}

function noteMeta(note, extra) {
  const day = noteDay(note);
  const who = note?.createdBy === 'notes' ? 'Notes login' : note?.createdBy === 'owner' ? 'Main login' : null;
  return [day ? `Written ${formatDate(day)}` : null, who, extra].filter(Boolean).join(' · ');
}

function reviewItem(item) {
  const { note, reason, candidates } = item;
  const wrap = el('div', { className: 'note-review-item' });
  wrap.appendChild(el('p', { className: 'note-review-text' }, noteLabel(note)));
  wrap.appendChild(el('p', { className: 'note-review-meta' }, noteMeta(note, REASON_LABEL[reason] || '')));
  const list = el('div', { className: 'list-group note-review-candidates' });
  candidates.forEach(c => {
    const { desc, meta } = txSummary(c.tx);
    list.appendChild(el('div', { className: 'list-row' },
      el('div', { className: 'list-row__body' },
        el('span', { className: 'list-row__title' }, desc),
        el('span', { className: 'list-row__meta' }, meta),
      ),
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        'aria-label': `Link note to ${desc}, ${meta}`,
        onClick: () => {
          const res = store.linkNoteManually(note.id, c.txId);
          if (res?.ok) showToast('Note linked · added to the memo', 'success');
          else if (res?.reason === 'memo-too-long') showToast('That memo is already long — note not added.', 'info');
          else if (res?.reason) showToast('Could not link that note.', 'info');
        },
      }, 'Link'),
    ));
  });
  wrap.appendChild(list);
  wrap.appendChild(el('div', { className: 'note-review-actions' },
    el('button', {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      'aria-label': 'Dismiss this note — never match it',
      onClick: () => {
        const res = store.dismissNoteMatch(note.id);
        if (res?.ok) showToast('Dismissed · this note won’t be matched again', 'info');
      },
    }, 'Dismiss'),
  ));
  return wrap;
}

function linkRow({ link, note, tx }) {
  const { desc, meta } = txSummary(tx);
  const title = note ? noteLabel(note) : String(link.appended || '').replace(/^\s*·\s*/, '') || 'Note';
  return el('div', { className: 'list-row' },
    el('div', { className: 'list-row__body' },
      el('span', { className: 'list-row__title note-review-linked-text' }, title),
      el('span', { className: 'list-row__meta' }, `${link.mode === 'auto' ? 'Auto' : 'Linked'} → ${desc} · ${meta}`),
    ),
    el('button', {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      'aria-label': `Unlink note from ${desc}`,
      onClick: () => {
        const res = store.unlinkNoteLink(link.id);
        if (!res?.ok) return;
        showToast(res.memoRestored || !link.appended
          ? 'Unlinked · memo restored'
          : 'Unlinked · the memo was edited by hand, so it was left as is', 'info');
      },
    }, 'Unlink'),
  );
}

/** @returns {HTMLElement|null} */
export function renderNoteReviewCard() {
  if (!store.canWriteBudget()) return null;
  let data;
  try {
    data = store.getNoteReview();
  } catch (err) {
    console.warn('Note review unavailable', err);
    return null;
  }
  const review = data?.review || [];
  const links = data?.links || [];
  if (!review.length && !links.length) return null;

  const card = el('section', { className: 'card section note-review', 'aria-labelledby': 'note-review-title' });
  const head = el('div', { className: 'section-title-row' },
    el('h3', { className: 'section-title', id: 'note-review-title' }, 'Notes to review'),
    review.length ? el('span', { className: 'count-badge' }, String(review.length)) : null,
  );
  card.appendChild(head);
  if (review.length) {
    card.appendChild(el('p', { className: 'card-sub note-review-intro' },
      'These notes mention an amount that might match a transaction. Nothing changes until you tap Link.'));
    review.slice(0, MAX_REVIEW_ROWS).forEach(item => card.appendChild(reviewItem(item)));
    if (review.length > MAX_REVIEW_ROWS) {
      card.appendChild(el('p', { className: 'card-sub' }, `+ ${review.length - MAX_REVIEW_ROWS} more after these`));
    }
  } else {
    card.appendChild(el('p', { className: 'card-sub note-review-intro' }, 'No notes waiting. Linked notes are below.'));
  }
  if (links.length) {
    const details = el('details', { className: 'note-review-linked' });
    details.appendChild(el('summary', {}, `Linked notes (${links.length})`));
    const list = el('div', { className: 'list-group' });
    links.slice(0, MAX_LINK_ROWS).forEach(row => list.appendChild(linkRow(row)));
    details.appendChild(list);
    card.appendChild(details);
  }
  return card;
}
