import { el, formatCurrency, formatDate, getCurrentMonth, getMonthLabel } from '../utils.js';
import { store } from '../store.js';
import { showToast } from '../components/modal.js';
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
    el('h2', {}, 'Income & Balances'),
    el('p', {}, 'Set pay dates on your calendar — amounts update automatically when income deposits import from CSV')
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Planned Income Sources'),
    el('p', { className: 'section-hint' },
      'Name your pay sources (Primary, Secondary, Tertiary, or add more). In Edit dates, set bank-description match terms so CSV imports assign deposits automatically. Unmatched income goes to Bonus Income.'
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
      el('div', { className: 'income-mobile-list' },
        ...plannedSources.map(src => incomeCard(src, state)),
      ),
      el('button', {
        className: 'btn btn-secondary',
        style: 'margin-top:1rem',
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
      }, '+ Add Income Source'),
      el('div', { className: 'income-total-row' },
        el('strong', {}, `Total Planned Income — ${getMonthLabel(month)}`),
        el('strong', { className: 'income-total-value' }, formatCurrency(store.getTotalIncome(month))),
      ),
    ),
    bonusIncomeCard(month, bonusLogged, state),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, `Pay Calendar — ${getMonthLabel(month)}`),
    el('p', { className: 'section-hint' },
      'Add pay dates via Edit dates. CSV imports fill in check amounts when descriptions match. Add next-year federal dates each October.'
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

  return el('div', { className: 'card bonus-income-card', style: 'margin-top:1rem' },
    el('div', { className: 'bonus-income-header' },
      el('div', {},
        el('div', { className: 'card-title' }, BONUS_INCOME_NAME),
        el('p', { style: 'font-size:0.8rem;color:var(--text-muted);margin:0.25rem 0 0' },
          'Extra income from other sources — not part of your planned paychecks. Counts toward To Allocate so you can assign it freely.'
        ),
      ),
      el('div', { className: 'card-value accent' }, formatCurrency(bonusLogged)),
    ),
    bonusTx.length
      ? el('div', { className: 'bonus-income-list' },
        ...bonusTx.map(t => el('div', { className: 'bonus-income-item' },
          el('span', {}, formatDate(t.date)),
          el('span', { className: 'bonus-income-desc' }, t.description || '—'),
          el('span', { style: 'font-weight:600;color:var(--positive)' }, `+${formatCurrency(t.amount)}`),
        )),
      )
      : el('p', { style: 'font-size:0.8rem;color:var(--text-muted);margin:0.5rem 0 0' },
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

function incomeRow(src, state) {
  const month = getCurrentMonth();
  const checks = getScheduledChecksForMonth(src, month);
  const monthTotal = store.getSourceIncomeForMonth(src, month);
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
      el('span', { style: 'font-weight:600' }, formatCurrency(monthTotal)),
      checks.length
        ? el('div', { className: 'schedule-summary' },
          `${checks.length} check${checks.length === 1 ? '' : 's'} on calendar`
        )
        : el('div', { className: 'schedule-summary' }, 'Set pay dates to calculate'),
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
        onClick: () => {
          store.update(s => { s.incomeSources = s.incomeSources.filter(x => x.id !== src.id); });
          window.appRefresh();
        },
      }, 'Delete'),
    ),
  );
}

function incomeCard(src, state) {
  const month = getCurrentMonth();
  const checks = getScheduledChecksForMonth(src, month);
  const monthTotal = store.getSourceIncomeForMonth(src, month);

  return el('article', { className: 'tx-card income-card' },
    el('div', { className: 'tx-card-top' },
      el('span', { className: 'tx-card-desc' }, src.name || 'Income source'),
      el('span', { className: 'tx-card-amount' }, formatCurrency(monthTotal))
    ),
    el('div', { className: 'tx-card-body' },
      el('div', { className: 'tx-card-meta' },
        TYPE_LABELS[src.type] || src.type || 'Other',
        checks.length
          ? ` · ${checks.length} check${checks.length === 1 ? '' : 's'} this month`
          : ' · Set pay dates',
      ),
      el('div', { className: 'tx-card-meta' }, scheduleSummary(src)),
    ),
    el('div', { className: 'tx-card-actions' },
      el('button', {
        className: 'btn btn-sm btn-secondary',
        onClick: () => openPayScheduleEditor(src),
      }, 'Edit dates'),
      el('button', {
        className: 'btn btn-sm btn-danger',
        onClick: () => {
          store.update(s => { s.incomeSources = s.incomeSources.filter(x => x.id !== src.id); });
          window.appRefresh();
        },
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
    el('div', { className: `card-value ${cls}`, style: 'margin-bottom:1rem' }, formatCurrency(balance)),
    el('div', { className: 'form-group' }, el('label', {}, 'Update Balance'), input),
  );

  if (target) {
    const pct = Math.min(100, (balance / target) * 100);
    card.appendChild(el('p', { style: 'font-size:0.8rem;color:var(--text-muted)' },
      `Target: ${formatCurrency(target)} (${pct.toFixed(0)}%)`
    ));
    card.appendChild(el('div', { className: 'progress-bar' },
      el('div', { className: 'progress-fill', style: `width:${pct}%` }),
    ));
  }

  card.appendChild(el('button', {
    className: 'btn btn-primary btn-sm',
    style: 'margin-top:0.75rem',
    onClick: () => { onSave(Number(input.value)); showToast('Balance saved!'); window.appRefresh(); },
  }, 'Save'));

  return card;
}

function renderSavings(state) {
  const wrapper = el('div', {});
  if (!state.balances.savings.length) {
    wrapper.appendChild(el('p', { style: 'color:var(--text-muted);margin-bottom:1rem' }, 'No additional savings accounts yet.'));
  }
  state.balances.savings.forEach((acct, i) => {
    const nameIn = el('input', { type: 'text', value: acct.name });
    const balIn = el('input', { type: 'number', step: '0.01', value: acct.balance });
    wrapper.appendChild(el('div', { className: 'input-row', style: 'margin-bottom:0.5rem;align-items:flex-end' },
      el('div', { className: 'form-group' }, el('label', {}, 'Account Name'), nameIn),
      el('div', { className: 'form-group' }, el('label', {}, 'Balance'), balIn),
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