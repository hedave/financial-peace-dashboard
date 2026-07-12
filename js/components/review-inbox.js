import { el, formatCurrency, formatDate } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from './modal.js';

function duplicateGroupDateLabel(items) {
  const dates = [...new Set(items.map(t => t.date))].sort();
  if (dates.length <= 1) return formatDate(dates[0]);
  return `${formatDate(dates[0])} – ${formatDate(dates[dates.length - 1])}`;
}

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

function confirmDeleteTransaction(t, { onDone, label = 'this transaction' } = {}) {
  confirmDialog(
    'Delete transaction?',
    `Remove ${label}? Checking balance is updated if this was already cleared.`,
    () => {
      if (store.deleteTransaction(t.id)) {
        showToast('Transaction deleted');
        onDone?.();
        window.appRefresh();
      }
    },
  );
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
  if (inbox.pending?.length) {
    parts.push(`${inbox.pending.length} awaiting bank`);
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
      inbox.pending?.length ? el('button', {
        className: 'btn btn-secondary btn-sm',
        onClick: () => openPendingReview(inbox),
      }, 'Pending') : null,
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

export function openPendingReview(inbox = store.getReviewInbox()) {
  const pending = inbox.pending || store.getPendingTransactions();
  if (!pending.length) {
    showToast('No pending bank transactions', 'info');
    return;
  }

  const list = el('div', { className: 'review-list' });
  let modal;

  function paint() {
    const items = store.getPendingTransactions();
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('p', { style: 'color:var(--text-muted)' }, 'All caught up — nothing awaiting the bank.'));
      return;
    }
    items.forEach(t => {
      list.appendChild(el('div', { className: 'review-item' },
        el('div', {},
          el('strong', {}, formatDate(t.date)),
          el('div', {}, t.description || '—'),
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted)' },
            `${TX_TYPE_LABELS[t.type] || t.type} · ${formatCurrency(t.amount)}`,
          ),
        ),
        el('div', { className: 'btn-group' },
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-primary',
            onClick: () => {
              store.updateTransaction(t.id, { clearingStatus: 'cleared' });
              showToast('Marked cleared — checking updated', 'success');
              paint();
              window.appRefresh();
            },
          }, 'Mark cleared'),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => confirmDeleteTransaction(t, {
              label: 'this pending log',
              onDone: () => {
                paint();
                if (!store.getPendingTransactions().length) modal?.close();
              },
            }),
          }, 'Delete'),
        ),
      ));
    });
  }

  paint();

  modal = showModal({
    title: 'Awaiting bank (pending)',
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        'These were logged manually and do not change checking until they match a CSV import — or you mark them cleared.',
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
          window.appNavigate('transactions', { typeFilter: 'pending' });
        },
      }, 'Open Transactions'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}

export function openDuplicateReview() {
  const list = el('div', { className: 'review-list duplicate-review-list' });
  let modal;

  function paint() {
    const groups = store.getDuplicateTransactionGroups();
    list.innerHTML = '';
    if (!groups.length) {
      list.appendChild(el('p', { style: 'color:var(--text-muted)' }, 'No possible duplicates left.'));
      return;
    }
    groups.forEach(items => {
      list.appendChild(el('div', { className: 'duplicate-review-group' },
        el('div', { className: 'duplicate-review-group-header' },
          el('div', {},
            el('strong', {}, duplicateGroupDateLabel(items)),
            ' · ',
            formatCurrency(items[0].amount),
            el('span', { className: 'duplicate-review-count' }, `${items.length} entries`),
          ),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-primary',
            title: 'Confirm all of these are real purchases (not double-posts)',
            onClick: () => {
              store.markTransactionsUnique(items.map(t => t.id));
              showToast(
                items.length === 2
                  ? 'Marked both as unique — warning cleared'
                  : `Marked ${items.length} as unique — warning cleared`,
                'success',
              );
              paint();
              window.appRefresh();
              if (!store.getDuplicateTransactionGroups().length) modal?.close();
            },
          }, items.length === 2 ? 'Both unique' : 'All unique'),
        ),
        ...items.map(t => el('div', { className: 'review-item duplicate-review-item' },
          el('div', {},
            el('div', { className: 'review-item-main' }, t.description || '—'),
            el('div', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.15rem' },
              `${formatDate(t.date)} · ${TX_TYPE_LABELS[t.type] || t.type || '—'}`,
              store.isPending?.(t) ? ' · Pending' : '',
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
              className: 'btn btn-sm btn-accent',
              title: 'This one is a real purchase — stop flagging it',
              onClick: () => {
                store.markTransactionsUnique([t.id]);
                showToast('Marked unique', 'success');
                paint();
                window.appRefresh();
                if (!store.getDuplicateTransactionGroups().length) modal?.close();
              },
            }, 'Keep'),
            el('button', {
              type: 'button',
              className: 'btn btn-sm btn-danger',
              onClick: () => confirmDeleteTransaction(t, {
                label: 'this entry (keep the other if it is the real one)',
                onDone: () => {
                  paint();
                  if (!store.getDuplicateTransactionGroups().length) modal?.close();
                },
              }),
            }, 'Delete'),
          ),
        )),
      ));
    });
  }

  paint();
  if (!list.children.length) {
    showToast('No duplicate transactions found', 'info');
    return;
  }

  modal = showModal({
    title: 'Possible Duplicate Transactions',
    body: el('div', {},
      el('p', { className: 'tx-form-hint' },
        'Same amount and similar merchant. Delete true double-posts, or mark as unique when both are real (e.g. two kids, same purchase).',
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
          window.appNavigate('transactions', { typeFilter: 'duplicates' });
        },
      }, 'Open Transactions'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}

export function openReviewInbox(inbox = store.getReviewInbox()) {
  const state = store.getState();
  let txs = inbox.uncategorized || [];
  if (!txs.length) {
    showToast('Nothing to review!', 'info');
    return;
  }

  const selected = new Set();
  const catSelect = buildCategorySelect(state);
  const list = el('div', { className: 'review-list' });
  let modal;

  function paint() {
    txs = store.getReviewInbox().uncategorized;
    selected.clear();
    list.innerHTML = '';
    if (!txs.length) {
      list.appendChild(el('p', { style: 'color:var(--text-muted)' }, 'Nothing left to categorize.'));
      return;
    }
    txs.slice(0, 50).forEach(t => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(t.id);
        else selected.delete(t.id);
      });
      list.appendChild(el('div', { className: 'review-item' },
        el('label', { className: 'review-item-check' }, cb),
        el('div', { className: 'review-item-main', style: 'flex:1;min-width:0' },
          el('strong', {}, formatDate(t.date)),
          ' · ',
          t.description || '—',
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
            onClick: () => confirmDeleteTransaction(t, {
              onDone: () => {
                paint();
                if (!store.getReviewInbox().uncategorized.length) modal?.close();
              },
            }),
          }, 'Delete'),
        ),
      ));
    });
  }

  paint();

  modal = showModal({
    title: 'Review uncategorized',
    body: el('div', {},
      el('p', { className: 'tx-form-hint' },
        'Select transactions and assign an envelope, edit individually, or delete mistakes/duplicates.',
      ),
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        style: 'margin-bottom:0.75rem',
        onClick: () => {
          const n = store.applyRulesToUncategorized();
          showToast(n ? `Applied rules to ${n} transactions` : 'No rules matched', n ? 'success' : 'info');
          paint();
          window.appRefresh();
        },
      }, 'Apply saved rules'),
      list,
      el('div', { className: 'form-group', style: 'margin-top:1rem' },
        el('label', {}, 'Assign selected to envelope'),
        catSelect,
      ),
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-danger',
        onClick: () => {
          if (!selected.size) {
            showToast('Select at least one transaction to delete', 'info');
            return;
          }
          confirmDialog(
            'Delete selected?',
            `Remove ${selected.size} transaction${selected.size === 1 ? '' : 's'} and reverse any checking impact?`,
            () => {
              [...selected].forEach(id => store.deleteTransaction(id));
              showToast('Deleted selected');
              paint();
              window.appRefresh();
              if (!store.getReviewInbox().uncategorized.length) modal.close();
            },
          );
        },
      }, 'Delete selected'),
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
          paint();
          window.appRefresh();
          if (!store.getReviewInbox().uncategorized.length) modal.close();
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

  const list = el('div', { className: 'review-list' });
  let modal;

  function paint() {
    const next = store.getReviewInbox().billMatches;
    list.innerHTML = '';
    if (!next.length) {
      list.appendChild(el('p', { style: 'color:var(--text-muted)' }, 'No bill matches left.'));
      return;
    }
    next.forEach(({ transaction: t, bill }) => {
      list.appendChild(el('div', { className: 'review-item bill-match-item' },
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
        el('div', { className: 'btn-group' },
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-primary',
            onClick: () => {
              store.linkTransactionToBill(t.id, bill.id);
              showToast(`Linked to ${bill.name}`);
              paint();
              window.appRefresh();
              if (!store.getReviewInbox().billMatches.length) modal?.close();
            },
          }, 'Link'),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => confirmDeleteTransaction(t, {
              label: 'this transaction',
              onDone: () => {
                paint();
                if (!store.getReviewInbox().billMatches.length) modal?.close();
              },
            }),
          }, 'Delete'),
        ),
      ));
    });
  }

  paint();

  modal = showModal({
    title: 'Possible bill matches',
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        'Link bank expenses to unpaid bills, or delete if the match is wrong.',
      ),
      list,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}
