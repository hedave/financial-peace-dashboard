import { icon } from '../icons.js';
import { el, formatCurrency, formatDate, getCurrentMonth, getMonthLabel, labelFor } from '../utils.js';
import { store } from '../store.js';
import { showToast, confirmDialog, showModal } from '../components/modal.js';
import { openPayScheduleEditor } from '../components/pay-schedule-editor.js';
import { scheduleSummary, getUpcomingChecks, getScheduledChecksForMonth } from '../pay-schedule.js';
import { isPlannedIncomeSource, BONUS_INCOME_NAME } from '../income-sources.js';

const CHECK_STATUS = {
  received: { icon: '✓', label: 'Received', cls: 'received' },
  overdue: { icon: '!', label: 'Overdue', cls: 'overdue' },
  soon: { icon: '◦', label: 'Soon', cls: 'soon' },
  pending: { icon: '○', label: 'Pending', cls: 'pending' },
};

export function renderIncome(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const paychecks = store.getPaycheckStatus(month);
  const plannedSources = state.incomeSources.filter(isPlannedIncomeSource);
  const bonusLogged = store.getBonusIncomeLogged(month);

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Income'),
    el('p', {}, 'Expected pay, pay dates and balances. Bank deposits fill in real checks on import.')
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Planned income'),
    el('p', { className: 'section-hint' },
      'Expected take-home for this month. Open a source to set pay dates and bank match terms (e.g. “DFAS”). Unmatched deposits go to Bonus Income.',
    ),
    el('div', { className: 'card' },
      el('div', { className: 'table-wrap income-desktop-list' },
        el('table', { className: 'income-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Source'),
            el('th', {}, 'Type'),
            el('th', {}, 'This Month'),
            el('th', {}, 'Schedule'),
            el('th', {}, ''),
          )),
          el('tbody', {},
            ...plannedSources.map(src => incomeRow(src, state)),
          ),
        ),
      ),
      el('div', { className: 'income-mobile-list list-group' },
        ...plannedSources.map(src => incomeListRow(src, state)),
      ),
      el('button', {
        className: 'btn btn-secondary mt-4',
        onClick: () => {
          store.update(s => {
            const plannedCount = s.incomeSources.filter(x => x.type !== 'bonus').length;
            const name = plannedCount === 0 ? 'Primary'
              : plannedCount === 1 ? 'Secondary'
              : plannedCount === 2 ? 'Tertiary'
              : plannedCount === 3 ? 'Additional'
              : `Additional ${plannedCount - 2}`;
            s.incomeSources.push({
              id: crypto.randomUUID(),
              name,
              amount: 0,
              type: 'other',
              paySchedule: { mode: 'recurring', checks: [], recurring: { frequency: 'monthly', day1: 1, day2: null }, perCheckAmount: null },
              matchTerms: [],
            });
          });
          window.appRefresh();
        },
      }, '+ Add income source'),
      el('div', { className: 'income-total-row' },
        el('span', { className: 'income-total-label' },
          el('strong', {}, 'Total planned income'),
          el('span', { className: 'income-total-month' }, getMonthLabel(month)),
        ),
        el('strong', { className: 'income-total-value' }, formatCurrency(store.getTotalIncome(month))),
      ),
    ),
    bonusIncomeCard(month, bonusLogged, state),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, `Pay Calendar — ${getMonthLabel(month)}`),
    el('p', { className: 'section-hint' },
      'Edit dates opens a calendar. Purple days are GSA EFT (when checking gets paid). Tap days or add all GSA EFT for the year. CSV imports fill check amounts when descriptions match.'
    ),
    el('div', { className: 'pay-calendar-grid' },
      ...paychecks.map(p => payCalendarCard(p, state)),
    ),
  ));

  container.appendChild(el('div', { className: 'grid grid-2 section' },
    balanceCard('Checking Account', state.balances.checking, 'accent', val => {
      store.update(s => { s.balances.checking = val; });
    }),
    balanceCard('Emergency Fund', state.balances.emergencyFund, 'positive', val => {
      store.update(s => { s.balances.emergencyFund = val; });
    }, store.getEmergencyFundTarget()),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Other Savings Accounts'),
    el('div', { className: 'card', id: 'savings-card' }, renderSavings(state)),
  ));
}

function bonusIncomeCard(month, bonusLogged, state) {
  const bonus = store.getBonusIncomeSource();
  const bonusTx = bonus
    ? store.getTransactionsForMonth(month)
      .filter(t => t.type === 'income' && t.incomeSourceId === bonus.id)
      .sort((a, b) => b.date.localeCompare(a.date))
    : [];

  return el('div', { className: 'card bonus-income-card mt-4' },
    el('div', { className: 'bonus-income-header' },
      el('div', {},
        el('div', { className: 'card-title' }, BONUS_INCOME_NAME),
        el('p', { className: 'fs-footnote text-muted mx-0 mt-1 mb-0' },
          'Refunds and extra deposits sit in the bonus pot. Budget → Assign bonus sends any amount to any envelope. They are not sent back to the original purchase.'
        ),
      ),
      el('div', { className: 'card-value accent' }, formatCurrency(bonusLogged)),
    ),
    bonusTx.length
      ? el('div', { className: 'bonus-income-list' },
        ...bonusTx.map(t => {
          const cat = t.categoryId
            ? state.categories.find(c => c.id === t.categoryId)
            : null;
          const assigned = !!(t.earmarkedEnvelope || t.refundOfTxId || cat);
          return el('div', { className: 'bonus-income-item' },
            el('span', {}, formatDate(t.date)),
            el('span', { className: 'bonus-income-desc' },
              t.description || '—',
              assigned
                ? el('span', {
                  style: 'display:block;font-size:0.75rem;color:var(--text-muted)',
                }, cat ? `→ ${cat.name}` : 'Assigned to envelope')
                : null,
            ),
            el('span', { className: 'fw-semi text-positive' }, `+${formatCurrency(t.amount)}`),
          );
        }),
      )
      : el('p', { className: 'fs-footnote text-muted mx-0 mt-2 mb-0' },
        'No bonus income logged this month. Unmatched CSV deposits or manual income entries appear here.'
      ),
  );
}

const TYPE_LABELS = {
  job: 'Job',
  va: 'Disability',
  retirement: 'Retirement',
  side: 'Side Income',
  other: 'Other',
};

function expectedAmountInput(src) {
  const monthTotal = store.getSourceIncomeForMonth(src, getCurrentMonth());
  const shown = monthTotal > 0 ? monthTotal : (Number(src.amount) || '');
  const input = el('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    className: 'income-amount-input',
    value: shown === '' ? '' : shown,
    placeholder: '0.00',
    inputMode: 'decimal',
  });
  input.addEventListener('change', () => {
    store.setIncomeSourceMonthlyAmount(src.id, input.value);
    window.appRefresh();
  });
  return input;
}

function incomeRow(src, state) {
  const month = getCurrentMonth();
  const checks = getScheduledChecksForMonth(src, month);
  const nameInput = el('input', { type: 'text', value: src.name });
  nameInput.addEventListener('change', () => store.update(s => {
    const i = s.incomeSources.find(x => x.id === src.id);
    if (i) i.name = nameInput.value;
  }));

  const typeSelect = el('select');
  Object.entries(TYPE_LABELS).forEach(([t, label]) => {
    typeSelect.appendChild(el('option', { value: t }, label));
  });
  typeSelect.value = src.type;
  typeSelect.addEventListener('change', () => store.update(s => {
    const i = s.incomeSources.find(x => x.id === src.id);
    if (i) i.type = typeSelect.value;
  }));

  return el('tr', {},
    el('td', {}, nameInput),
    el('td', {}, typeSelect),
    el('td', {},
      expectedAmountInput(src),
      checks.length
        ? el('div', { className: 'schedule-summary' },
          `${checks.length} check${checks.length === 1 ? '' : 's'} on calendar`
        )
        : el('div', { className: 'schedule-summary' }, 'Type the amount you expect this month'),
    ),
    el('td', {},
      el('button', {
        className: 'btn btn-sm btn-secondary pay-schedule-btn',
        onClick: () => openPayScheduleEditor(src),
      }, 'Edit dates'),
      el('div', { className: 'schedule-summary' }, scheduleSummary(src)),
    ),
    el('td', {},
      el('button', {
        className: 'btn btn-sm btn-danger',
        onClick: () => confirmDeleteIncomeSource(src),
      }, 'Delete'),
    ),
  );
}

function confirmDeleteIncomeSource(src) {
  confirmDialog(
    'Delete income source?',
    `Remove “${src.name || 'this source'}” and its pay calendar? Past transactions stay; they just won’t link to this source.`,
    () => {
      store.update(s => { s.incomeSources = s.incomeSources.filter(x => x.id !== src.id); });
      showToast('Income source removed');
      window.appRefresh();
    },
  );
}

function incomeCard(src, state) {
  const month = getCurrentMonth();
  const checks = getScheduledChecksForMonth(src, month);

  const nameInput = el('input', { type: 'text', value: src.name || '' });
  nameInput.addEventListener('change', () => store.update(s => {
    const i = s.incomeSources.find(x => x.id === src.id);
    if (i) i.name = nameInput.value;
  }));

  const typeSelect = el('select');
  Object.entries(TYPE_LABELS).forEach(([t, label]) => {
    typeSelect.appendChild(el('option', { value: t }, label));
  });
  typeSelect.value = src.type;
  typeSelect.addEventListener('change', () => store.update(s => {
    const i = s.incomeSources.find(x => x.id === src.id);
    if (i) i.type = typeSelect.value;
  }));

  return el('article', { className: 'tx-card income-card' },
    el('div', { className: 'form-group' }, labelFor('Source', nameInput), nameInput),
    el('div', { className: 'input-row' },
      el('div', { className: 'form-group' }, labelFor('Type', typeSelect), typeSelect),
      el('div', { className: 'form-group' }, el('label', {}, 'This month'), expectedAmountInput(src)),
    ),
    el('div', { className: 'tx-card-meta' },
      checks.length
        ? `${checks.length} check${checks.length === 1 ? '' : 's'} this month · ${scheduleSummary(src)}`
        : scheduleSummary(src),
    ),
    el('div', { className: 'tx-card-actions' },
      el('button', {
        className: 'btn btn-sm btn-secondary',
        onClick: () => openPayScheduleEditor(src),
      }, 'Edit dates'),
      el('button', {
        className: 'btn btn-sm btn-danger',
        onClick: () => confirmDeleteIncomeSource(src),
      }, 'Delete'),
    )
  );
}

function payCalendarCard(pay, state) {
  const source = state.incomeSources.find(s => s.id === pay.id);
  const upcoming = source ? getUpcomingChecks(source, { limit: 3 }) : [];

  return el('div', { className: 'card pay-calendar-card' },
    el('div', { className: 'pay-calendar-header' },
      el('div', {},
        el('strong', {}, pay.name),
        el('div', { className: 'pay-calendar-meta' },
          `${formatCurrency(pay.received)} of ${formatCurrency(pay.expected)} this month`
        ),
      ),
      el('button', {
        className: 'btn btn-sm btn-secondary',
        onClick: () => source && openPayScheduleEditor(source),
      }, 'Edit'),
    ),
    pay.checks.length
      ? el('div', { className: 'pay-check-timeline' },
        ...pay.checks.map(c => {
          const st = CHECK_STATUS[c.status] || CHECK_STATUS.pending;
          return el('div', { className: `pay-check-chip ${st.cls}` },
            el('span', { className: 'pay-check-icon' }, st.icon),
            el('span', {},
              el('span', { className: 'pay-check-date' }, formatDate(c.date)),
              el('span', { className: 'pay-check-amt' }, formatCurrency(c.amount)),
            ),
          );
        }),
      )
      : el('p', { className: 'pay-dates-empty' }, 'No pay dates this month — edit schedule to add them.'),
    upcoming.length ? el('div', { className: 'pay-upcoming' },
      el('span', { className: 'pay-upcoming-label' }, 'Up next:'),
      upcoming.map(c => formatDate(c.date)).join(' · '),
    ) : null,
  );
}

function balanceCard(title, balance, cls, onSave, target = null) {
  const input = el('input', { type: 'number', step: '0.01', value: balance });
  const card = el('div', { className: 'card' },
    el('div', { className: 'card-title' }, title),
    el('div', { className: `card-value ${cls} mb-4` }, formatCurrency(balance)),
    el('div', { className: 'form-group' }, labelFor('Update Balance', input), input),
  );

  if (target) {
    const pct = Math.min(100, (balance / target) * 100);
    card.appendChild(el('p', { className: 'fs-footnote text-muted' },
      `Target: ${formatCurrency(target)} (${pct.toFixed(0)}%)`
    ));
    card.appendChild(el('div', { className: 'progress-bar' },
      el('div', { className: 'progress-fill', style: `width:${pct}%` }),
    ));
  }

  card.appendChild(el('button', {
    className: 'btn btn-primary btn-sm mt-3',
    onClick: () => { onSave(Number(input.value)); showToast('Balance saved!'); window.appRefresh(); },
  }, 'Save'));

  return card;
}

function renderSavings(state) {
  const wrapper = el('div', {});
  if (!state.balances.savings.length) {
    wrapper.appendChild(el('p', { className: 'text-muted mb-4' }, 'No additional savings accounts yet.'));
  }
  state.balances.savings.forEach((acct, i) => {
    const nameIn = el('input', { type: 'text', value: acct.name });
    const balIn = el('input', { type: 'number', step: '0.01', value: acct.balance });
    wrapper.appendChild(el('div', { className: 'input-row', style: 'margin-bottom:0.5rem;align-items:flex-end' },
      el('div', { className: 'form-group' }, labelFor('Account Name', nameIn), nameIn),
      el('div', { className: 'form-group' }, labelFor('Balance', balIn), balIn),
      el('button', {
        className: 'btn btn-sm btn-danger',
        onClick: () => {
          store.update(s => { s.balances.savings.splice(i, 1); });
          window.appRefresh();
        },
      }, 'Remove'),
    ));
    nameIn.addEventListener('change', () => store.update(s => { s.balances.savings[i].name = nameIn.value; }));
    balIn.addEventListener('change', () => store.update(s => { s.balances.savings[i].balance = Number(balIn.value); }));
  });

  wrapper.appendChild(el('button', {
    className: 'btn btn-secondary',
    onClick: () => {
      store.update(s => {
        s.balances.savings.push({ id: crypto.randomUUID(), name: 'Savings Account', balance: 0 });
      });
      window.appRefresh();
    },
  }, '+ Add Savings Account'));

  return wrapper;
}
/** Phone: one tappable row per source; details + schedule open in a sheet. */
function incomeListRow(src, state) {
  const month = getCurrentMonth();
  const checks = getScheduledChecksForMonth(src, month);
  const meta = checks.length
    ? `${checks.length} check${checks.length === 1 ? '' : 's'} this month · ${scheduleSummary(src)}`
    : scheduleSummary(src);
  const open = () => {
    let modal;
    const card = incomeCard(src, state);
    const actions = card.querySelector('.tx-card-actions');
    if (actions) actions.remove();
    modal = showModal({
      title: src.name || 'Income source',
      body: el('div', {},
        card,
        el('div', { className: 'list-group mt-3' },
          el('button', {
            type: 'button', className: 'list-row list-row-button',
            onClick: () => { modal.close(); openPayScheduleEditor(src); },
          },
            el('span', { className: 'list-row__icon' }, icon('clock', 22)),
            el('span', { className: 'list-row__body' },
              el('span', { className: 'list-row__title' }, 'Pay schedule'),
              el('span', { className: 'list-row__meta' }, scheduleSummary(src)),
            ),
            el('span', { className: 'list-row__chev' }, icon('chevron', 18)),
          ),
        ),
      ),
      footer: [
        el('button', { type: 'button', className: 'btn btn-danger', onClick: () => { modal.close(); confirmDeleteIncomeSource(src); } }, 'Delete source'),
        el('button', { type: 'button', className: 'btn btn-primary', onClick: () => modal.close() }, 'Done'),
      ],
      onClose: () => window.appRefresh(),
    });
  };
  return el('button', { type: 'button', className: 'list-row list-row-button', onClick: open },
    el('span', { className: 'list-row__icon' }, icon('income', 22)),
    el('span', { className: 'list-row__body' },
      el('span', { className: 'list-row__title' }, src.name || 'Income source'),
      el('span', { className: 'list-row__meta' }, meta),
    ),
    el('span', { className: 'list-row__amount' }, formatCurrency(store.getSourceIncomeForMonth(src, month) || Number(src.amount) || 0)),
    el('span', { className: 'list-row__chev' }, icon('chevron', 18)),
  );
}
