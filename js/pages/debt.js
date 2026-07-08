import { el, formatCurrency, formatDate, todayISO, emptyState } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';

export function renderDebt(container) {
  const debts = store.getActiveDebts();
  const archived = store.getState().archivedDebts || [];
  const total = store.getTotalDebt();
  const months = store.estimateMonthsToDebtFree();
  const target = store.getSnowballTarget();
  const surplus = store.getSurplusForSnowball();
  const toAllocate = store.getPlannedSnowballSurplus();
  const surplusNote = store.getSurplusBasis() === 'unallocated' && toAllocate > 0
    ? `Matches To Allocate (${formatCurrency(toAllocate)}) from your envelope budget`
    : store.getSurplusBasis() === 'cashflow'
      ? 'Based on income minus spending this month'
      : '';

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Debt Snowball'),
    el('p', {}, 'Attack the smallest balance first — behavior change beats math!')
  ));

  container.appendChild(el('div', { className: 'grid grid-4 section' },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Total Debt'),
      el('div', { className: 'card-value negative' }, formatCurrency(total))
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Active Debts'),
      el('div', { className: 'card-value' }, String(debts.length))
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Est. Months to Free'),
      el('div', { className: 'card-value accent' }, debts.length ? `~${months}` : '0')
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Monthly Surplus'),
      el('div', { className: 'card-value positive' }, formatCurrency(surplus)),
      surplusNote ? el('p', { style: 'font-size:0.7rem;color:var(--text-muted);margin-top:0.35rem;line-height:1.4' }, surplusNote) : null,
    )
  ));

  if (target) {
    const payment = store.getSnowballPayment(target);
    container.appendChild(el('div', { className: 'banner banner-celebration section' },
      el('div', { className: 'banner-icon' }, '❄️'),
      el('div', { className: 'banner-text' },
        el('h3', {}, `Snowball Target: ${target.name}`),
        el('p', {}, `Throw ${formatCurrency(payment)} at this debt this month (${formatCurrency(target.minPayment)} min + ${formatCurrency(surplus)} extra)`)
      ),
      el('button', {
        className: 'btn btn-primary', style: 'margin-left:auto;white-space:nowrap',
        onClick: () => makePayment(target)
      }, 'Make Payment')
    ));
  }

  container.appendChild(el('div', { className: 'btn-group section' },
    el('button', { className: 'btn btn-primary', onClick: () => openDebtForm() }, '+ Add Debt'),
    el('button', { className: 'btn btn-accent', onClick: () => allocateAllSurplus() }, 'Allocate All Surplus'),
  ));

  if (!debts.length) {
    container.appendChild(emptyState('🎉', 'Debt Free!', 'You\'ve crushed the snowball. Time to build wealth!'));
  } else {
    container.appendChild(el('div', { className: 'card section' },
      el('div', { className: 'table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, '#'),
            el('th', {}, 'Debt'),
            el('th', {}, 'Balance'),
            el('th', {}, 'Rate'),
            el('th', {}, 'Min Payment'),
            el('th', {}, 'Envelope'),
            el('th', {}, 'Due / Notes'),
            el('th', {}, 'Actions'),
          )),
          el('tbody', {},
            ...debts.map((d, i) => debtRow(d, i === 0))
          )
        )
      )
    ));
  }

  if (archived.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, '🏆 Paid Off Debts'),
      el('div', { className: 'card' },
        ...archived.map(d => el('div', {
          style: 'padding:0.5rem 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between'
        },
          el('span', {}, `✅ ${d.name}`),
          el('span', { style: 'color:var(--text-muted);font-size:0.8rem' }, `Paid off ${formatDate(d.paidOffDate)}`)
        ))
      )
    ));
  }
}

function debtRow(debt, isTarget) {
  const state = store.getState();
  const cat = (state.categories || []).find(c => c.id === debt.categoryId);
  return el('tr', { className: isTarget ? 'debt-target' : '' },
    el('td', {}, isTarget ? '🎯' : ''),
    el('td', {}, debt.name),
    el('td', { style: 'font-weight:700' }, formatCurrency(debt.balance)),
    el('td', {}, debt.interestRate ? `${debt.interestRate}%` : '—'),
    el('td', {}, formatCurrency(debt.minPayment)),
    el('td', {}, cat?.name || '—'),
    el('td', {}, debt.dueDate || debt.notes || '—'),
    el('td', {},
      el('div', { className: 'btn-group' },
        el('button', { className: 'btn btn-sm btn-primary', onClick: () => makePayment(debt) }, 'Pay'),
        el('button', { className: 'btn btn-sm btn-secondary', onClick: () => openDebtForm(debt) }, 'Edit'),
        el('button', {
          className: 'btn btn-sm btn-accent',
          onClick: () => {
            confirmDialog('Mark Paid Off', `Celebrate paying off ${debt.name}?`, () => {
              store.payOffDebt(debt.id);
              showToast(`🎉 ${debt.name} is PAID OFF!`, 'celebration', 5000);
              window.appRefresh();
            });
          }
        }, 'Paid Off!'),
        el('button', { className: 'btn btn-sm btn-danger', onClick: () => deleteDebt(debt.id) }, '×'),
      )
    )
  );
}

function makePayment(debt) {
  const max = Number(debt.balance);
  const input = el('input', { type: 'number', step: '0.01', min: 0, max, value: Math.min(max, store.getSnowballPayment(debt)) });
  showModal({
    title: `Payment: ${debt.name}`,
    body: el('div', {},
      el('p', { style: 'margin-bottom:1rem' }, `Balance: ${formatCurrency(debt.balance)}`),
      el('div', { className: 'form-group' }, el('label', {}, 'Payment Amount'), input),
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        const amount = Number(input.value);
        store.update(s => {
          const d = s.debts.find(x => x.id === debt.id);
          if (!d) return;
          const pay = Math.min(amount, Number(d.balance));
          d.balance = Math.max(0, Number(d.balance) - pay);
          s.balances.checking -= pay;
          s.transactions.unshift({
            id: crypto.randomUUID(),
            date: todayISO(),
            amount: pay,
            type: 'debt_payment',
            categoryId: d.categoryId || null,
            debtId: d.id,
            description: `Payment to ${d.name}`,
          });
          if (d.balance <= 0) {
            d.balance = 0;
            d.archived = true;
            d.paidOffDate = todayISO();
            s.archivedDebts.push({ ...d });
            const next = s.debts.filter(x => !x.archived && Number(x.balance) > 0)
              .sort((a, b) => Number(a.balance) - Number(b.balance))[0];
            s.celebrations.unshift({
              id: crypto.randomUUID(),
              type: 'debt_paid',
              message: `🎉 ${d.name} is PAID OFF!${next ? ` Next target: ${next.name}` : ' You are DEBT FREE!'}`,
              date: todayISO(),
              debtName: d.name,
            });
          }
        });
        this.closest('.modal-backdrop').remove();
        showToast('Payment recorded!', 'success');
        window.appRefresh();
      }
    }, 'Record Payment'),
  });
}

function allocateAllSurplus() {
  const surplus = store.getSurplusForSnowball();
  if (surplus <= 0) { showToast('No surplus to allocate', 'info'); return; }
  const target = store.allocateSurplusToDebt(surplus);
  if (target) showToast(`Allocated ${formatCurrency(surplus)} to ${target.name}!`, 'celebration');
  window.appRefresh();
}

function openDebtForm(debt = null) {
  const state = store.getState();
  const isEdit = !!debt;
  const nameIn = el('input', { type: 'text', value: debt?.name || '' });
  const balIn = el('input', { type: 'number', step: '0.01', value: debt?.balance || 0 });
  const rateIn = el('input', { type: 'number', step: '0.01', value: debt?.interestRate || 0 });
  const minIn = el('input', { type: 'number', step: '0.01', value: debt?.minPayment || 0 });
  const dueIn = el('input', { type: 'text', value: debt?.dueDate || '', placeholder: 'Due date or notes' });
  const notesIn = el('textarea', { rows: 2 }, debt?.notes || '');

  const catSelect = el('select');
  catSelect.appendChild(el('option', { value: '' }, '— Select Envelope —'));
  (state.categories || []).forEach(c => {
    catSelect.appendChild(el('option', { value: c.id }, c.name));
  });
  if (debt?.categoryId) catSelect.value = debt.categoryId;

  showModal({
    title: isEdit ? 'Edit Debt' : 'Add Debt',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Debt Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Current Balance'), balIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Interest Rate %'), rateIn),
      ),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Minimum Payment'), minIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Due Date'), dueIn),
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Budget Envelope'), catSelect),
      el('p', { style: 'font-size:0.8rem;color:var(--text-muted);margin:-0.25rem 0 0.75rem' },
        'Link this debt to an envelope so minimum payments count toward your monthly budget.'
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Notes'), notesIn),
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        const data = {
          name: nameIn.value,
          balance: Number(balIn.value),
          interestRate: Number(rateIn.value),
          minPayment: Number(minIn.value),
          dueDate: dueIn.value,
          notes: notesIn.value,
          categoryId: catSelect.value || null,
          archived: false,
        };
        store.update(s => {
          if (isEdit) Object.assign(s.debts.find(d => d.id === debt.id), data);
          else s.debts.push({ id: crypto.randomUUID(), ...data });
        });
        this.closest('.modal-backdrop').remove();
        window.appRefresh();
      }
    }, 'Save'),
  });
}

function deleteDebt(id) {
  confirmDialog('Delete Debt', 'Remove this debt from tracking?', () => {
    store.update(s => { s.debts = s.debts.filter(d => d.id !== id); });
    window.appRefresh();
  });
}