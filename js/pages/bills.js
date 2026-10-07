import { icon } from '../icons.js';
import { el, formatCurrency, formatDate, todayISO, daysUntil, generateId, emptyState, getCurrentMonth, getMonthLabel, labelFor, showFieldError } from '../utils.js';
// Recurring bills: after pay, store advances due date +1 month and sets unpaid again.
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';
import { openTransactionForm } from './transactions.js';

/** Remember last bills tab within the session */
let billsTab = 'thisMonth';

function sortByDueDate(a, b) {
  if (!a.dueDate && !b.dueDate) return a.name.localeCompare(b.name);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  const byDate = a.dueDate.localeCompare(b.dueDate);
  return byDate !== 0 ? byDate : a.name.localeCompare(b.name);
}

/** Due date month key YYYY-MM, or null if missing */
function billDueMonth(bill) {
  const d = String(bill?.dueDate || '').slice(0, 10);
  return d.length >= 7 ? d.slice(0, 7) : null;
}

/**
 * This month board: unpaid bills due in the current calendar month, overdue
 * (past months), or with no due date. Future-month dues stay on Later.
 */
function isThisMonthBoard(bill, month) {
  if (bill.status === 'paid') return false;
  const dueM = billDueMonth(bill);
  if (!dueM) return true;
  return dueM <= month;
}

function isLaterBoard(bill, month) {
  if (bill.status === 'paid') return false;
  const dueM = billDueMonth(bill);
  return !!(dueM && dueM > month);
}

export function renderBills(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const allBills = state.bills || [];
  const unpaid = allBills.filter(b => b.status !== 'paid');
  const thisMonthBills = unpaid.filter(b => isThisMonthBoard(b, month)).sort(sortByDueDate);
  const laterBills = unpaid.filter(b => isLaterBoard(b, month)).sort(sortByDueDate);
  const overdueCount = thisMonthBills.filter(b => b.dueDate && daysUntil(b.dueDate) < 0).length;
  const paidThisMonth = store.getBillsPaidInMonth(month);
  const paidOneTime = allBills
    .filter(b => b.status === 'paid' && b.recurring === false)
    .sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));

  if (!['thisMonth', 'later', 'paid'].includes(billsTab)) billsTab = 'thisMonth';

  const sumAmounts = (list) => Math.round(
    list.reduce((s, b) => s + (Math.abs(Number(b.amount) || 0)), 0) * 100,
  ) / 100;
  const thisMonthTotal = sumAmounts(thisMonthBills);
  const laterTotal = sumAmounts(laterBills);
  const paidThisMonthTotal = Math.round(
    paidThisMonth.reduce((s, b) => {
      const amt = b.lastPaidAmount != null
        ? b.lastPaidAmount
        : (b.paidAmount != null ? b.paidAmount : b.amount);
      return s + (Math.abs(Number(amt) || 0));
    }, 0) * 100,
  ) / 100;
  const monthBillLoad = Math.round((thisMonthTotal + paidThisMonthTotal) * 100) / 100;

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header page-header--action' },
    el('div', { className: 'page-header__titles' },
      el('h2', {}, 'Bills'),
      el('p', {}, `${getMonthLabel(month)} · paid bills move to Later until the 1st`),
    ),
    el('button', {
      type: 'button',
      className: 'btn btn-tertiary page-header__action',
      onClick: () => openBillForm(),
      'aria-label': 'Add bill',
    }, icon('plus', 20), 'Add'),
  ));

  if (!allBills.length) {
    container.appendChild(emptyState('📋', 'No bills yet', 'Add your recurring bills to stay on top of due dates.'));
    return;
  }

  // Aggregate totals at top
  container.appendChild(el('div', { className: 'grid grid-4 section bills-summary' },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Still due this month'),
      el('div', {
        className: `card-value money${thisMonthTotal > 0 ? ' accent' : ' positive'}`,
      }, formatCurrency(thisMonthTotal)),
      el('p', { className: 'tx-form-hint mx-0 mt-1 mb-0' },
        thisMonthBills.length
          ? `${thisMonthBills.length} bill${thisMonthBills.length === 1 ? '' : 's'}${overdueCount ? ` · ${overdueCount} overdue` : ''}`
          : 'All caught up for this month',
      ),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, `Paid in ${getMonthLabel(month).split(' ')[0]}`),
      el('div', { className: 'card-value money positive' }, formatCurrency(paidThisMonthTotal)),
      el('p', { className: 'tx-form-hint mx-0 mt-1 mb-0' },
        paidThisMonth.length
          ? `${paidThisMonth.length} payment${paidThisMonth.length === 1 ? '' : 's'} recorded`
          : 'None marked paid yet',
      ),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'This month’s bill load'),
      el('div', { className: 'card-value money' }, formatCurrency(monthBillLoad)),
      el('p', { className: 'tx-form-hint mx-0 mt-1 mb-0' },
        'Still due + already paid this month',
      ),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Later (upcoming)'),
      el('div', { className: 'card-value money' }, formatCurrency(laterTotal)),
      el('p', { className: 'tx-form-hint mx-0 mt-1 mb-0' },
        laterBills.length
          ? `${laterBills.length} bill${laterBills.length === 1 ? '' : 's'} after this month`
          : 'No future-dated bills',
      ),
    ),
  ));

  const panel = el('div', { className: 'bills-tab-panel section' });

  function setTab(id) {
    billsTab = id;
    renderTabs();
    renderPanel();
  }

  const tabBar = el('div', { className: 'chip-bar bills-tabs' });
  function renderTabs() {
    tabBar.innerHTML = '';
    const narrow = typeof window !== 'undefined'
      && window.matchMedia('(max-width: 768px)').matches;
    const tabs = [
      {
        id: 'thisMonth',
        label: overdueCount
          ? (narrow
            ? `Month (${thisMonthBills.length}) · ${overdueCount} late`
            : `This month (${thisMonthBills.length}) · ${overdueCount} overdue`)
          : (narrow
            ? `Month (${thisMonthBills.length})`
            : `This month (${thisMonthBills.length})`),
      },
      { id: 'later', label: `Later (${laterBills.length})` },
      {
        id: 'paid',
        label: narrow
          ? `Paid (${paidThisMonth.length})`
          : `Paid ${getMonthLabel(month).split(' ')[0]} (${paidThisMonth.length})`,
      },
    ];
    tabs.forEach(t => {
      tabBar.appendChild(el('button', {
        type: 'button',
        className: `chip${billsTab === t.id ? ' active' : ''}`,
        onClick: () => setTab(t.id),
      }, t.label));
    });
  }

  function renderPanel() {
    panel.innerHTML = '';
    if (billsTab === 'thisMonth') {
      panel.appendChild(el('p', { className: 'tx-form-hint mb-3' },
        'Due this month, plus anything still unpaid from earlier.',
      ));
      if (!thisMonthBills.length) {
        panel.appendChild(el('div', { className: 'card empty-card', role: 'status' },
          laterBills.length
            ? `Nothing left for ${getMonthLabel(month)}. ${laterBills.length} bill${laterBills.length === 1 ? '' : 's'} waiting under Later (they move here on the 1st).`
            : 'All caught up. No bills due this month.',
        ));
      } else {
        const groups = [
          ['Overdue', b => billDisplay(b, state, 'upcoming').status === 'overdue'],
          ['Due this week', b => billDisplay(b, state, 'upcoming').status === 'due_soon'],
          ['Later this month', () => true],
        ];
        const used = new Set();
        groups.forEach(([label, test]) => {
          const list = thisMonthBills.filter(b => !used.has(b.id) && test(b));
          list.forEach(b => used.add(b.id));
          if (!list.length) return;
          panel.appendChild(el('h3', { className: 'list-section-title' }, `${label} (${list.length})`));
          panel.appendChild(billsTable(list, state, 'upcoming'));
        });
      }
      return;
    }

    if (billsTab === 'later') {
      panel.appendChild(el('p', { className: 'tx-form-hint mb-3' },
        'Due after this month. They move to This month on the 1st.',
      ));
      if (!laterBills.length) {
        panel.appendChild(el('div', { className: 'card empty-card', role: 'status' },
          'No future-dated bills yet. Pay a recurring bill and its next due date will appear here.',
        ));
      } else {
        panel.appendChild(billsTable(laterBills, state, 'upcoming'));
      }
      return;
    }

    // Paid tab
    panel.appendChild(el('p', { className: 'tx-form-hint mb-3' },
      `Payments recorded in ${getMonthLabel(month)}. Recurring bills also list their next due date.`,
    ));
    if (paidThisMonth.length) {
      panel.appendChild(billsTable(paidThisMonth, state, 'paidThisMonth'));
    } else {
      panel.appendChild(el('div', { className: 'card empty-card', role: 'status' },
        'No bills marked paid this month yet.',
      ));
    }
    if (paidOneTime.length) {
      panel.appendChild(el('div', { className: 'section-title mt-5' },
        `One-time paid (${paidOneTime.length})`,
      ));
      panel.appendChild(billsTable(paidOneTime, state, 'paid'));
    }
  }

  renderTabs();
  renderPanel();
  container.appendChild(tabBar);
  container.appendChild(panel);

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
        ? el('div', { className: 'fs-caption text-muted mt-1' }, lastPaid)
        : null,
      nextDue
        ? el('div', { className: 'fs-caption text-muted mt-1' }, nextDue)
        : null,
      bill.recurring !== false && !paid
        ? el('div', { className: 'fs-caption text-muted' }, 'Recurring')
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
        }, 'Mark paid'),
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
    tabindex: '0',
    role: 'button',
    'aria-label': `${bill.name}, ${formatCurrency(amount)}, ${metaBits[0]}. Open related transactions`,
    onClick: (e) => {
      if (e.target.closest('button, a, details, summary')) return;
      openBillActivity(bill);
    },
    onKeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBillActivity(bill); }
    },
  },
    el('div', { className: 'tx-card-top' },
      el('span', { className: `status-dot status-dot--${tone}`, 'aria-hidden': 'true' }),
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
      }, 'Mark paid'),
      el('button', {
        className: 'btn btn-sm btn-secondary',
        onClick: (e) => { e.stopPropagation(); openBillForm(bill); },
      }, 'Edit'),
      billMoreMenu(bill)
    )
  );
}

function openBillActivity(bill) {
  const bodyHost = el('div', {});
  let modal;

  function paint() {
    const live = store.getState().bills.find(b => b.id === bill.id) || bill;
    const txs = store.getBillTransactions(live.id);
    const list = el('div', { className: 'envelope-activity-list' });
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
            onClick: () => {
              openTransactionForm({
                transaction: t,
                onSaved: () => {
                  paint();
                  window.appSoftRefresh?.();
                },
              });
            },
          }, 'Edit'),
        ));
      });
    }
    bodyHost.innerHTML = '';
    bodyHost.appendChild(el('p', { className: 'envelope-activity-summary' },
      `${txs.length} linked transaction${txs.length === 1 ? '' : 's'}`,
    ));
    bodyHost.appendChild(list);
    modal?.setTitle?.(`📋 ${live.name}`);
  }

  paint();

  modal = showModal({
    title: `📋 ${bill.name}`,
    body: bodyHost,
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => { modal.close(); openBillForm(bill); },
      }, 'Edit'),
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
  if (status === 'overdue') {
    return el('span', {},
      el('span', { className: 'badge badge-overdue' }, 'Overdue'),
      autoPay ? el('span', { className: 'badge badge-autopay ml-1' }, 'Auto-pay') : null,
    );
  }
  if (status === 'due_soon' || status === 'due') {
    return el('span', {},
      el('span', { className: 'badge badge-due' }, 'Due soon'),
      autoPay ? el('span', { className: 'badge badge-autopay ml-1' }, 'Auto-pay') : null,
    );
  }
  // pending / later / scheduled
  return el('span', {},
    el('span', { className: 'badge badge-pending' }, status === 'later' ? 'Later' : 'Scheduled'),
    autoPay ? el('span', { className: 'badge badge-autopay ml-1' }, 'Auto-pay') : null,
  );
}

function markPaid(bill) {
  const amountIn = el('input', { type: 'number', step: '0.01', value: bill.amount });
  const dateIn = el('input', { type: 'date', value: todayISO() });
  const alreadyInBank = el('input', { type: 'checkbox', checked: true });

  const modal = showModal({
    title: `Mark Paid: ${bill.name}`,
    body: el('div', {},
      el('div', { className: 'form-group' }, labelFor('Amount Paid', amountIn), amountIn),
      el('div', { className: 'form-group' }, labelFor('Payment Date', dateIn), dateIn),
      el('div', { className: 'form-option mt-3' },
        el('div', { className: 'form-option-text' },
          el('span', { className: 'form-option-label' }, 'Already left my bank (CSV / import)'),
          el('span', { className: 'form-option-hint' },
            'On by default — links a matching imported charge if one exists, otherwise logs a pending payment without touching checking. Turn off only for cash / not in your bank log yet.',
          ),
        ),
        el('label', { className: 'toggle-switch' },
          alreadyInBank,
          el('span', { className: 'toggle-slider' }),
        ),
      ),
    ),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        const amt = Number(amountIn.value);
        const result = store.markBillPaid(bill.id, amt, dateIn.value, {
          alreadyInBank: alreadyInBank.checked,
        });
        modal.close();
        const updated = store.getState().bills.find(b => b.id === bill.id);
        const recurring = bill.recurring !== false;
        let msg = result?.linked
          ? `${bill.name} linked to the imported bank charge (no second expense)`
          : alreadyInBank.checked
            ? `${bill.name} marked paid (checking unchanged)`
            : `${bill.name} marked paid — checking updated`;
        if (recurring && updated?.dueDate) {
          msg += ` · next due ${formatDate(updated.dueDate)}`;
        }
        showToast(msg, 'success', 4500);
      },
    }, 'Confirm Payment'),
  });
}

function saveBill({ bill, isEdit, nameIn, amountIn, dueIn, catSelect, recurringIn, autoPayIn, closeModal }) {
  const name = nameIn.value.trim();
  if (!name) {
    showFieldError(nameIn, 'Enter a bill name');
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
  const amountIn = el('input', { type: 'number', step: '0.01', value: bill?.amount || '', placeholder: '0.00' });
  const dueIn = el('input', { type: 'date', value: bill?.dueDate || '' });
  const recurringIn = el('input', { type: 'checkbox', role: 'switch', className: 'switch', checked: bill?.recurring ?? true });
  const autoPayIn = el('input', { type: 'checkbox', role: 'switch', className: 'switch', checked: bill?.autoPay ?? false });

  const catSelect = el('select');
  catSelect.appendChild(el('option', { value: '' }, 'Choose envelope'));
  (state.categories || []).forEach(c => {
    catSelect.appendChild(el('option', { value: c.id }, c.name));
  });
  if (bill?.categoryId) catSelect.value = bill.categoryId;

  const modal = showModal({
    title: isEdit ? 'Edit Bill' : 'Add Bill',
    body: el('div', {},
      el('div', { className: 'form-group' }, labelFor('Bill Name', nameIn), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, labelFor('Due Date', dueIn), dueIn),
        el('div', { className: 'form-group' }, labelFor('Amount', amountIn), amountIn),
      ),
      el('div', { className: 'form-group' }, labelFor('Budget Envelope', catSelect), catSelect),
      el('p', { className: 'tx-form-hint', style: 'margin:-0.25rem 0 0.75rem;line-height:1.4' },
        'Mapped envelopes keep leftover for the bill — they are not used to cover overspend on groceries or kids.',
      ),
      el('div', { className: 'list-group switch-group' },
        el('label', { className: 'list-row switch-row' },
          el('span', { className: 'list-row__body' },
            el('span', { className: 'list-row__title' }, 'Recurring'),
            el('span', { className: 'list-row__meta' }, 'Moves to next month after you pay'),
          ),
          recurringIn,
        ),
        el('label', { className: 'list-row switch-row' },
          el('span', { className: 'list-row__body' },
            el('span', { className: 'list-row__title' }, 'Auto-pay'),
            el('span', { className: 'list-row__meta' }, 'Strong bank matches mark it paid'),
          ),
          autoPayIn,
        ),
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