import { el, formatCurrency, formatDate } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from './modal.js';

const TX_TYPE_LABELS = {
  expense: 'Expense',
  income: 'Income',
  debt_payment: 'Debt Payment',
  transfer: 'Transfer',
  celebration: 'Celebration',
};

function buildCategorySelect(state, id = 'bulk-cat') {
  const select = el('select', { id },
    el('option', { value: '' }, '— Choose envelope —'),
    ...state.categories.map(c => el('option', { value: c.id }, `${c.icon || ''} ${c.name}`.trim())),
  );
  return select;
}

export function renderReviewBanner(inbox) {
  if (!inbox.totalCount) return null;

  const parts = [];
  if (inbox.uncategorized.length) {
    parts.push(`${inbox.uncategorized.length} need categories`);
  }
  if (inbox.billMatches.length) {
    parts.push(`${inbox.billMatches.length} bill matches`);
  }
  if (inbox.duplicates?.length) {
    parts.push(`${inbox.duplicates.length} possible duplicate${inbox.duplicates.length === 1 ? '' : 's'}`);
  }

  return el('div', { className: 'banner banner-action review-banner' },
    el('div', { className: 'banner-icon' }, '📥'),
    el('div', { className: 'banner-text' },
      el('h3', {}, 'Review inbox'),
      el('p', {}, parts.join(' · '))
    ),
    el('div', { className: 'btn-group', style: 'margin-left:auto' },
      inbox.uncategorized.length ? el('button', {
        className: 'btn btn-primary btn-sm',
        onClick: () => openReviewInbox(inbox),
      }, 'Review') : null,
      inbox.billMatches.length ? el('button', {
        className: 'btn btn-accent btn-sm',
        onClick: () => openBillMatches(inbox),
      }, 'Match Bills') : null,
      inbox.duplicates?.length ? el('button', {
        className: 'btn btn-secondary btn-sm',
        onClick: () => openDuplicateReview(inbox),
      }, 'Duplicates') : null,
    ),
  );
}

export function openDuplicateReview() {
  const groups = store.getDuplicateTransactionGroups();
  if (!groups.length) {
    showToast('No duplicate transactions found', 'info');
    return;
  }

  const list = el('div', { className: 'review-list duplicate-review-list' },
    ...groups.map(items => el('div', { className: 'duplicate-review-group' },
      el('div', { className: 'duplicate-review-group-header' },
        el('strong', {}, formatDate(items[0].date)),
        ' · ',
        formatCurrency(items[0].amount),
        el('span', { className: 'duplicate-review-count' }, `${items.length} entries`),
      ),
      ...items.map(t => el('div', { className: 'review-item duplicate-review-item' },
        el('div', {},
          el('div', { className: 'review-item-main' }, t.description || '—'),
          el('div', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem' },
            TX_TYPE_LABELS[t.type] || t.type || '—'
          ),
        ),
        el('span', { className: 'review-item-amt' }, formatCurrency(t.amount)),
        el('div', { className: 'btn-group' },
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-secondary',
            onClick: () => {
              import('../pages/transactions.js').then(m => {
                m.openTransactionForm({ transaction: t });
              });
            },
          }, 'Edit'),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => {
              confirmDialog('Delete Transaction', 'Remove this duplicate and reverse its balance impact?', () => {
                store.update(s => {
                  const tx = s.transactions.find(x => x.id === t.id);
                  if (!tx) return;
                  s.balances.checking -= store.getCheckingDelta(tx.type, tx.amount);
                  if (tx.type === 'debt_payment' && tx.debtId) {
                    store.adjustDebtForPayment(s, tx.debtId, -Math.abs(Number(tx.amount) || 0));
                  }
                  s.transactions = s.transactions.filter(x => x.id !== t.id);
                });
                showToast('Transaction deleted');
                modal.close();
                window.appRefresh();
              });
            },
          }, 'Delete'),
        ),
      )),
    )),
  );

  const modal = showModal({
    title: 'Possible Duplicate Transactions',
    body: el('div', {},
      el('p', { className: 'tx-form-hint' },
        'These entries share the same date and dollar amount. Delete any extras from a bad import or double-entry.'
      ),
      list,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          modal.close();
          window.appNavigate('transactions');
          setTimeout(() => {
            const typeEl = document.querySelector('#tx-type-filter');
            if (typeEl) {
              typeEl.value = 'duplicates';
              typeEl.dispatchEvent(new Event('change'));
            }
          }, 100);
        },
      }, 'Open Transactions'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}

export function openReviewInbox(inbox = store.getReviewInbox()) {
  const state = store.getState();
  const txs = inbox.uncategorized;
  if (!txs.length) {
    showToast('Nothing to review!', 'info');
    return;
  }

  const selected = new Set();
  const catSelect = buildCategorySelect(state);

  const list = el('div', { className: 'review-list' },
    ...txs.slice(0, 50).map(t => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(t.id);
        else selected.delete(t.id);
      });
      return el('label', { className: 'review-item' },
        cb,
        el('span', { className: 'review-item-main' },
          el('strong', {}, formatDate(t.date)),
          ' · ',
          t.description || '—',
        ),
        el('span', { className: 'review-item-amt' }, formatCurrency(t.amount)),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: (e) => {
            e.preventDefault();
            import('../pages/transactions.js').then(m => {
              m.openTransactionForm({ transaction: t });
            });
          },
        }, 'Edit'),
      );
    }),
  );

  const modal = showModal({
    title: `Review ${txs.length} Transaction${txs.length === 1 ? '' : 's'}`,
    body: el('div', {},
      el('p', { className: 'tx-form-hint' }, 'Select transactions and assign an envelope, or edit individually.'),
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        style: 'margin-bottom:0.75rem',
        onClick: () => {
          const n = store.applyRulesToUncategorized();
          showToast(n ? `Applied rules to ${n} transactions` : 'No rules matched', n ? 'success' : 'info');
          modal.close();
          window.appRefresh();
        },
      }, 'Apply saved rules'),
      list,
      txs.length > 50 ? el('p', { style: 'font-size:0.8rem;color:var(--text-muted)' }, `Showing 50 of ${txs.length}`) : null,
      el('div', { className: 'form-group', style: 'margin-top:1rem' },
        el('label', {}, 'Assign selected to envelope'),
        catSelect,
      ),
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          if (!selected.size) {
            showToast('Select at least one transaction', 'info');
            return;
          }
          if (!catSelect.value) {
            showToast('Choose an envelope', 'info');
            return;
          }
          store.bulkCategorizeTransactions([...selected], catSelect.value);
          showToast(`Updated ${selected.size} transactions`);
          modal.close();
          window.appRefresh();
        },
      }, 'Assign Selected'),
      el('button', {
        type: 'button',
        className: 'btn btn-accent',
        onClick: () => {
          modal.close();
          window.appNavigate('transactions');
        },
      }, 'Open Transactions'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}

export function openBillMatches(inbox = store.getReviewInbox()) {
  const matches = inbox.billMatches;
  if (!matches.length) {
    showToast('No bill matches pending', 'info');
    return;
  }

  const list = el('div', { className: 'review-list' },
    ...matches.map(({ transaction: t, bill }) =>
      el('div', { className: 'review-item bill-match-item' },
        el('div', {},
          el('strong', {}, bill.name),
          bill.autoPay ? el('span', { className: 'badge badge-autopay', style: 'margin-left:0.35rem' }, 'Auto-pay') : null,
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem' },
            `${formatDate(t.date)} · ${t.description || '—'} · ${formatCurrency(t.amount)}`
          ),
          bill.autoPay ? el('div', { className: 'tx-form-hint', style: 'margin-top:0.5rem;margin-bottom:0' },
            'Linking marks the bill paid without deducting checking again (CSV already did).'
          ) : null,
        ),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-primary',
          onClick: () => {
            store.linkTransactionToBill(t.id, bill.id);
            showToast(`${bill.name} linked & marked paid`);
            window.appRefresh();
          },
        }, 'Link & Mark Paid'),
      )
    ),
  );

  const modal = showModal({
    title: 'Bill Matches',
    body: el('div', {},
      el('p', { style: 'margin-bottom:1rem;color:var(--text-muted);font-size:0.9rem' },
        'These bank charges look like unpaid bills. Link them instead of using Mark Paid separately.'
      ),
      list,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const n = store.linkAllBillMatches();
          showToast(`Linked ${n} bill${n === 1 ? '' : 's'}`);
          modal.close();
          window.appRefresh();
        },
      }, 'Link All'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}