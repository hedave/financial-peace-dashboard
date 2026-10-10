import { el, formatCurrency, formatDate } from '../utils.js';
import { store } from '../store.js';
import { showToast } from './modal.js';
import { RECEIPT_REPLACEABLE_ENVELOPES } from '../receipt-split.js';

/**
 * "Receipts to review" card for the Log page (modeled on Notes to review).
 * FigPig couldn't place these receipt splits on its own (no / several bank
 * rows fit, or low confidence). Approve puts the split on the bank row
 * (splits only: the amount and checking never change). Edit moves receipt
 * items between envelopes. Dismiss drops it.
 * All store / item / merchant text goes in as text nodes (el() string
 * children, never innerHTML). Owner login only.
 */
const MAX_REVIEW_ROWS = 10;

const REASON_LABEL = {
  no_match: 'No bank transaction fits yet',
  multiple_matches: 'More than one bank transaction fits',
  sum_mismatch: 'Receipt total differs from the bank amount',
  already_split: 'That transaction was already split',
  category_conflict: 'That transaction already has another envelope',
  low_confidence: 'Some items were hard to sort',
};

const RESULT_MESSAGE = {
  sum_mismatch: 'The split doesn’t add up to that bank amount. Nothing changed.',
  already_split: 'That transaction is already split. Nothing changed.',
  category_conflict: 'That transaction already has a different envelope. Nothing changed.',
  invalid_splits: 'Put items in at least two envelopes. Nothing changed.',
  unknown_envelope: 'One of those envelopes no longer exists. Nothing changed.',
  no_match: 'That transaction is gone. Nothing changed.',
  review_not_found: 'That receipt was already handled.',
};

function envelopeName(id) {
  return store.getState().categories.find(c => c.id === id)?.name || 'Envelope';
}

function txSummary(tx) {
  const desc = String(tx?.description || '').trim() || 'Transaction';
  const meta = [formatDate(String(tx?.date || '').slice(0, 10)), formatCurrency(Math.abs(Number(tx?.amount) || 0))].join(' · ');
  return { desc, meta };
}

function bucketOptions(item) {
  const ids = [];
  const add = id => { if (id && !ids.includes(id) && store.getState().categories.some(c => c.id === id)) ids.push(id); };
  (item.proposedSplits || []).forEach(s => add(s.categoryId));
  (item.items || []).forEach(i => add(i.bucket));
  RECEIPT_REPLACEABLE_ENVELOPES.forEach(name => add(store.getState().categories.find(c => c.name === name)?.id));
  return ids;
}

function splitLines(lines) {
  const list = el('ul', { className: 'receipt-review-splits', role: 'list' });
  lines.forEach(({ categoryId, cents }) => {
    list.appendChild(el('li', { className: 'receipt-review-split' },
      el('span', { className: 'receipt-review-split__name' }, envelopeName(categoryId)),
      el('span', { className: 'money receipt-review-split__amount' }, formatCurrency(cents / 100)),
    ));
  });
  return list;
}

function reviewItem({ item, candidates }) {
  const proposed = (item.proposedSplits || []).map(s => ({
    categoryId: s.categoryId,
    cents: Math.round((Number(s.amount) || 0) * 100),
  }));
  // Edit state: one envelope per receipt item. null until the user changes one.
  let buckets = null;
  const current = () => {
    if (!buckets) return { ok: true, value: proposed, edited: false };
    const r = store.receiptSplitsFromBuckets(item, buckets);
    return r.ok ? { ...r, edited: true } : r;
  };

  const wrap = el('div', { className: 'receipt-review-item' });
  wrap.appendChild(el('div', { className: 'receipt-review-head' },
    el('p', { className: 'receipt-review-store' }, item.store || 'Receipt'),
    el('span', { className: 'money receipt-review-total' }, formatCurrency(item.total)),
  ));
  wrap.appendChild(el('p', { className: 'receipt-review-meta' },
    [item.date ? formatDate(item.date) : null, REASON_LABEL[item.reason] || null].filter(Boolean).join(' · ')));

  const splitsHost = el('div', { className: 'receipt-review-split-host' });
  const renderSplits = () => {
    const r = current();
    splitsHost.replaceChildren(r.ok
      ? splitLines(r.value)
      : el('p', { className: 'receipt-review-warn', role: 'status' }, 'Put items in at least two envelopes.'));
  };
  renderSplits();
  wrap.appendChild(splitsHost);

  const approve = (tx) => {
    const r = current();
    if (!r.ok) {
      showToast(RESULT_MESSAGE.invalid_splits, 'info');
      return;
    }
    const res = store.approveReceiptReview(item.receiptId, tx.id, r.edited ? r.value : null);
    if (res?.ok) showToast('Split saved · amount and checking unchanged', 'success');
    else showToast(RESULT_MESSAGE[res?.code] || 'Could not apply that split.', 'info');
  };

  if (candidates.length) {
    const list = el('div', { className: 'list-group receipt-review-candidates' });
    candidates.forEach(tx => {
      const { desc, meta } = txSummary(tx);
      list.appendChild(el('div', { className: 'list-row' },
        el('div', { className: 'list-row__body' },
          el('span', { className: 'list-row__title' }, desc),
          el('span', { className: 'list-row__meta' }, meta),
        ),
        el('button', {
          type: 'button',
          className: 'btn btn-primary btn-sm',
          'aria-label': `Approve split on ${desc}, ${meta}`,
          onClick: () => approve(tx),
        }, 'Approve'),
      ));
    });
    wrap.appendChild(list);
  } else {
    wrap.appendChild(el('p', { className: 'card-sub receipt-review-wait' },
      'No bank transaction fits yet. It shows up here after the next bank sync.'));
  }

  const actions = el('div', { className: 'receipt-review-actions' });
  if ((item.items || []).length) {
    const options = bucketOptions(item);
    const editor = el('div', { className: 'receipt-review-editor', hidden: true });
    const list = el('div', { className: 'list-group' });
    (item.items || []).forEach((it, idx) => {
      const select = el('select', {
        className: 'receipt-review-bucket',
        'aria-label': `Envelope for ${it.desc}`,
        onChange: (e) => {
          if (!buckets) buckets = (item.items || []).map(x => x.bucket);
          buckets[idx] = e.target.value;
          renderSplits();
        },
      });
      options.forEach(id => {
        select.appendChild(el('option', { value: id, selected: id === it.bucket }, envelopeName(id)));
      });
      list.appendChild(el('div', { className: 'list-row receipt-review-line' },
        el('div', { className: 'list-row__body' },
          el('span', { className: 'list-row__title' }, it.desc),
          el('span', { className: 'list-row__meta money' }, formatCurrency(it.amount)),
        ),
        select,
      ));
    });
    editor.appendChild(list);
    editor.appendChild(el('p', { className: 'card-sub receipt-review-note' },
      'Tax and coupons are shared out by each envelope’s share. Tap Approve to save.'));
    const editBtn = el('button', {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      'aria-expanded': 'false',
      onClick: () => {
        editor.hidden = !editor.hidden;
        editBtn.setAttribute('aria-expanded', String(!editor.hidden));
        editBtn.textContent = editor.hidden ? 'Edit' : 'Done';
      },
    }, 'Edit');
    actions.appendChild(editBtn);
    wrap.appendChild(editor);
  }
  actions.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-secondary btn-sm',
    'aria-label': `Dismiss receipt from ${item.store || 'store'}`,
    onClick: () => {
      const res = store.dismissReceiptReview(item.receiptId);
      if (res?.ok) showToast('Dismissed · receipt removed from review', 'info');
    },
  }, 'Dismiss'));
  wrap.appendChild(actions);
  return wrap;
}

/** @returns {HTMLElement|null} */
export function renderReceiptReviewCard() {
  if (!store.canWriteBudget()) return null;
  let list;
  try {
    list = store.getReceiptReview();
  } catch (err) {
    console.warn('Receipt review unavailable', err);
    return null;
  }
  if (!list?.length) return null;

  const card = el('section', { className: 'card section receipt-review', 'aria-labelledby': 'receipt-review-title' });
  card.appendChild(el('div', { className: 'section-title-row' },
    el('h3', { className: 'section-title', id: 'receipt-review-title' }, 'Receipts to review'),
    el('span', { className: 'count-badge', 'aria-label': `${list.length} waiting` }, String(list.length)),
  ));
  card.appendChild(el('p', { className: 'card-sub receipt-review-intro' },
    'FigPig read these receipts but couldn’t place the split on its own. Nothing changes until you tap Approve.'));
  list.slice(0, MAX_REVIEW_ROWS).forEach(entry => card.appendChild(reviewItem(entry)));
  if (list.length > MAX_REVIEW_ROWS) {
    card.appendChild(el('p', { className: 'card-sub' }, `+ ${list.length - MAX_REVIEW_ROWS} more after these`));
  }
  return card;
}
