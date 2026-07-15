import { el, formatCurrency, formatDate } from './utils.js';
import { store } from './store.js';
import { showModal, showToast } from './components/modal.js';

/**
 * After bonus income is saved/imported, restore envelope funds if amount
 * matches a recent expense (returns — e.g. Happy Wife Happy Life).
 */
export function handleBonusReturnMatch(incomeTxId) {
  if (!incomeTxId) return;
  const result = store.tryMatchBonusReturn(incomeTxId);
  if (!result) return;

  if (result.auto) {
    showToast(
      `Return matched: ${formatCurrency(result.auto.amount)} restored to ${result.auto.categoryName}`,
      'success',
      5000,
    );
    return;
  }

  if (result.candidates?.length) {
    openReturnPicker(incomeTxId, result.candidates);
  }
}

function openReturnPicker(incomeTxId, candidates) {
  const state = store.getState();
  const income = state.transactions.find(t => t.id === incomeTxId);
  if (!income) return;

  let modal;
  const list = el('div', { className: 'review-list' },
    ...candidates.map(c => {
      const cat = state.categories.find(x => x.id === c.categoryId);
      const catLabel = cat ? `${cat.icon || '✉️'} ${cat.name}` : 'Envelope';
      return el('button', {
        type: 'button',
        className: 'review-item return-pick-row',
        style: 'width:100%;text-align:left;cursor:pointer;font-family:inherit',
        onClick: () => {
          const applied = store.applyReturnToEnvelope(
            incomeTxId,
            c.expense.id,
            c.categoryId,
            c.amount,
          );
          modal?.close();
          if (applied) {
            showToast(
              `Return matched: ${formatCurrency(applied.amount)} restored to ${applied.categoryName}`,
              'success',
              5000,
            );
            window.appRefresh();
          }
        },
      },
        el('div', {},
          el('strong', {}, catLabel),
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem' },
            `${formatDate(c.expense.date)} · ${c.expense.description || '—'} · ${formatCurrency(c.amount)}`,
          ),
        ),
      );
    }),
  );

  modal = showModal({
    title: 'Match return to envelope?',
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        `${formatCurrency(income.amount)} bonus income matches more than one recent purchase. Pick which return this is — that envelope gets the money back. Or skip.`,
      ),
      list,
    ),
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Skip — leave as bonus only'),
    ],
  });
  modal.modal.classList.add('modal-wide', 'modal-scrollable');
}

/** After CSV import, run return matching for new/cleared bonus income ids. */
export function handleBonusReturnsForIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const multi = [];
  unique.forEach(id => {
    const result = store.tryMatchBonusReturn(id);
    if (!result) return;
    if (result.auto) {
      showToast(
        `Return matched: ${formatCurrency(result.auto.amount)} restored to ${result.auto.categoryName}`,
        'success',
        4500,
      );
    } else if (result.candidates?.length) {
      multi.push({ id, candidates: result.candidates });
    }
  });
  // One picker at a time
  if (multi[0]) openReturnPicker(multi[0].id, multi[0].candidates);
}
