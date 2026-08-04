import { el, formatCurrency, formatDate, todayISO, emptyState } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';
import { openTransactionForm } from './transactions.js';

export function renderDebt(container) {
  const snowball = store.getSnowballDebts();
  const paused = store.getPausedDebts();
  const allActive = store.getActiveDebts();
  const archived = store.getState().archivedDebts || [];
  const total = store.getTotalDebt();
  const snowballTotal = store.getSnowballDebtTotal();
  const months = store.estimateMonthsToDebtFree();
  const target = store.getSnowballTarget();
  const surplus = store.getSurplusForSnowball();
  const surplusCap = store.getSurplusCapInfo();
  const toAllocate = store.getPlannedSnowballSurplus();
  const basis = store.getSurplusBasis();
  const fc = surplusCap.forecast || store.getMonthEndSnowballForecast();
  const surplusNote = basis === 'month_end' || surplus > 0
    ? `Month-end forecast (+${formatCurrency(fc.incomeLeft || 0)} income left · −${formatCurrency(fc.billsLeft || 0)} bills · −${formatCurrency(fc.envelopeLeft || 0)} envelopes)`
    : basis === 'pay_bridge'
      ? `Safe after bills before next pay${surplusCap.nextPayDate ? ` (${surplusCap.nextPayDate})` : ''}: held ${formatCurrency(surplusCap.billsTotal)}`
      : basis === 'bank'
        ? `Checking − bills held − cushion`
        : basis === 'unallocated' && toAllocate > 0
          ? `Matches To Allocate (${formatCurrency(toAllocate)}) from your envelope budget`
          : basis === 'cashflow'
            ? 'Based on income minus spending this month'
            : 'Month-end forecast is $0 with current plan';

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Debt Snowball'),
    el('p', {}, 'Attack the smallest balance first. Put deferred loans (e.g. student loans in school) on hold so they leave the attack list.')
  ));

  container.appendChild(el('div', { className: 'grid grid-4 section' },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Total Debt'),
      el('div', { className: 'card-value negative' }, formatCurrency(total)),
      paused.length
        ? el('p', { style: 'font-size:0.7rem;color:var(--text-muted);margin-top:0.35rem' },
          `${formatCurrency(snowballTotal)} in snowball · ${formatCurrency(total - snowballTotal)} on hold`)
        : null,
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'In Snowball'),
      el('div', { className: 'card-value' }, String(snowball.length)),
      paused.length
        ? el('p', { style: 'font-size:0.7rem;color:var(--text-muted);margin-top:0.35rem' },
          `${paused.length} on hold`)
        : null,
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Est. Months (snowball)'),
      el('div', { className: 'card-value accent' }, snowball.length ? `~${months}` : '0'),
      el('p', { style: 'font-size:0.7rem;color:var(--text-muted);margin-top:0.35rem' },
        paused.length ? 'On-hold debts not in ETA' : 'At today’s surplus + mins'),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Month-end snowball'),
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
  } else if (paused.length && !snowball.length) {
    container.appendChild(el('div', { className: 'banner banner-action section' },
      el('div', { className: 'banner-icon' }, '⏸️'),
      el('div', { className: 'banner-text' },
        el('h3', {}, 'All remaining debts are on hold'),
        el('p', {}, 'No snowball target until you resume a debt — or you’re only carrying deferred balances.'),
      ),
    ));
  }

  container.appendChild(el('div', { className: 'btn-group section' },
    el('button', { className: 'btn btn-primary', onClick: () => openDebtForm() }, '+ Add Debt'),
    snowball.length
      ? el('button', { className: 'btn btn-accent', onClick: () => allocateAllSurplus() }, 'Allocate All Surplus')
      : null,
  ));

  if (!allActive.length) {
    container.appendChild(emptyState('🎉', 'Debt Free!', 'You\'ve crushed the snowball. Time to build wealth!'));
  } else {
    if (snowball.length) {
      const list = el('div', { className: 'section debt-list' });
      list.appendChild(el('div', { className: 'section-title' }, 'Snowball order (smallest first)'));
      list.appendChild(el('div', { className: 'card debt-desktop-list' },
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
              ...snowball.map((d, i) => debtRow(d, i === 0, i + 1))
            )
          )
        )
      ));
      list.appendChild(el('div', { className: 'debt-mobile-list' },
        ...snowball.map((d, i) => debtCard(d, i === 0))
      ));
      container.appendChild(list);
    }

    if (paused.length) {
      const hold = el('div', { className: 'section debt-list debt-on-hold-section' });
      hold.appendChild(el('div', { className: 'section-title' }, '⏸️ On hold (outside snowball)'));
      hold.appendChild(el('p', { className: 'tx-form-hint', style: 'margin-bottom:0.75rem' },
        'Still counted in total debt and Baby Step progress, but they don’t take snowball surplus or minimums in the plan. Resume when you’re ready to attack them (e.g. after school).',
      ));
      hold.appendChild(el('div', { className: 'card debt-desktop-list' },
        el('div', { className: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'Debt'),
              el('th', {}, 'Balance'),
              el('th', {}, 'Rate'),
              el('th', {}, 'Min'),
              el('th', {}, 'Actions'),
            )),
            el('tbody', {},
              ...paused.map(d => pausedDebtRow(d))
            )
          )
        )
      ));
      hold.appendChild(el('div', { className: 'debt-mobile-list' },
        ...paused.map(d => debtCard(d, false, { paused: true }))
      ));
      container.appendChild(hold);
    }
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

function toggleDebtHold(debt, pause) {
  const name = debt.name || 'this debt';
  if (pause) {
    confirmDialog(
      'Put on hold?',
      `Pause “${name}” from the snowball? It stays on your total debt list but won’t receive surplus or count toward snowball ETA. Use for deferred loans (e.g. student loans in school).`,
      () => {
        store.setDebtPaused(debt.id, true);
        showToast(`${name} on hold`, 'info');
        window.appRefresh();
      },
    );
  } else {
    store.setDebtPaused(debt.id, false);
    showToast(`${name} back in the snowball`, 'success');
    window.appRefresh();
  }
}

function debtMoreMenu(debt, { paused = false } = {}) {
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
    onClick: () => { menu.removeAttribute('open'); openDebtForm(debt); },
  }, 'Edit'));
  items.appendChild(el('button', {
    type: 'button',
    className: 'tx-more-item',
    onClick: () => {
      menu.removeAttribute('open');
      toggleDebtHold(debt, !paused);
    },
  }, paused ? 'Resume snowball' : 'Put on hold'));
  items.appendChild(el('button', {
    type: 'button',
    className: 'tx-more-item',
    onClick: () => {
      menu.removeAttribute('open');
      confirmDialog('Mark Paid Off', `Celebrate paying off ${debt.name}?`, () => {
        store.payOffDebt(debt.id);
        showToast(`🎉 ${debt.name} is PAID OFF!`, 'celebration', 5000);
        window.appRefresh();
      });
    },
  }, 'Paid Off!'));
  items.appendChild(el('button', {
    type: 'button',
    className: 'tx-more-item tx-more-item-danger',
    onClick: () => { menu.removeAttribute('open'); deleteDebt(debt.id); },
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

function pausedDebtRow(debt) {
  return el('tr', { className: 'debt-paused-row bill-row-clickable' },
    el('td', {},
      el('button', {
        type: 'button',
        className: 'linkish',
        onClick: () => openDebtActivity(debt),
      }, debt.name),
      el('span', { className: 'badge badge-pending', style: 'margin-left:0.4rem' }, 'On hold'),
    ),
    el('td', { style: 'font-weight:700' }, formatCurrency(debt.balance)),
    el('td', {}, debt.interestRate ? `${debt.interestRate}%` : '—'),
    el('td', {}, formatCurrency(debt.minPayment)),
    el('td', {},
      el('div', { className: 'btn-group' },
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-primary',
          onClick: () => toggleDebtHold(debt, false),
        }, 'Resume'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => makePayment(debt),
        }, 'Pay'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => openDebtForm(debt),
        }, 'Edit'),
      ),
    ),
  );
}

function debtRow(debt, isTarget, orderNum = '') {
  const state = store.getState();
  const cat = (state.categories || []).find(c => c.id === debt.categoryId);
  return el('tr', {
    className: isTarget ? 'debt-target bill-row-clickable' : 'bill-row-clickable',
    title: 'Click for payment history',
    onClick: (e) => {
      if (e.target.closest('button, a, details, summary')) return;
      openDebtActivity(debt);
    },
  },
    el('td', {}, isTarget ? '🎯' : String(orderNum || '')),
    el('td', {},
      el('button', {
        type: 'button',
        className: 'linkish',
        onClick: (e) => { e.stopPropagation(); openDebtActivity(debt); },
      }, debt.name),
    ),
    el('td', { style: 'font-weight:700' }, formatCurrency(debt.balance)),
    el('td', {}, debt.interestRate ? `${debt.interestRate}%` : '—'),
    el('td', {}, formatCurrency(debt.minPayment)),
    el('td', {}, cat?.name || '—'),
    el('td', {}, debt.dueDate || debt.notes || '—'),
    el('td', {},
      el('div', { className: 'btn-group' },
        el('button', {
          className: 'btn btn-sm btn-primary',
          onClick: (e) => { e.stopPropagation(); makePayment(debt); },
        }, 'Pay'),
        el('button', {
          className: 'btn btn-sm btn-secondary',
          onClick: (e) => { e.stopPropagation(); openDebtForm(debt); },
        }, 'Edit'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          title: 'Pause from snowball (e.g. deferred student loans)',
          onClick: (e) => { e.stopPropagation(); toggleDebtHold(debt, true); },
        }, 'Hold'),
        el('button', {
          className: 'btn btn-sm btn-accent',
          onClick: (e) => {
            e.stopPropagation();
            confirmDialog('Mark Paid Off', `Celebrate paying off ${debt.name}?`, () => {
              store.payOffDebt(debt.id);
              showToast(`🎉 ${debt.name} is PAID OFF!`, 'celebration', 5000);
              window.appRefresh();
            });
          }
        }, 'Paid Off!'),
        el('button', {
          className: 'btn btn-sm btn-danger',
          onClick: (e) => { e.stopPropagation(); deleteDebt(debt.id); },
        }, '×'),
      )
    )
  );
}

function debtCard(debt, isTarget, opts = {}) {
  const paused = !!opts.paused || !!debt.paused;
  const state = store.getState();
  const cat = (state.categories || []).find(c => c.id === debt.categoryId);
  const paidThisMonth = store.getDebtPaidThisMonth(debt.id);
  return el('article', {
    className: `tx-card debt-card${isTarget ? ' debt-target' : ''}${paused ? ' debt-paused' : ''} envelope-card-clickable`,
    title: 'Tap to see payment history',
    onClick: (e) => {
      if (e.target.closest('button, a, details, summary')) return;
      openDebtActivity(debt);
    },
  },
    el('div', { className: 'tx-card-top' },
      el('span', { className: 'tx-card-desc' },
        isTarget ? '🎯 ' : paused ? '⏸️ ' : '',
        debt.name
      ),
      el('span', { className: 'tx-card-amount' }, formatCurrency(debt.balance))
    ),
    el('div', { className: 'tx-card-body' },
      el('div', { className: 'tx-card-meta' },
        `Min ${formatCurrency(debt.minPayment)}`,
        debt.interestRate ? ` · ${debt.interestRate}%` : '',
        cat?.name ? ` · ${cat.name}` : '',
      ),
      paidThisMonth > 0
        ? el('div', { className: 'tx-card-meta' }, `Paid ${formatCurrency(paidThisMonth)} this month`)
        : null,
      (debt.dueDate || debt.notes)
        ? el('div', { className: 'tx-card-meta' }, debt.dueDate || debt.notes)
        : null,
      isTarget || paused
        ? el('div', { className: 'tx-card-badges' },
          isTarget ? el('span', { className: 'tx-type-badge' }, 'Snowball target') : null,
          paused ? el('span', { className: 'badge badge-pending' }, 'On hold') : null,
        )
        : null,
    ),
    el('div', { className: 'tx-card-actions' },
      paused
        ? el('button', {
          className: 'btn btn-sm btn-primary',
          onClick: (e) => { e.stopPropagation(); toggleDebtHold(debt, false); },
        }, 'Resume')
        : el('button', {
          className: 'btn btn-sm btn-primary',
          onClick: (e) => { e.stopPropagation(); makePayment(debt); },
        }, 'Pay'),
      debtMoreMenu(debt, { paused })
    )
  );
}

function openDebtActivity(debt) {
  const txs = store.getDebtTransactions(debt.id);
  const paidMonth = store.getDebtPaidThisMonth(debt.id);
  const months = store.estimateMonthsToDebtFree();
  const list = el('div', { className: 'envelope-activity-list' });
  let modal;

  if (!txs.length) {
    list.appendChild(emptyState(
      '❄️',
      'No payments logged',
      'Record a payment to build history for this debt.',
    ));
  } else {
    txs.forEach(t => {
      list.appendChild(el('div', { className: 'envelope-activity-row' },
        el('div', { className: 'envelope-activity-main' },
          el('div', { className: 'envelope-activity-top' },
            el('strong', {}, formatDate(t.date)),
            el('span', { className: 'envelope-activity-amt' }, formatCurrency(t.amount)),
          ),
          el('div', { className: 'envelope-activity-desc' }, t.description || 'Payment'),
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
    title: `❄️ ${debt.name}`,
    body: el('div', {},
      el('p', { className: 'envelope-activity-summary' },
        `Balance ${formatCurrency(debt.balance)} · Paid ${formatCurrency(paidMonth)} this month`,
        months ? ` · ~${months} mo to debt-free (plan)` : '',
      ),
      list,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => { modal.close(); makePayment(debt); },
      }, 'Make payment'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}

function makePayment(debt) {
  const max = Number(debt.balance);
  const input = el('input', {
    type: 'number',
    step: '0.01',
    min: 0,
    max,
    value: Math.min(max, store.getSnowballPayment(debt)),
  });
  // Default on: CSV already hit checking (same as bill mark-paid)
  const alreadyInBank = el('input', { type: 'checkbox', checked: true });

  const modal = showModal({
    title: `Payment: ${debt.name}`,
    body: el('div', {},
      el('p', { style: 'margin-bottom:1rem' }, `Balance: ${formatCurrency(debt.balance)}`),
      el('div', { className: 'form-group' }, el('label', {}, 'Payment Amount'), input),
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
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        const amount = Number(input.value);
        if (!(amount > 0)) {
          showToast('Enter a payment amount', 'info');
          return;
        }
        const skipChecking = alreadyInBank.checked;
        store.update(s => {
          const d = s.debts.find(x => x.id === debt.id);
          if (!d) return;
          const pay = Math.min(amount, Number(d.balance));
          d.balance = Math.max(0, Number(d.balance) - pay);
          if (!skipChecking) {
            s.balances.checking = (Number(s.balances.checking) || 0) - pay;
          }
          s.transactions.unshift({
            id: crypto.randomUUID(),
            date: todayISO(),
            amount: pay,
            type: 'debt_payment',
            categoryId: d.categoryId || null,
            debtId: d.id,
            description: `Payment to ${d.name}`,
            // Already in bank → don't apply checking again via delta logic later
            clearingStatus: skipChecking ? 'cleared' : 'cleared',
            // Flag for honesty; checking already adjusted (or not) above
            alreadyInBank: skipChecking,
          });
          // When already in bank, CSV already reduced checking — we only reduce debt balance.
          // When NOT already in bank, we reduced checking above manually.
          // getCheckingDelta for debt_payment always reduces checking on cleared — need to avoid double.
          // We applied checking only when !skipChecking. If store.applyCheckingDelta is used elsewhere on import only, OK.
          // But if something re-processes... leave as-is matching previous pattern that always subtracted once.
          if (d.balance <= 0) {
            d.balance = 0;
            d.archived = true;
            d.paidOffDate = todayISO();
            s.archivedDebts.push({ ...d });
            const next = s.debts
              .filter(x => !x.archived && !x.paused && Number(x.balance) > 0)
              .sort((a, b) => Number(a.balance) - Number(b.balance))[0];
            const heldLeft = s.debts.some(x => !x.archived && x.paused && Number(x.balance) > 0);
            s.celebrations.unshift({
              id: crypto.randomUUID(),
              type: 'debt_paid',
              message: `🎉 ${d.name} is PAID OFF!${
                next
                  ? ` Next target: ${next.name}`
                  : heldLeft
                    ? ' Snowball list clear — you still have debts on hold.'
                    : ' You are DEBT FREE!'
              }`,
              date: todayISO(),
              debtName: d.name,
            });
          }
        });
        modal.close();
        showToast(
          skipChecking
            ? 'Payment recorded (checking unchanged)'
            : 'Payment recorded — checking updated',
          'success',
        );
      },
    }, 'Record Payment'),
  });
}

function allocateAllSurplus() {
  const surplus = store.getSurplusForSnowball();
  if (surplus <= 0) { showToast('No surplus to allocate', 'info'); return; }
  const targetDebt = store.getSnowballTarget();
  if (!targetDebt) {
    showToast('No active debt target', 'info');
    return;
  }
  confirmDialog(
    'Allocate all surplus?',
    `Send ${formatCurrency(surplus)} extra to ${targetDebt.name}? This reduces checking and the debt balance. Use dashboard “Snowball $” if you want a custom amount.`,
    () => {
      const target = store.allocateSurplusToDebt(surplus);
      if (target) {
        showToast(`Allocated ${formatCurrency(target.pay || surplus)} to ${target.name}!`, 'celebration');
      }
      window.appRefresh();
    },
  );
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
  const pausedIn = el('input', { type: 'checkbox' });
  if (debt?.paused) pausedIn.checked = true;

  const catSelect = el('select');
  catSelect.appendChild(el('option', { value: '' }, '— Select Envelope —'));
  (state.categories || []).forEach(c => {
    catSelect.appendChild(el('option', { value: c.id }, c.name));
  });
  if (debt?.categoryId) catSelect.value = debt.categoryId;

  const modal = showModal({
    title: isEdit ? 'Edit Debt' : 'Add Debt',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Debt Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Current Balance'), balIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Interest Rate %'), rateIn),
      ),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Minimum Payment'), minIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Due note'), dueIn),
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Budget Envelope'), catSelect),
      el('p', { style: 'font-size:0.8rem;color:var(--text-muted);margin:-0.25rem 0 0.75rem' },
        'Link this debt to an envelope so minimum payments count toward your monthly budget.'
      ),
      el('div', { className: 'form-option', style: 'margin-bottom:0.75rem' },
        el('div', { className: 'form-option-text' },
          el('span', { className: 'form-option-label' }, 'On hold (outside snowball)'),
          el('span', { className: 'form-option-hint' },
            'Use for deferred loans (e.g. student loans in school). Balance still counts toward total debt; surplus goes to other debts first.',
          ),
        ),
        el('label', { className: 'toggle-switch' },
          pausedIn,
          el('span', { className: 'toggle-slider' }),
        ),
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Notes'), notesIn),
    ),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        const data = {
          name: nameIn.value,
          balance: Number(balIn.value),
          interestRate: Number(rateIn.value),
          minPayment: Number(minIn.value),
          dueDate: dueIn.value,
          notes: notesIn.value,
          categoryId: catSelect.value || null,
          archived: false,
          paused: !!pausedIn.checked,
        };
        if (data.paused) data.pausedAt = debt?.pausedAt || todayISO();
        else delete data.pausedAt;
        store.update(s => {
          if (isEdit) {
            const existing = s.debts.find(d => d.id === debt.id);
            if (existing) {
              Object.assign(existing, data);
              if (!data.paused) delete existing.pausedAt;
            }
          } else {
            s.debts.push({ id: crypto.randomUUID(), ...data });
          }
        });
        modal.close();
      },
    }, 'Save'),
  });
}

function deleteDebt(id) {
  confirmDialog('Delete Debt', 'Remove this debt from tracking?', () => {
    store.update(s => { s.debts = s.debts.filter(d => d.id !== id); });
    window.appRefresh();
  });
}