import { el, formatCurrency, formatDate, todayISO, daysUntil, generateId, emptyState, getCurrentMonth, getMonthLabel } from '../utils.js';
// Recurring bills: after pay, store advances due date +1 month and sets unpaid again.
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';
import { openTransactionForm } from './transactions.js';

function sortByDueDate(a, b) {
  if (!a.dueDate && !b.dueDate) return a.name.localeCompare(b.name);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  const byDate = a.dueDate.localeCompare(b.dueDate);
  return byDate !== 0 ? byDate : a.name.localeCompare(b.name);
}

export function renderBills(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const allBills = state.bills || [];
  const upcoming = allBills
    .filter(b => b.status !== 'paid')
    .sort(sortByDueDate);
  const paidThisMonth = store.getBillsPaidInMonth(month);
  const paidOneTime = allBills
    .filter(b => b.status === 'paid' && b.recurring === false)
    .sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Bills & Payments'),
    el('p', {}, 'Recurring bills reset to unpaid next cycle. Auto-pay bills complete on strong bank matches.')
  ));

  container.appendChild(el('div', { className: 'btn-group section' },
    el('button', { className: 'btn btn-primary', onClick: () => openBillForm() }, '+ Add Bill'),
  ));

  if (!allBills.length) {
    container.appendChild(emptyState('📋', 'No bills yet', 'Add your recurring bills to stay on top of due dates.'));
    return;
  }

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, `Upcoming Bills (${upcoming.length})`),
    upcoming.length
      ? billsTable(upcoming, state, 'upcoming')
      : el('div', { className: 'card', style: 'padding:1.25rem 1rem;color:var(--text-muted);font-size:0.9rem' },
          '✅ All caught up — no bills due right now.'
        ),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, `Paid this month — ${getMonthLabel(month)} (${paidThisMonth.length})`),
    paidThisMonth.length
      ? billsTable(paidThisMonth, state, 'paidThisMonth')
      : el('div', { className: 'card', style: 'padding:1.25rem 1rem;color:var(--text-muted);font-size:0.9rem' },
          'No bills marked paid this month yet. Recurring payments show here even after the next cycle is scheduled.',
        ),
  ));

  if (paidOneTime.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, `One-time paid (${paidOneTime.length})`),
      billsTable(paidOneTime, state, 'paid'),
    ));
  }
}

function billDisplay(bill, state, mode) {
  const paid = mode === 'paid' || mode === 'paidThisMonth';
  const cat = (state.categories || []).find(c => c.id === bill.categoryId);
  const days = bill.dueDate ? daysUntil(bill.dueDate) : NaN;
  let status = bill.status || 'pending';
  if (mode === 'paidThisMonth') {
    status = 'paid';
  } else if (!paid) {
    if (days < 0) status = 'overdue';
    else if (days <= 7) status = 'due_soon';
  } else {
    status = 'paid';
  }
  const amount = mode === 'paidThisMonth'
    ? (bill.lastPaidAmount != null ? bill.lastPaidAmount : (bill.paidAmount != null ? bill.paidAmount : bill.amount))
    : (paid && bill.paidAmount != null ? bill.paidAmount : bill.amount);
  const dateLabel = paid ? 'Paid' : 'Due';
  const dateVal = mode === 'paidThisMonth'
    ? formatDate(bill.lastPaidDate || bill.paidDate)
    : formatDate(paid ? bill.paidDate : bill.dueDate);
  const lastPaid = !paid && bill.lastPaidDate
    ? `Last paid ${formatDate(bill.lastPaidDate)}${bill.lastPaidAmount != null ? ` · ${formatCurrency(bill.lastPaidAmount)}` : ''}`
    : null;
  const nextDue = mode === 'paidThisMonth' && bill.recurring !== false && bill.dueDate
    ? `Next due ${formatDate(bill.dueDate)}`
    : null;
  return { cat, status, amount, dateLabel, dateVal, lastPaid, nextDue };
}

function billsTable(bills, state, variant) {
  const isPaid = variant === 'paid' || variant === 'paidThisMonth';
  const wrap = el('div', { className: 'bills-list' });

  // Desktop table
  wrap.appendChild(el('div', { className: 'card bill-desktop-list' },
    el('div', { className: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Bill'),
          el('th', {}, isPaid ? 'Paid Date' : 'Due Date'),
          el('th', {}, 'Amount'),
          el('th', {}, 'Category'),
          el('th', {}, 'Status'),
          el('th', {}, 'Actions'),
        )),
        el('tbody', {},
          ...bills.map(b => billRow(b, state, { mode: variant }))
        )
      )
    )
  ));

  // Mobile cards
  wrap.appendChild(el('div', { className: 'bill-mobile-list' },
    ...bills.map(b => billCard(b, state, { mode: variant }))
  ));

  return wrap;
}

function billMoreMenu(bill) {
  const menu = el('details', { className: 'tx-more-menu' });
  const summary = el('summary', {
    className: 'btn btn-sm btn-secondary tx-more-trigger',
    title: 'More actions',
  }, '⋯');
  summary.addEventListener('click', e => e.stopPropagation());

  const items = el('div', { className: 'tx-more-dropdown' });
  items.appendChild(el('button', {
    type: 'button',
    className: 'tx-more-item',
    onClick: () => {
      menu.removeAttribute('open');
      openBillForm(bill);
    },
  }, 'Edit'));
  items.appendChild(el('button', {
    type: 'button',
    className: 'tx-more-item tx-more-item-danger',
    onClick: () => {
      menu.removeAttribute('open');
      deleteBill(bill.id);
    },
  }, 'Delete'));

  menu.appendChild(summary);
  menu.appendChild(items);

  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    const close = e => {
      if (!menu.contains(e.target)) {
        menu.removeAttribute('open');
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  });

  return menu;
}

function billRow(bill, state, { mode = 'upcoming' } = {}) {
  const paid = mode === 'paid' || mode === 'paidThisMonth';
  const { cat, status, amount, dateVal, lastPaid, nextDue } = billDisplay(bill, state, mode);
  const hideMarkPaid = paid || mode === 'paidThisMonth';

  return el('tr', {
    className: paid ? 'bill-paid-row bill-row-clickable' : 'bill-row-clickable',
    title: 'Click to see related transactions',
    onClick: (e) => {
      if (e.target.closest('button, a, details, summary')) return;
      openBillActivity(bill);
    },
  },
    el('td', {},
      el('button', {
        type: 'button',
        className: 'linkish',
        onClick: (e) => { e.stopPropagation(); openBillActivity(bill); },
      }, bill.name),
      lastPaid
        ? el('div', { style: 'font-size:0.72rem;color:var(--text-muted);margin-top:0.15rem' }, lastPaid)
        : null,
      nextDue
        ? el('div', { style: 'font-size:0.72rem;color:var(--text-muted);margin-top:0.15rem' }, nextDue)
        : null,
      bill.recurring !== false && !paid
        ? el('div', { style: 'font-size:0.68rem;color:var(--text-muted)' }, 'Recurring')
        : null,
    ),
    el('td', {}, dateVal),
    el('td', {}, formatCurrency(amount)),
    el('td', {}, cat?.name || '—'),
    el('td', {}, statusBadge(status, bill.autoPay)),
    el('td', {},
      el('div', { className: 'btn-group' },
        hideMarkPaid || bill.status === 'paid' ? null : el('button', {
          className: 'btn btn-sm btn-primary',
          onClick: (e) => { e.stopPropagation(); markPaid(bill); },
        }, 'Mark Paid'),
        el('button', {
          className: 'btn btn-sm btn-secondary',
          onClick: (e) => { e.stopPropagation(); openBillForm(bill); },
        }, 'Edit'),
        el('button', {
          className: 'btn btn-sm btn-danger',
          onClick: (e) => { e.stopPropagation(); deleteBill(bill.id); },
        }, '×'),
      )
    )
  );
}

function billCard(bill, state, { mode = 'upcoming' } = {}) {
  const paid = mode === 'paid' || mode === 'paidThisMonth';
  const { cat, status, amount, dateLabel, dateVal, lastPaid, nextDue } = billDisplay(bill, state, mode);
  const tone = paid ? 'paid' : (status === 'overdue' ? 'overdue' : status === 'due_soon' ? 'due' : 'ok');
  const linked = store.getBillTransactions(bill.id).length;
  const hideMarkPaid = paid || mode === 'paidThisMonth' || bill.status === 'paid';
  const metaBits = [
    `${dateLabel} ${dateVal || '—'}`,
    cat?.name || null,
    linked ? `${linked} linked tx` : null,
    bill.recurring !== false && !paid ? 'Recurring' : null,
    lastPaid || null,
    nextDue || null,
  ].filter(Boolean);

  return el('article', {
    className: `tx-card bill-card bill-card--${tone}${paid ? ' bill-paid-row' : ''} envelope-card-clickable`,
    title: 'Tap for related transactions',
    onClick: (e) => {
      if (e.target.closest('button, a, details, summary')) return;
      openBillActivity(bill);
    },
  },
    el('div', { className: 'tx-card-top' },
      el('span', { className: 'tx-card-desc bill-card-name' }, bill.name),
      el('span', { className: 'tx-card-amount' }, formatCurrency(amount))
    ),
    el('div', { className: 'tx-card-body' },
      el('div', { className: 'tx-card-meta' }, metaBits.join(' · ')),
      el('div', { className: 'tx-card-badges' },
        statusBadge(status, bill.autoPay)
      )
    ),
    el('div', { className: 'tx-card-actions' },
      hideMarkPaid ? null : el('button', {
        className: 'btn btn-sm btn-primary',
        onClick: (e) => { e.stopPropagation(); markPaid(bill); },
      }, 'Mark Paid'),
      billMoreMenu(bill)
    )
  );
}

function openBillActivity(bill) {
  const txs = store.getBillTransactions(bill.id);
  const list = el('div', { className: 'envelope-activity-list' });
  let modal;

  if (!txs.length) {
    list.appendChild(emptyState(
      '📋',
      'No linked transactions',
      'When you mark this bill paid or match it from Review, payments show up here.',
    ));
  } else {
    txs.forEach(t => {
      list.appendChild(el('div', { className: 'envelope-activity-row' },
        el('div', { className: 'envelope-activity-main' },
          el('div', { className: 'envelope-activity-top' },
            el('strong', {}, formatDate(t.date)),
            el('span', { className: 'envelope-activity-amt' }, formatCurrency(t.amount)),
          ),
          el('div', { className: 'envelope-activity-desc' }, t.description || '—'),
        ),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => { modal?.close(); openTransactionForm({ transaction: t }); },
        }, 'Edit'),
      ));
    });
  }

  modal = showModal({
    title: `📋 ${bill.name}`,
    body: el('div', {},
      el('p', { className: 'envelope-activity-summary' },
        `${txs.length} linked transaction${txs.length === 1 ? '' : 's'}`,
      ),
      list,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
      bill.status !== 'paid' ? el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => { modal.close(); markPaid(bill); },
      }, 'Mark Paid') : null,
    ].filter(Boolean),
  });
  modal.modal.classList.add('modal-wide');
}

function statusBadge(status, autoPay) {
  if (status === 'paid') return el('span', { className: 'badge badge-paid' }, 'Paid');
  if (autoPay) return el('span', { className: 'badge badge-autopay' }, 'Auto-pay');
  if (status === 'overdue') return el('span', { className: 'badge badge-overdue' }, 'Overdue');
  return el('span', { className: 'badge badge-due' }, 'Due Soon');
}

function markPaid(bill) {
  const amountIn = el('input', { type: 'number', step: '0.01', value: bill.amount });
  const dateIn = el('input', { type: 'date', value: todayISO() });
  const alreadyInBank = el('input', { type: 'checkbox', checked: true });

  showModal({
    title: `Mark Paid: ${bill.name}`,
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Amount Paid'), amountIn),
      el('div', { className: 'form-group' }, el('label', {}, 'Payment Date'), dateIn),
      el('div', { className: 'form-option', style: 'margin-top:0.75rem' },
        el('div', { className: 'form-option-text' },
          el('span', { className: 'form-option-label' }, 'Already left my bank (CSV / import)'),
          el('span', { className: 'form-option-hint' },
            'On by default — does not reduce checking again. Turn off only for cash / not in your bank log yet.',
          ),
        ),
        el('label', { className: 'toggle-switch' },
          alreadyInBank,
          el('span', { className: 'toggle-slider' }),
        ),
      ),
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        const amt = Number(amountIn.value);
        store.markBillPaid(bill.id, amt, dateIn.value, {
          alreadyInBank: alreadyInBank.checked,
        });
        this.closest('.modal-backdrop').remove();
        const updated = store.getState().bills.find(b => b.id === bill.id);
        const recurring = bill.recurring !== false;
        let msg = alreadyInBank.checked
          ? `${bill.name} marked paid (checking unchanged)`
          : `${bill.name} marked paid — checking updated`;
        if (recurring && updated?.dueDate) {
          msg += ` · next due ${formatDate(updated.dueDate)}`;
        }
        showToast(msg, 'success', 4500);
        window.appRefresh();
      }
    }, 'Confirm Payment'),
  });
}

function saveBill({ bill, isEdit, nameIn, amountIn, dueIn, catSelect, recurringIn, autoPayIn, closeModal }) {
  const name = nameIn.value.trim();
  if (!name) {
    showToast('Please enter a bill name', 'info');
    nameIn.focus();
    return;
  }

  const data = {
    name,
    amount: Number(amountIn.value) || 0,
    dueDate: dueIn.value,
    categoryId: catSelect.value || null,
    recurring: recurringIn.checked,
    autoPay: autoPayIn.checked,
    status: bill?.status || 'pending',
  };

  try {
    store.update(s => {
      if (!Array.isArray(s.bills)) s.bills = [];
      if (isEdit) {
        const existing = s.bills.find(b => b.id === bill.id);
        if (!existing) throw new Error('Bill not found');
        Object.assign(existing, data);
        delete existing.priority;
      } else {
        s.bills.push({ id: generateId(), ...data });
      }
    });
    closeModal();
    showToast(isEdit ? 'Bill updated!' : 'Bill added!', 'success');
    window.appRefresh();
  } catch (err) {
    console.error('Failed to save bill', err);
    const msg = err?.message?.includes('storage')
      ? err.message
      : 'Could not save bill. Please try again.';
    showToast(msg, 'info');
  }
}

function openBillForm(bill = null) {
  const state = store.getState();
  const isEdit = !!bill;

  const nameIn = el('input', { type: 'text', value: bill?.name || '' });
  const amountIn = el('input', { type: 'number', step: '0.01', value: bill?.amount || 0 });
  const dueIn = el('input', { type: 'date', value: bill?.dueDate || '' });
  const recurringIn = el('input', { type: 'checkbox', checked: bill?.recurring ?? true });
  const autoPayIn = el('input', { type: 'checkbox', checked: bill?.autoPay ?? false });

  const catSelect = el('select');
  catSelect.appendChild(el('option', { value: '' }, '— Select Category —'));
  (state.categories || []).forEach(c => {
    catSelect.appendChild(el('option', { value: c.id }, c.name));
  });
  if (bill?.categoryId) catSelect.value = bill.categoryId;

  const modal = showModal({
    title: isEdit ? 'Edit Bill' : 'Add Bill',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Bill Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Due Date'), dueIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Amount'), amountIn),
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Budget Category'), catSelect),
      el('div', { style: 'display:flex;gap:1.5rem;margin-top:0.5rem' },
        el('label', { style: 'display:flex;align-items:center;gap:0.5rem' }, recurringIn, ' Recurring'),
        el('label', { style: 'display:flex;align-items:center;gap:0.5rem' }, autoPayIn, ' Auto-pay'),
      ),
      el('p', { className: 'tx-form-hint', style: 'margin-top:0.75rem;margin-bottom:0' },
        'Recurring: after pay, due date moves +1 month and the bill is unpaid again. Auto-pay: strong CSV/PDF matches (amount + name) complete the cycle automatically.',
      ),
    ),
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Cancel'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => saveBill({
          bill, isEdit, nameIn, amountIn, dueIn,
          catSelect, recurringIn, autoPayIn, closeModal: () => modal.close(),
        }),
      }, 'Save'),
    ],
  });

  setTimeout(() => nameIn.focus(), 50);
}

function deleteBill(id) {
  confirmDialog('Delete Bill', 'Remove this bill?', () => {
    store.update(s => { s.bills = s.bills.filter(b => b.id !== id); });
    window.appRefresh();
  });
}