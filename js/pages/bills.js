import { el, formatCurrency, formatDate, todayISO, daysUntil, generateId } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';
import { emptyState } from '../utils.js';

function sortByDueDate(a, b) {
  if (!a.dueDate && !b.dueDate) return a.name.localeCompare(b.name);
  if (!a.dueDate) return 1;
  if (!b.dueDate) return -1;
  const byDate = a.dueDate.localeCompare(b.dueDate);
  return byDate !== 0 ? byDate : a.name.localeCompare(b.name);
}

export function renderBills(container) {
  const state = store.getState();
  const allBills = state.bills || [];
  const upcoming = allBills
    .filter(b => b.status !== 'paid')
    .sort(sortByDueDate);
  const paid = allBills
    .filter(b => b.status === 'paid')
    .sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Bills & Payments'),
    el('p', {}, 'Track recurring and one-time bills')
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

  if (paid.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, `Paid Bills (${paid.length})`),
      billsTable(paid, state, 'paid'),
    ));
  }
}

function billsTable(bills, state, variant) {
  const isPaid = variant === 'paid';
  return el('div', { className: 'card' },
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
          ...bills.map(b => billRow(b, state, { paid: isPaid }))
        )
      )
    )
  );
}

function billRow(bill, state, { paid = false } = {}) {
  const cat = (state.categories || []).find(c => c.id === bill.categoryId);
  const days = bill.dueDate ? daysUntil(bill.dueDate) : NaN;
  let status = bill.status || 'pending';
  if (!paid) {
    if (days < 0) status = 'overdue';
    else if (days <= 7) status = 'due_soon';
  } else {
    status = 'paid';
  }

  const paidAmount = bill.paidAmount != null ? bill.paidAmount : bill.amount;

  return el('tr', { className: paid ? 'bill-paid-row' : '' },
    el('td', {}, bill.name),
    el('td', {}, formatDate(paid ? bill.paidDate : bill.dueDate)),
    el('td', {}, formatCurrency(paid ? paidAmount : bill.amount)),
    el('td', {}, cat?.name || '—'),
    el('td', {}, statusBadge(status, bill.autoPay)),
    el('td', {},
      el('div', { className: 'btn-group' },
        paid ? null : el('button', {
          className: 'btn btn-sm btn-primary',
          onClick: () => markPaid(bill)
        }, 'Mark Paid'),
        el('button', { className: 'btn btn-sm btn-secondary', onClick: () => openBillForm(bill) }, 'Edit'),
        el('button', { className: 'btn btn-sm btn-danger', onClick: () => deleteBill(bill.id) }, '×'),
      )
    )
  );
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

  showModal({
    title: `Mark Paid: ${bill.name}`,
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Amount Paid'), amountIn),
      el('div', { className: 'form-group' }, el('label', {}, 'Payment Date'), dateIn),
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        store.markBillPaid(bill.id, Number(amountIn.value), dateIn.value);
        this.closest('.modal-backdrop').remove();
        showToast(`${bill.name} marked as paid!`);
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