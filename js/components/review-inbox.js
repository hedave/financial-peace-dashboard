import { el, formatCurrency, formatDate } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, showUndoToast, confirmDialog } from './modal.js';
import { guessMerchantPattern } from '../category-rules.js';
import { createEnvelopePicker } from './envelope-picker.js';

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

/** Envelope remaining for option labels / hints (current month). */
function envelopeRemainingText(categoryId) {
  const rem = store.getCategoryRemaining(categoryId);
  if (rem < -0.005) return `${formatCurrency(Math.abs(rem))} over`;
  return `${formatCurrency(rem)} left`;
}

function confirmDeleteTransaction(t, { onDone, label = 'this transaction' } = {}) {
  confirmDialog(
    'Delete transaction?',
    `Remove ${label}? Checking balance is updated if this was already cleared.`,
    () => {
      if (store.deleteTransaction(t.id)) {
        showUndoToast('Transaction deleted', () => {
          const u = store.undoLastAction();
          if (u.ok) {
            showToast('Transaction restored', 'success');
            window.appRefresh();
          }
        });
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

  function softChrome() {
    // Never fall through to full appRefresh — that rebuilds the page and feels like a kick-out
    window.appSoftRefresh?.();
  }

  function remainingGroups() {
    return store.getDuplicateTransactionGroups();
  }

  function updateProgress(groups) {
    const n = groups.length;
    const flagged = groups.reduce((s, g) => s + g.length, 0);
    progressEl.textContent = n
      ? `${n} group${n === 1 ? '' : 's'} · ${flagged} transaction${flagged === 1 ? '' : 's'} to review`
      : 'All clear — hit Done when you’re finished';
    if (modal?.setTitle) {
      modal.setTitle(n ? `Possible duplicates · ${n} left` : 'Possible duplicates · done');
    }
  }

  /** Re-paint list in place. Never auto-close — user hits Done (avoids pair-by-pair kick-out). */
  function afterAction(toastMsg, toastType = 'success') {
    if (toastMsg) showToast(toastMsg, toastType);
    // Defer paint so confirm dialogs / nested modals finish unmounting first
    queueMicrotask(() => {
      paint();
      softChrome();
    });
  }

  function paint() {
    const groups = remainingGroups();
    list.innerHTML = '';
    updateProgress(groups);

    if (!groups.length) {
      list.appendChild(el('p', { className: 'review-empty-msg' },
        'No possible duplicates left. Nice work — click Done to close.'));
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
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            store.markTransactionsUnique(items.map(t => t.id));
            afterAction(
              items.length === 2
                ? 'Marked both as unique'
                : `Marked ${items.length} as unique`,
            );
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
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                import('../pages/transactions.js').then(m => {
                  m.openTransactionForm({
                    transaction: t,
                    onSaved: () => afterAction('Transaction updated'),
                  });
                });
              },
            }, 'Edit'),
            el('button', {
              type: 'button',
              className: 'btn btn-sm btn-accent',
              title: 'This one is a real purchase — stop flagging it',
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                store.markTransactionsUnique([t.id]);
                afterAction('Marked unique');
              },
            }, 'Keep'),
            el('button', {
              type: 'button',
              className: 'btn btn-sm btn-danger',
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                confirmDeleteTransaction(t, {
                  label: 'this entry (keep the other if it is the real one)',
                  onDone: () => afterAction('Deleted'),
                });
              },
            }, 'Delete'),
          ),
        ));
      });

      list.appendChild(group);
    });
  }

  modal = showModal({
    title: `Possible duplicates · ${groupsAtOpen.length} left`,
    body: el('div', { className: 'duplicate-review-body' },
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:0.5rem' },
        'Same amount and similar merchant. Delete true double-posts, or mark unique when both are real. This window stays open until you click Done.',
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
    // Don’t dismiss by clicking the dimmed backdrop (desktop misfires are common)
    closeOnBackdrop: false,
    onClose: () => softChrome(),
  });
  modal.modal.classList.add('modal-wide', 'modal-duplicate-review', 'modal-scrollable');
  paint();
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
  const envelopePicker = createEnvelopePicker({
    id: 'bulk-cat',
    placeholder: 'Type to find envelope (e.g. P for Pets)…',
    emptyLabel: '— Choose envelope —',
    showRemaining: true,
    allowEmpty: true,
  });
  const remainingHint = el('p', {
    className: 'tx-form-hint review-envelope-remaining',
    style: 'margin-top:0.4rem;margin-bottom:0',
  }, 'Pick an envelope to see what’s left this month.');
  const alwaysUse = el('input', { type: 'checkbox' });
  alwaysUse.checked = true;
  const list = el('div', { className: 'review-list' });
  let modal;

  function selectedAmountSum() {
    let sum = 0;
    const all = store.getState().transactions || [];
    selected.forEach(id => {
      const t = all.find(x => x.id === id);
      if (t) sum += Math.abs(Number(t.amount) || 0);
    });
    return Math.round(sum * 100) / 100;
  }

  function updateRemainingHint() {
    const catId = envelopePicker.value;
    if (!catId) {
      remainingHint.textContent = 'Pick an envelope to see what’s left this month.';
      remainingHint.style.color = '';
      return;
    }
    const cat = store.getState().categories.find(c => c.id === catId);
    const rem = store.getCategoryRemaining(catId);
    const name = cat ? `${cat.icon || ''} ${cat.name}`.trim() : 'Envelope';
    const nSel = selected.size;
    const sum = selectedAmountSum();
    let line = `${name}: ${envelopeRemainingText(catId)} this month`;
    if (nSel > 0 && sum > 0) {
      const after = rem - sum;
      const afterTxt = after < -0.005
        ? `${formatCurrency(Math.abs(after))} over`
        : `${formatCurrency(after)} left`;
      line += ` · after ${nSel} selected (${formatCurrency(sum)}): ${afterTxt}`;
      remainingHint.style.color = after < -0.005 ? 'var(--negative)' : '';
    } else {
      remainingHint.style.color = rem < -0.005 ? 'var(--negative)' : '';
    }
    remainingHint.textContent = line;
  }

  envelopePicker.addEventListener('change', updateRemainingHint);

  function paint() {
    txs = store.getReviewInbox().uncategorized;
    selected.clear();
    envelopePicker.refresh();
    list.innerHTML = '';
    if (!txs.length) {
      list.appendChild(el('p', { style: 'color:var(--text-muted)' }, 'Nothing left to categorize.'));
      updateRemainingHint();
      return;
    }
    txs.slice(0, 50).forEach(t => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(t.id);
        else selected.delete(t.id);
        row.classList.toggle('is-selected', cb.checked);
        updateRemainingHint();
      });
      const row = el('div', { className: 'review-item' },
        el('label', { className: 'review-item-check' }, cb),
        el('div', { className: 'review-item-main', style: 'flex:1;min-width:0' },
          el('strong', {}, formatDate(t.date)),
          el('div', { className: 'review-item-desc' }, t.description || '—'),
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
                  splitMode: store.isSplitTransaction(t),
                  onSaved: () => {
                    paint();
                    window.appSoftRefresh?.();
                    if (!store.getReviewInbox().uncategorized.length) modal?.close();
                  },
                });
              });
            },
          }, 'Edit / split'),
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
      );
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, input, a, .envelope-picker')) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      list.appendChild(row);
    });
    updateRemainingHint();
  }

  paint();

  modal = showModal({
    title: 'Review uncategorized',
    body: el('div', { className: 'review-uncat' },
      el('p', { className: 'tx-form-hint' },
        'Tap a row to select it. Assign at the bottom, or Edit / split one charge.',
      ),
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        style: 'margin-bottom:0.65rem',
        onClick: () => {
          const n = store.applyRulesToUncategorized();
          showToast(n ? `Applied rules to ${n} transactions` : 'No rules matched', n ? 'success' : 'info');
          paint();
          window.appSoftRefresh?.();
          if (!store.getReviewInbox().uncategorized.length) modal?.close();
        },
      }, 'Apply saved rules'),
      list,
      el('div', { className: 'review-assign-dock' },
        el('div', { className: 'form-group', style: 'margin-bottom:0.5rem' },
          el('label', { for: 'bulk-cat' }, 'Assign selected to envelope'),
          envelopePicker.element,
          remainingHint,
        ),
        el('div', { className: 'form-option remember-rule', style: 'margin:0.35rem 0 0.65rem' },
          el('div', { className: 'form-option-text' },
            el('span', { className: 'form-option-label' }, 'Always use this envelope'),
            el('span', { className: 'form-option-hint' },
              'Save a rule for this merchant on future imports',
            ),
          ),
          el('label', { className: 'toggle-switch' },
            alwaysUse,
            el('span', { className: 'toggle-slider' }),
          ),
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
          envelopePicker.commitTyped?.();
          if (!envelopePicker.value) {
            showToast('Choose an envelope', 'info');
            return;
          }
          const ids = [...selected];
          const categoryId = envelopePicker.value;
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
      const txAmt = Math.abs(Number(t.amount)) || 0;
      const billAmt = Math.abs(Number(bill.amount)) || 0;
      const amtDiff = Math.round((txAmt - billAmt) * 100) / 100;
      const amtNote = Math.abs(amtDiff) > 0.02
        ? `Bank ${formatCurrency(txAmt)} vs planned ${formatCurrency(billAmt)} (${amtDiff > 0 ? '+' : ''}${formatCurrency(amtDiff)})`
        : `Amount ${formatCurrency(txAmt)}`;
      list.appendChild(el('div', { className: 'review-item bill-match-item' },
        el('div', {},
          el('strong', {}, bill.name),
          bill.autoPay ? el('span', { className: 'badge badge-autopay', style: 'margin-left:0.35rem' }, 'Auto-pay') : null,
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem' },
            `${formatDate(t.date)} · ${t.description || '—'} · ${amtNote}`
          ),
          Math.abs(amtDiff) > 0.02
            ? el('div', {
              className: 'tx-form-hint',
              style: 'margin-top:0.35rem;margin-bottom:0',
            }, 'Amount differs from the bill plan — linking still marks it paid using the bank amount.')
            : null,
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
