import { el, formatCurrency, getCurrentMonth, getMonthLabel } from '../utils.js';
import { store } from '../store.js';
import { BABY_STEPS, MOTIVATIONAL_MESSAGES } from '../defaults.js';
import { showModal, showToast } from '../components/modal.js';
import { renderReviewBanner } from '../components/review-inbox.js';
import { openMonthCloseWizard } from '../components/month-close.js';

export function renderDashboard(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const income = store.getTotalIncome(month);
  const bonusLogged = store.getBonusIncomeLogged(month);
  const budgeted = store.getTotalBudgeted();
  const spent = store.getTotalSpent();
  const surplus = store.getSurplusForSnowball();
  const surplusBasis = store.getSurplusBasis();
  const surplusIncomeNote = surplusBasis === 'unallocated'
    ? 'From zero-based budget (income minus envelope totals)'
    : surplusBasis === 'cashflow'
      ? (store.usesLoggedIncomeForSurplus()
        ? 'From income received minus spending this month'
        : 'From planned income minus spending this month')
      : 'Assign income to envelopes or log transactions to build surplus';
  const babyStep = store.detectBabyStep();
  const celebration = store.getLatestCelebration();
  const target = store.getSnowballTarget();
  const upcoming = store.getUpcomingBills(7);
  const inbox = store.getReviewInbox(month);
  const paychecks = store.getPaycheckStatus(month);
  const reconciliation = store.getReconciliationStatus();
  const msg = MOTIVATIONAL_MESSAGES[Math.floor(Math.random() * MOTIVATIONAL_MESSAGES.length)];

  container.innerHTML = '';

  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Dashboard'),
    el('p', {}, getMonthLabel(month) + ' — Give every dollar a job'),
    el('div', { className: 'btn-group', style: 'margin-top:0.75rem' },
      el('button', { className: 'btn btn-secondary btn-sm', onClick: openMonthCloseWizard }, 'Month-Close Checklist'),
    ),
  ));

  const reviewBanner = renderReviewBanner(inbox);
  if (reviewBanner) container.appendChild(reviewBanner);

  if (celebration && celebration.date === new Date().toISOString().slice(0, 10)) {
    container.appendChild(el('div', { className: 'banner banner-celebration confetti-burst' },
      el('div', { className: 'banner-icon' }, '🎉'),
      el('div', { className: 'banner-text' },
        el('h3', {}, celebration.message),
        el('p', {}, 'Keep rolling that snowball!')
      )
    ));
  } else if (target) {
    container.appendChild(el('div', { className: 'banner banner-action' },
      el('div', { className: 'banner-icon' }, '🎯'),
      el('div', { className: 'banner-text' },
        el('h3', {}, `Current snowball target: ${target.name}`),
        el('p', {}, `Balance: ${formatCurrency(target.balance)} — Minimum: ${formatCurrency(target.minPayment)}`)
      )
    ));
  }

  container.appendChild(el('div', { className: 'banner banner-motivation' },
    el('div', { className: 'banner-text' }, el('p', {}, `"${msg}"`))
  ));

  container.appendChild(el('div', { className: 'quick-actions' },
    quickAction('📝', 'Log Expense', () => window.appNavigate('transactions', 'expense')),
    quickAction('📥', 'Review Inbox', () => window.appNavigate('transactions')),
    quickAction('💸', 'Allocate Surplus', () => allocateSurplus()),
    quickAction('✉️', 'Fund Envelope', () => window.appNavigate('budget')),
  ));

  container.appendChild(el('div', { className: 'grid grid-4 section' },
    statCard('Checking Balance', formatCurrency(state.balances.checking), 'accent', () => editBalance('checking')),
    statCard('Emergency Fund', formatCurrency(state.balances.emergencyFund), 'positive', () => editBalance('emergency')),
    statCard(
      'Monthly Income',
      formatCurrency(income),
      '',
      null,
      false,
      bonusLogged > 0 ? `+ ${formatCurrency(bonusLogged)} bonus income allocatable` : null,
    ),
    statCard('Surplus for Snowball', formatCurrency(surplus), surplus > 0 ? 'positive' : '', null, true, surplusIncomeNote),
  ));

  container.appendChild(el('div', { className: 'grid grid-3 section' },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Budget vs Actual'),
      el('div', { style: 'display:flex;justify-content:space-between;margin-top:0.5rem' },
        el('div', {},
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Budgeted'),
          el('div', { style: 'font-weight:700' }, formatCurrency(budgeted))
        ),
        el('div', {},
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Spent'),
          el('div', { style: 'font-weight:700;color:var(--text)' }, formatCurrency(spent))
        ),
        el('div', {},
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Remaining'),
          el('div', { style: `font-weight:700;color:${budgeted - spent >= 0 ? 'var(--positive)' : 'var(--negative)'}` },
            formatCurrency(budgeted - spent))
        ),
      ),
      progressBar(spent, budgeted)
    ),
    babyStepCard(babyStep),
    debtSummaryCard(),
  ));

  container.appendChild(el('div', { className: 'grid grid-2 section' },
    paycheckCard(paychecks),
    reconciliationCard(reconciliation),
  ));

  if (upcoming.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, 'Upcoming Bills (7 days)'),
      el('div', { className: 'card' },
        el('div', { className: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {},
              el('th', {}, 'Bill'), el('th', {}, 'Due'), el('th', {}, 'Amount'), el('th', {}, 'Status')
            )),
            el('tbody', {},
              ...upcoming.slice(0, 5).map(b => el('tr', {},
                el('td', {}, b.name),
                el('td', {}, b.dueDate),
                el('td', {}, formatCurrency(b.amount)),
                el('td', {}, billBadge(b))
              ))
            )
          )
        )
      )
    ));
  }
}

function statCard(title, value, cls = '', onClick = null, highlight = false, subtitle = '') {
  const card = el('div', {
    className: `card${highlight ? ' confetti-burst' : ''}`,
    style: onClick ? 'cursor:pointer' : '',
    onClick,
  },
    el('div', { className: 'card-title' }, title),
    el('div', { className: `card-value ${cls}` }, value)
  );
  if (subtitle) {
    card.appendChild(el('div', { style: 'font-size:0.7rem;color:var(--text-muted);margin-top:0.25rem;line-height:1.4' }, subtitle));
  } else if (onClick) {
    card.appendChild(el('div', { style: 'font-size:0.7rem;color:var(--text-muted);margin-top:0.25rem' }, 'Tap to update'));
  }
  return card;
}

function progressBar(spent, budgeted) {
  const pct = budgeted > 0 ? Math.min(100, (spent / budgeted) * 100) : 0;
  return el('div', { className: 'progress-bar' },
    el('div', { className: 'progress-fill', style: `width:${pct}%` })
  );
}

function babyStepCard(step) {
  const info = BABY_STEPS.find(b => b.step === step) || BABY_STEPS[0];
  const ef = store.getState().balances.emergencyFund;
  const target = store.getEmergencyFundTarget();
  const pct = Math.min(100, (ef / target) * 100);

  return el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Baby Step Progress'),
    el('div', { style: 'font-weight:700;margin-bottom:0.25rem' }, `Step ${step}: ${info.title}`),
    el('p', { style: 'font-size:0.8rem;color:var(--text-muted)' }, info.description),
    el('div', { className: 'baby-steps' },
      ...BABY_STEPS.map(bs => el('div', {
        className: `baby-step${bs.step < step ? ' done' : ''}${bs.step === step ? ' current' : ''}`
      }, String(bs.step)))
    ),
    step <= 3 ? el('div', { style: 'margin-top:0.75rem' },
      el('div', { style: 'font-size:0.8rem' }, `Emergency Fund: ${formatCurrency(ef)} / ${formatCurrency(target)}`),
      progressBar(ef, target)
    ) : null
  );
}

function debtSummaryCard() {
  const total = store.getTotalDebt();
  const months = store.estimateMonthsToDebtFree();
  const debts = store.getActiveDebts();

  return el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Debt Snowball'),
    el('div', { className: 'card-value', style: 'font-size:1.4rem' }, formatCurrency(total)),
    el('p', { style: 'font-size:0.8rem;color:var(--text-muted);margin-top:0.25rem' },
      debts.length ? `${debts.length} debts · ~${months} months to freedom` : 'Debt free! 🎉'
    )
  );
}

function billBadge(b) {
  if (b.status === 'paid') return el('span', { className: 'badge badge-paid' }, 'Paid');
  if (b.daysLeft < 0) return el('span', { className: 'badge badge-overdue' }, 'Overdue');
  if (b.autoPay) return el('span', { className: 'badge badge-autopay' }, 'Auto-pay');
  return el('span', { className: 'badge badge-due' }, 'Due Soon');
}

function quickAction(icon, label, onClick) {
  return el('button', { className: 'quick-action-btn', onClick },
    el('span', { className: 'qa-icon' }, icon),
    el('span', { className: 'qa-label' }, label)
  );
}

function editBalance(type) {
  const state = store.getState();
  const isChecking = type === 'checking';
  const current = isChecking ? state.balances.checking : state.balances.emergencyFund;

  const input = el('input', { type: 'number', step: '0.01', value: current });
  showModal({
    title: isChecking ? 'Update Checking Balance' : 'Update Emergency Fund',
    body: el('div', { className: 'form-group' }, el('label', {}, 'Current Balance'), input),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        store.update(s => {
          if (isChecking) s.balances.checking = Number(input.value);
          else s.balances.emergencyFund = Number(input.value);
        });
        this.closest('.modal-backdrop').remove();
        showToast('Balance updated!');
        window.appRefresh();
      }
    }, 'Save'),
  });
}

function paycheckCard(paychecks) {
  return el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Paychecks This Month'),
    el('div', { className: 'paycheck-list' },
      ...paychecks.map(p => {
        const statusCls = p.status === 'complete' ? 'positive' : p.status === 'partial' ? 'accent' : 'muted';
        return el('div', { className: 'paycheck-row-dashboard' },
          el('div', { className: 'paycheck-row-top' },
            el('strong', {}, p.name),
            el('span', { className: `paycheck-status ${statusCls}` },
              `${formatCurrency(p.received)} / ${formatCurrency(p.expected)}`
            ),
          ),
          p.checks.length
            ? el('div', { className: 'paycheck-mini-timeline' },
              ...p.checks.map(c => el('span', {
                className: `paycheck-dot ${c.status}`,
                title: `${c.date}: ${c.status}`,
              }, c.status === 'received' ? '✓' : c.status === 'overdue' ? '!' : '○')),
            )
            : el('div', { style: 'font-size:0.75rem;color:var(--text-muted)' },
              `${p.checksReceived}/${p.checksExpected} checks`
            ),
        );
      }),
    ),
    el('button', {
      className: 'btn btn-sm btn-secondary',
      style: 'margin-top:0.75rem',
      onClick: () => window.appNavigate('income'),
    }, 'Edit pay dates'),
  );
}

function reconciliationCard(recon) {
  const gap = recon.gap;
  const gapText = recon.bankBalance == null
    ? 'Enter your bank app balance to compare'
    : recon.matched
      ? '✓ Matches your logged checking balance'
      : `${formatCurrency(Math.abs(gap))} ${gap > 0 ? 'higher' : 'lower'} than logged`;

  return el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Checking Reconciliation'),
    el('div', { style: 'font-size:0.85rem;line-height:1.6;margin-bottom:0.75rem' },
      el('div', {}, `Logged: ${formatCurrency(recon.logged)}`),
      recon.bankBalance != null ? el('div', {}, `Bank: ${formatCurrency(recon.bankBalance)}`) : null,
      el('div', { style: `color:${recon.matched ? 'var(--positive)' : recon.bankBalance != null ? 'var(--negative)' : 'var(--text-muted)'}` },
        gapText
      ),
      recon.asOfDate ? el('div', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem' },
        `As of ${recon.asOfDate}`
      ) : null,
    ),
    el('button', {
      className: 'btn btn-sm btn-primary',
      onClick: () => openReconciliationDialog(recon),
    }, recon.bankBalance == null ? 'Reconcile' : 'Update'),
  );
}

function openReconciliationDialog(recon) {
  const input = el('input', { type: 'number', step: '0.01', value: recon.bankBalance ?? recon.logged });
  const dateIn = el('input', { type: 'date', value: recon.asOfDate || new Date().toISOString().slice(0, 10) });
  showModal({
    title: 'Reconcile Checking',
    body: el('div', {},
      el('p', { style: 'margin-bottom:1rem;color:var(--text-muted);font-size:0.9rem' },
        'Enter the balance shown in your bank app. A gap usually means a missing import, duplicate, or Mark Paid double-count.'
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Bank balance'), input),
      el('div', { className: 'form-group' }, el('label', {}, 'As of date'), dateIn),
      el('p', { style: 'font-size:0.85rem' }, `Logged checking: ${formatCurrency(recon.logged)}`),
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        store.setReconciliation(Number(input.value), dateIn.value);
        this.closest('.modal-backdrop').remove();
        showToast('Reconciliation saved');
        window.appRefresh();
      },
    }, 'Save'),
  });
}

function allocateSurplus() {
  const surplus = store.getSurplusForSnowball();
  const target = store.getSnowballTarget();
  if (!target) {
    showToast('No active debts in your snowball!', 'info');
    return;
  }
  const input = el('input', { type: 'number', step: '0.01', value: surplus, min: 0 });
  showModal({
    title: 'Allocate Surplus to Debt Snowball',
    body: el('div', {},
      el('p', { style: 'margin-bottom:1rem' }, `Send extra money to ${target.name}`),
      el('div', { className: 'form-group' }, el('label', {}, 'Amount'), input)
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        const result = store.allocateSurplusToDebt(Number(input.value));
        this.closest('.modal-backdrop').remove();
        if (result) {
          showToast(`Allocated to ${result.name}!`, 'celebration');
          window.appRefresh();
        }
      }
    }, 'Allocate'),
  });
}