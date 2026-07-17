import { el, formatCurrency, formatDate } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from './modal.js';
import { guessMerchantPattern } from '../category-rules.js';

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
      inbox.totalCount ? el('button', {
        className: 'btn btn-primary btn-sm',
        onClick: () => openReviewInbox(),
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
              window.appSoftRefresh?.();
              if (!store.getPendingTransactions().length) modal?.close();
            },
          }, 'Mark cleared'),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => confirmDeleteTransaction(t, {
              label: 'this pending log',
              onDone: () => {
                paint();
                window.appSoftRefresh?.();
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
  modal.modal.classList.add('modal-wide', 'modal-scrollable');
}

export function openDuplicateReview() {
  const groupsAtOpen = store.getDuplicateTransactionGroups();
  if (!groupsAtOpen.length) {
    showToast('No duplicate transactions found', 'info');
    return;
  }

  const progressEl = el('div', { className: 'review-progress' });
  const list = el('div', { className: 'review-list duplicate-review-list' });
  let modal;
  let closedByEmpty = false;

  function softChrome() {
    window.appSoftRefresh?.() || window.appRefresh?.();
  }

  function remainingGroups() {
    return store.getDuplicateTransactionGroups();
  }

  function updateProgress(groups) {
    const n = groups.length;
    const flagged = groups.reduce((s, g) => s + g.length, 0);
    progressEl.textContent = n
      ? `${n} group${n === 1 ? '' : 's'} · ${flagged} transaction${flagged === 1 ? '' : 's'} to review`
      : 'All clear';
    if (modal?.setTitle) {
      modal.setTitle(n ? `Possible duplicates · ${n} left` : 'Possible duplicates');
    }
  }

  /** Stay in the modal until the user finishes or explicitly closes. */
  function finishIfEmpty() {
    if (remainingGroups().length) return false;
    closedByEmpty = true;
    showToast('All possible duplicates reviewed', 'success');
    // Brief beat so the empty state is visible, then close
    setTimeout(() => modal?.close(), 280);
    return true;
  }

  function paint() {
    const groups = remainingGroups();
    list.innerHTML = '';
    updateProgress(groups);

    if (!groups.length) {
      list.appendChild(el('p', { className: 'review-empty-msg' }, 'No possible duplicates left. Nice work.'));
      return;
    }

    groups.forEach((items, groupIndex) => {
      const group = el('div', { className: 'duplicate-review-group' });
      group.appendChild(el('div', { className: 'duplicate-review-group-header' },
        el('div', { className: 'duplicate-review-group-title' },
          el('span', { className: 'duplicate-review-group-index' }, `${groupIndex + 1}/${groups.length}`),
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
                ? 'Marked both as unique'
                : `Marked ${items.length} as unique`,
              'success',
            );
            paint();
            softChrome();
            finishIfEmpty();
          },
        }, items.length === 2 ? 'Both unique' : 'All unique'),
      ));

      items.forEach(t => {
        const meta = [
          formatDate(t.date),
          TX_TYPE_LABELS[t.type] || t.type || '—',
          store.isPending?.(t) ? 'Pending' : null,
        ].filter(Boolean).join(' · ');

        group.appendChild(el('div', { className: 'duplicate-review-item' },
          el('div', { className: 'duplicate-review-item-row' },
            el('div', { className: 'review-item-main' },
              t.description || '—',
              el('div', { className: 'duplicate-review-item-meta' }, meta),
            ),
            el('span', { className: 'review-item-amt' }, formatCurrency(t.amount)),
          ),
          el('div', { className: 'btn-group' },
            el('button', {
              type: 'button',
              className: 'btn btn-sm btn-secondary',
              onClick: () => {
                import('../pages/transactions.js').then(m => {
                  m.openTransactionForm({
                    transaction: t,
                    onSaved: () => {
                      paint();
                      softChrome();
                      finishIfEmpty();
                    },
                  });
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
                softChrome();
                finishIfEmpty();
              },
            }, 'Keep'),
            el('button', {
              type: 'button',
              className: 'btn btn-sm btn-danger',
              onClick: () => confirmDeleteTransaction(t, {
                label: 'this entry (keep the other if it is the real one)',
                onDone: () => {
                  paint();
                  softChrome();
                  finishIfEmpty();
                },
              }),
            }, 'Delete'),
          ),
        ));
      });

      list.appendChild(group);
    });
  }

  paint();

  modal = showModal({
    title: `Possible duplicates · ${groupsAtOpen.length} left`,
    body: el('div', { className: 'duplicate-review-body' },
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:0.5rem' },
        'Same amount and similar merchant. Delete true double-posts, or mark unique when both are real (e.g. two kids). This window stays open until you finish.',
      ),
      progressEl,
      list,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Done'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          modal.close();
          window.appNavigate('transactions', { typeFilter: 'duplicates' });
        },
      }, 'Open Transactions'),
    ],
    onClose: () => {
      if (!closedByEmpty) softChrome();
    },
  });
  modal.modal.classList.add('modal-wide', 'modal-duplicate-review', 'modal-scrollable');
}

/**
 * Entry point for "Review (N)" — totalCount includes uncategorized, bill matches,
 * duplicates, and pending. Route to the only queue, or show a chooser when mixed.
 */
export function openReviewInbox(_inbox) {
  const inbox = store.getReviewInbox();
  if (!inbox.totalCount) {
    showToast('Nothing to review!', 'info');
    return;
  }

  const queues = [];
  if (inbox.uncategorized.length) {
    queues.push({
      id: 'uncategorized',
      label: 'Need categories',
      count: inbox.uncategorized.length,
      open: () => openUncategorizedReview(),
    });
  }
  if (inbox.pending?.length) {
    queues.push({
      id: 'pending',
      label: 'Awaiting bank',
      count: inbox.pending.length,
      open: () => openPendingReview(),
    });
  }
  if (inbox.billMatches.length) {
    queues.push({
      id: 'bills',
      label: 'Bill matches',
      count: inbox.billMatches.length,
      open: () => openBillMatches(),
    });
  }
  if (inbox.duplicates?.length) {
    queues.push({
      id: 'duplicates',
      label: 'Possible duplicates',
      count: inbox.duplicates.length,
      open: () => openDuplicateReview(),
    });
  }

  if (!queues.length) {
    showToast('Nothing to review!', 'info');
    return;
  }

  // Single queue → open it directly (no extra click)
  if (queues.length === 1) {
    queues[0].open();
    return;
  }

  // Prefer uncategorized if present (most common import follow-up)
  // but still offer the hub so other counts aren't a dead end
  let hub;
  hub = showModal({
    title: `Review inbox (${inbox.totalCount})`,
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        'Choose what to work through. The Review count includes all of these queues.',
      ),
      el('div', { className: 'review-hub-list' },
        ...queues.map(q => el('button', {
          type: 'button',
          className: 'btn btn-secondary review-hub-item',
          style: 'width:100%;justify-content:space-between;display:flex;margin-bottom:0.5rem',
          onClick: () => {
            // Open next first so modal stack never hits 0 (avoids page thrash / flash)
            q.open();
            hub.close();
          },
        },
          el('span', {}, q.label),
          el('span', { className: 'badge badge-due' }, String(q.count)),
        )),
      ),
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => hub.close() }, 'Close'),
    ],
  });
}

/** Uncategorized expenses only (assign envelopes / always-use rules). */
export function openUncategorizedReview() {
  const state = store.getState();
  let txs = store.getReviewInbox().uncategorized || [];
  if (!txs.length) {
    showToast('No uncategorized transactions', 'info');
    return;
  }

  const selected = new Set();
  const catSelect = buildCategorySelect(state);
  const alwaysUse = el('input', { type: 'checkbox' });
  alwaysUse.checked = true;
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
                m.openTransactionForm({
                  transaction: t,
                  rememberDefault: true,
                  onSaved: () => {
                    paint();
                    window.appSoftRefresh?.();
                    if (!store.getReviewInbox().uncategorized.length) modal?.close();
                  },
                });
              });
            },
          }, 'Edit'),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => confirmDeleteTransaction(t, {
              onDone: () => {
                paint();
                window.appSoftRefresh?.();
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
          window.appSoftRefresh?.();
          if (!store.getReviewInbox().uncategorized.length) modal?.close();
        },
      }, 'Apply saved rules'),
      list,
      el('div', { className: 'form-group', style: 'margin-top:1rem' },
        el('label', {}, 'Assign selected to envelope'),
        catSelect,
      ),
      el('div', { className: 'form-option remember-rule', style: 'margin-top:0.75rem' },
        el('div', { className: 'form-option-text' },
          el('span', { className: 'form-option-label' }, 'Always use this envelope'),
          el('span', { className: 'form-option-hint' },
            'Save merchant rules so future CSV/PDF imports auto-categorize the same way',
          ),
        ),
        el('label', { className: 'toggle-switch' },
          alwaysUse,
          el('span', { className: 'toggle-slider' }),
        ),
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
              window.appSoftRefresh?.();
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
          const ids = [...selected];
          const categoryId = catSelect.value;
          store.bulkCategorizeTransactions(ids, categoryId);
          let rulesSaved = 0;
          if (alwaysUse.checked) {
            const seen = new Set();
            ids.forEach(id => {
              const tx = store.getState().transactions.find(t => t.id === id);
              if (!tx) return;
              const pattern = guessMerchantPattern(tx.description);
              if (!pattern || seen.has(pattern)) return;
              seen.add(pattern);
              store.addCategoryRule({ pattern, type: 'category', categoryId });
              rulesSaved++;
            });
          }
          showToast(
            rulesSaved
              ? `Updated ${ids.length} · saved ${rulesSaved} always-use rule${rulesSaved === 1 ? '' : 's'}`
              : `Updated ${ids.length} transactions`,
            rulesSaved ? 'success' : undefined,
          );
          paint();
          window.appSoftRefresh?.();
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
  modal.modal.classList.add('modal-wide', 'modal-scrollable');
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
              window.appSoftRefresh?.();
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
                window.appSoftRefresh?.();
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
  modal.modal.classList.add('modal-wide', 'modal-scrollable');
}
