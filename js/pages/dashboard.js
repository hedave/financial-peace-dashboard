import { el, formatCurrency, formatDate, getCurrentMonth, getMonthLabel, todayISO, formatLocalISODate } from '../utils.js';
import { formatCandidateSummary } from '../reconcile-match.js';
import { store } from '../store.js';
import { BABY_STEPS } from '../defaults.js';
import { showModal, showToast, showUndoToast, confirmDialog } from '../components/modal.js';
import { renderReviewBanner, openPendingReview, openReviewInbox } from '../components/review-inbox.js';
import { openMonthCloseWizard } from '../components/month-close.js';
import { openEnvelopeActivity } from './budget.js';
import { getSyncStatus, isCloudConfigured } from '../cloud-sync.js';
import { refreshSyncChip } from '../components/layout.js';

/** Keep Home “More” panel open across soft refreshes. */
let dashMoreOpen = false;

export function renderDashboard(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const income = store.getTotalIncome(month);
  const bonusLogged = store.getBonusIncomeLogged(month);
  const budgeted = store.getTotalBudgeted();
  const spent = store.getTotalSpent();
  const surplus = store.getSurplusForSnowball();
  const surplusBasis = store.getSurplusBasis();
  const surplusCap = store.getSurplusCapInfo();
  // Month-end forecast breakdown (primary snowball number)
  const fc = surplusCap.forecast || store.getMonthEndSnowballForecast(month);
  const bankToday = surplusCap.bankToday != null
    ? surplusCap.bankToday
    : store.getBankSurplusForSnowball(month);
  const surplusSourceLine = surplus > 0.005
    ? 'Month-end forecast: after remaining income, unpaid bills, debt mins, and envelope plan'
    : 'Month-end forecast is $0 — income left, bills, envelopes, or cushion use up the cash path';
  const forecastLine = [
    `Now ${formatCurrency(fc.checking || 0)}`,
    (fc.incomeLeft || 0) > 0.005 ? `+ income left ${formatCurrency(fc.incomeLeft)}` : null,
    (fc.billsLeft || 0) > 0.005 ? `− bills due ${formatCurrency(fc.billsLeft)}` : '− bills $0',
    (fc.debtMinsLeft || 0) > 0.005 ? `− debt mins ${formatCurrency(fc.debtMinsLeft)}` : null,
    (fc.envelopeLeft || 0) > 0.005 ? `− envelope plan ${formatCurrency(fc.envelopeLeft)}` : null,
    (fc.buffer || 0) > 0.005 ? `− cushion ${formatCurrency(fc.buffer)}` : null,
  ].filter(Boolean).join(' ');
  const todayLine = bankToday > 0.005
    ? `Today (if you snowball now): ~${formatCurrency(bankToday)} after bills before next pay + cushion.`
    : 'Today: nothing free after bills before next pay + cushion — wait for income or pay down holds.';
  const toAllocNote = (fc.toAllocate || 0) < -0.005
    ? ` To Allocate ${formatCurrency(fc.toAllocate)} means the plan is over income — forecast still runs; fix budgets if the plan is wrong.`
    : '';
  const surplusIncomeNote = `${surplusSourceLine}. ${forecastLine}. ${todayLine}${toAllocNote} Tap to send (runway checks today).`;
  const runway = store.getCashRunway();
  const billWarnings = store.getBillScheduleWarnings();
  const babyStep = store.detectBabyStep();
  const celebration = store.getLatestCelebration();
  const target = store.getSnowballTarget();
  const upcoming = store.getUpcomingBills(7);
  const inbox = store.getReviewInbox(month);
  const paychecks = store.getPaycheckStatus(month);
  const reconciliation = store.getReconciliationMatches();
  const topEnvelopes = store.getTopEnvelopesBySpend(5, month);
  const pendingCount = inbox.pending?.length || 0;

  container.innerHTML = '';

  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Dashboard'),
    el('p', {}, getMonthLabel(month) + ' — Give every dollar a job'),
    el('div', { className: 'dash-header-meta' },
      el('button', {
        type: 'button',
        className: 'month-close-link',
        onClick: openMonthCloseWizard,
      }, 'Month-close checklist →'),
      isCloudConfigured() ? el('button', {
        type: 'button',
        className: 'dash-sync-pill',
        title: 'Tap to sync now',
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Syncing…';
          try {
            await store.pushToCloud({ force: true });
            showToast('Synced to cloud', 'success');
            refreshSyncChip();
            window.appRefresh();
          } catch {
            showToast('Sync failed — try Settings', 'info');
          } finally {
            btn.disabled = false;
          }
        },
      }, dashSyncLabel()) : null,
    ),
  ));

  // —— Above the fold: act → cash → week ——
  const reviewBanner = renderReviewBanner(inbox);
  if (reviewBanner) container.appendChild(reviewBanner);

  const overCapEnvelopes = store.getEnvelopesOverSoftCap();
  const notedEnvelopes = store.getEnvelopesWithNotes();
  const toAllocate = store.getToAllocate();
  const daveMode = store.isDaveRamseyMode();
  const toAllocateOff = Math.abs(toAllocate) >= 0.01;

  // Compact action chips (replaces multiple full banners)
  const actionChips = [];
  if (daveMode && toAllocateOff) {
    actionChips.push(el('button', {
      type: 'button',
      className: 'chip chip-warn',
      onClick: () => window.appNavigate('budget'),
    }, toAllocate > 0
      ? `📊 ${formatCurrency(toAllocate)} needs a job`
      : `📊 Over by ${formatCurrency(Math.abs(toAllocate))}`));
  }
  if (pendingCount > 0) {
    actionChips.push(el('button', {
      type: 'button', className: 'chip chip-warn', onClick: () => openPendingReview(),
    }, `⏳ ${pendingCount} awaiting bank`));
  }
  if (inbox.uncategorized.length > 0) {
    actionChips.push(el('button', {
      type: 'button', className: 'chip chip-warn', onClick: () => openReviewInbox(),
    }, `🏷️ ${inbox.uncategorized.length} need categories`));
  }
  if (overCapEnvelopes.length > 0) {
    actionChips.push(el('button', {
      type: 'button', className: 'chip chip-warn',
      onClick: () => window.appNavigate('budget', { filter: 'attention' }),
    }, `🎯 ${overCapEnvelopes.length} over cap`));
  }
  if (notedEnvelopes.length > 0) {
    actionChips.push(el('button', {
      type: 'button', className: 'chip',
      onClick: () => window.appNavigate('budget'),
    }, `📝 ${notedEnvelopes.length} notes`));
  }
  billWarnings.forEach(w => {
    actionChips.push(el('button', {
      type: 'button',
      className: w.severity === 'warn' ? 'chip chip-warn' : 'chip',
      onClick: () => window.appNavigate(w.id === 'no_pay' ? 'income' : 'bills'),
    }, w.label.length > 48 ? `${w.label.slice(0, 46)}…` : w.label));
  });
  if (actionChips.length) {
    container.appendChild(el('div', { className: 'chip-bar section dash-alert-chips' }, ...actionChips));
  }

  // Celebration only (snowball target moves into compact strip)
  if (celebration && celebration.date === todayISO()) {
    container.appendChild(el('div', { className: 'banner banner-celebration confetti-burst section' },
      el('div', { className: 'banner-icon' }, '🎉'),
      el('div', { className: 'banner-text' },
        el('h3', {}, celebration.message),
        el('p', {}, 'Keep rolling that snowball!'),
      ),
    ));
  }

  // Primary stats: cash truth first
  container.appendChild(el('div', { className: 'grid grid-4 dash-stats section' },
    statCard('Checking', formatCurrency(state.balances.checking), 'accent', () => editBalance('checking'), false, 'Tap to update'),
    statCard(
      'Month-end snowball',
      formatCurrency(surplus),
      surplus > 0 ? 'positive' : '',
      () => allocateSurplus(),
      true,
      surplus > 0
        ? 'If the rest of the month goes to plan · tap to send'
        : 'Forecast $0 after income, bills & plan',
    ),
    statCard('Emergency Fund', formatCurrency(state.balances.emergencyFund), 'positive', () => editBalance('emergency')),
    statCard(
      'To Allocate',
      formatCurrency(toAllocate),
      Math.abs(toAllocate) < 0.01 ? 'positive' : toAllocate > 0 ? 'accent' : 'negative',
      () => window.appNavigate('budget'),
      false,
      Math.abs(toAllocate) < 0.01
        ? 'Every dollar has a job'
        : toAllocate < 0
          ? 'Over-budgeted — lower some envelopes'
          : 'Tap Budget to assign',
    ),
  ));

  container.appendChild(el('p', {
    className: 'tx-form-hint section dash-forecast-line',
    style: 'margin-top:0',
  }, forecastLine + '.' + (bankToday > 0.005
    ? ` Safe to send today: ${formatCurrency(bankToday)}.`
    : ' Nothing free to send today after bills before next pay + cushion.')
    + toAllocNote));

  container.appendChild(cashRunwayCard(runway, target, () => allocateSurplus()));

  container.appendChild(el('div', { className: 'quick-actions section' },
    quickAction('📝', 'Log Expense', () => window.appNavigate('transactions', 'expense')),
    quickAction('📥', 'Review', () => openReviewInbox()),
    quickAction('💸', 'Snowball $', () => allocateSurplus()),
    quickAction('✉️', 'Budget', () => window.appNavigate('budget')),
    quickAction('🧭', 'Advisor', () => window.appNavigate('advisor')),
  ));

  container.appendChild(weekAtAGlance(upcoming, paychecks));

  // New-month checklist (dismissible for this month)
  const dayOfMonth = new Date().getDate();
  const checklistDismissed = state.settings?.dismissMonthChecklist === month;
  if (dayOfMonth <= 7 && !checklistDismissed) {
    container.appendChild(el('div', { className: 'banner banner-action section' },
      el('div', { className: 'banner-icon' }, '📅'),
      el('div', { className: 'banner-text' },
        el('h3', {}, 'New month checklist'),
        el('p', {}, 'Review kids’ envelopes, To Allocate, and cash runway. Optional: copy last month from Budget tools.'),
      ),
      el('div', { className: 'btn-group', style: 'margin-left:auto;align-self:center' },
        el('button', {
          type: 'button', className: 'btn btn-secondary btn-sm',
          onClick: () => {
            store.update(s => { s.settings.dismissMonthChecklist = month; });
            window.appRefresh();
          },
        }, 'Dismiss'),
        el('button', {
          type: 'button', className: 'btn btn-primary btn-sm',
          onClick: () => window.appNavigate('budget'),
        }, 'Budget'),
      ),
    ));
  }

  // Collapsible secondary (less daily noise)
  const detailsBody = el('div', { className: 'dash-details-body' });
  if (target && !(celebration && celebration.date === todayISO())) {
    detailsBody.appendChild(el('div', { className: 'banner banner-action', style: 'margin-bottom:0.75rem' },
      el('div', { className: 'banner-icon' }, '🎯'),
      el('div', { className: 'banner-text' },
        el('h3', {}, `Snowball target: ${target.name}`),
        el('p', {}, `Balance ${formatCurrency(target.balance)} · Min ${formatCurrency(target.minPayment)} · Safe extra ${formatCurrency(surplus)}`),
      ),
      el('button', {
        type: 'button', className: 'btn btn-sm btn-primary', style: 'margin-left:auto',
        onClick: () => allocateSurplus(),
      }, 'Snowball $'),
    ));
  }
  detailsBody.appendChild(el('div', { className: 'grid grid-2 section', style: 'margin-bottom:0' },
    paycheckCard(paychecks),
    reconciliationCard(reconciliation),
  ));
  detailsBody.appendChild(el('div', { className: 'grid grid-2 section' },
    statCard('Monthly income (plan)', formatCurrency(income), '', null, false,
      bonusLogged > 0 ? `+ ${formatCurrency(bonusLogged)} bonus` : 'Pay calendar'),
    statCard('Emergency fund', formatCurrency(state.balances.emergencyFund), 'positive', () => editBalance('emergency')),
  ));

  const lastBackup = state.settings.lastBackupAt;
  const backupDays = lastBackup
    ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000)
    : null;
  if (backupDays == null || backupDays >= 30) {
    detailsBody.appendChild(el('p', { className: 'tx-form-hint', style: 'margin-top:0.75rem' },
      backupDays == null
        ? 'No JSON backup yet — Settings → Export Backup when you can.'
        : `Last backup ${backupDays} days ago — consider exporting a fresh copy.`,
      ' ',
      el('button', {
        type: 'button', className: 'linkish',
        onClick: () => window.appNavigate('settings'),
      }, 'Open Settings'),
    ));
  }

  const moreDetails = el('details', { className: 'section dash-details' },
    el('summary', { className: 'dash-details-summary' }, 'More: paychecks, recon, income, backup'),
    detailsBody,
  );
  moreDetails.open = !!dashMoreOpen;
  moreDetails.addEventListener('toggle', () => { dashMoreOpen = moreDetails.open; });
  container.appendChild(moreDetails);

  if (topEnvelopes.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, 'Top spending this month'),
      el('div', { className: 'card top-envelopes-card' },
        ...topEnvelopes.map(row => {
          const pct = row.budgeted > 0 ? Math.min(100, (row.spent / row.budgeted) * 100) : 100;
          return el('button', {
            type: 'button',
            className: 'top-envelope-row',
            onClick: () => openEnvelopeActivity(row.category),
          },
            el('div', { className: 'top-envelope-head' },
              el('span', {}, `${row.category.icon || '✉️'} ${row.category.name}`),
              el('strong', {}, formatCurrency(row.spent)),
            ),
            el('div', { className: 'progress-bar' },
              el('div', {
                className: 'progress-fill',
                style: `width:${pct}%;${row.remaining < 0 ? 'background:var(--negative)' : ''}`,
              }),
            ),
            el('div', { className: 'top-envelope-meta' },
              row.budgeted > 0
                ? `of ${formatCurrency(row.budgeted)} budgeted`
                : 'no budget set',
              ' · tap for transactions',
            ),
          );
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          style: 'margin-top:0.75rem;width:100%',
          onClick: () => window.appNavigate('budget', { filter: 'attention' }),
        }, 'Envelopes needing attention'),
      ),
    ));
  }

  // Slim progress row
  container.appendChild(el('div', { className: 'grid grid-3 section' },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Budget vs Actual'),
      el('div', { style: 'display:flex;justify-content:space-between;margin-top:0.5rem' },
        el('div', {},
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Budgeted'),
          el('div', { style: 'font-weight:700', className: 'money' }, formatCurrency(budgeted))
        ),
        el('div', {},
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Spent'),
          el('div', { style: 'font-weight:700;color:var(--text)', className: 'money' }, formatCurrency(spent))
        ),
        el('div', {},
          el('div', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Remaining'),
          el('div', {
            style: `font-weight:700;color:${budgeted - spent >= 0 ? 'var(--positive)' : 'var(--negative)'}`,
            className: 'money',
          }, formatCurrency(budgeted - spent))
        ),
      ),
      progressBar(spent, budgeted)
    ),
    babyStepCard(babyStep),
    debtSummaryCard(),
  ));
}

function dashSyncLabel() {
  if (!isCloudConfigured()) return 'Cloud: off';
  const { status, lastSyncedAt } = getSyncStatus();
  if (status === 'syncing') return 'Syncing…';
  if (status === 'error') return 'Sync error · Tap';
  if (lastSyncedAt) {
    const mins = Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 60000);
    if (mins < 1) return 'Synced just now';
    if (mins < 60) return `Synced ${mins}m ago`;
    return `Synced ${Math.round(mins / 60)}h ago`;
  }
  return 'Cloud · Tap to sync';
}

function weekAtAGlance(upcomingBills, paychecks) {
  const today = todayISO();
  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const end = formatLocalISODate(in7);

  const payItems = [];
  (paychecks || []).forEach(p => {
    (p.checks || []).forEach(c => {
      if (!c.date || c.date < today || c.date > end) return;
      if (c.status === 'received') return;
      payItems.push({
        kind: 'pay',
        date: c.date,
        label: p.name,
        amount: c.amount || c.receivedAmount || 0,
        status: c.status,
      });
    });
  });
  payItems.sort((a, b) => a.date.localeCompare(b.date));

  const billItems = (upcomingBills || []).slice(0, 6).map(b => ({
    kind: 'bill',
    date: b.dueDate,
    label: b.name,
    amount: b.amount,
    daysLeft: b.daysLeft,
  }));

  if (!payItems.length && !billItems.length) {
    return el('div', { className: 'section' },
      el('div', { className: 'section-title' }, 'This week'),
      el('div', { className: 'card' },
        el('p', { style: 'color:var(--text-muted);font-size:0.9rem;margin:0' },
          'No bills due or paychecks scheduled in the next 7 days.',
        ),
      ),
    );
  }

  return el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'This week at a glance'),
    el('div', { className: 'grid grid-2 week-glance' },
      el('div', { className: 'card' },
        el('div', { className: 'card-title' }, 'Bills due'),
        billItems.length
          ? el('div', { className: 'week-glance-list' },
            ...billItems.map(b => el('button', {
              type: 'button',
              className: 'week-glance-row',
              onClick: () => window.appNavigate('bills'),
            },
              el('span', {}, formatDate(b.date)),
              el('span', { className: 'week-glance-label' }, b.label),
              el('strong', {}, formatCurrency(b.amount)),
            )),
          )
          : el('p', { className: 'week-glance-empty' }, 'None in the next 7 days'),
      ),
      el('div', { className: 'card' },
        el('div', { className: 'card-title' }, 'Paychecks expected'),
        payItems.length
          ? el('div', { className: 'week-glance-list' },
            ...payItems.slice(0, 6).map(p => el('button', {
              type: 'button',
              className: 'week-glance-row',
              onClick: () => window.appNavigate('income'),
            },
              el('span', {}, formatDate(p.date)),
              el('span', { className: 'week-glance-label' }, p.label),
              el('strong', {}, formatCurrency(p.amount)),
            )),
          )
          : el('p', { className: 'week-glance-empty' }, 'None scheduled this week'),
      ),
    ),
  );
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

/**
 * Always-on cash path: checking → after snowball → after bills → after next pay.
 */
function cashRunwayCard(runway, target, onSnowball) {
  const afterBillsTone = runway.negative
    ? 'negative'
    : runway.tight
      ? 'warning'
      : 'positive';
  const steps = [
    { label: 'Checking now', value: formatCurrency(runway.checking), tone: 'accent' },
    {
      label: runway.surplus > 0
        ? `After snowball${target ? ` → ${target.name}` : ''}`
        : 'After snowball (none safe)',
      value: formatCurrency(runway.afterSnowball),
      tone: runway.surplus > 0 ? '' : 'muted',
    },
    {
      label: runway.billCount
        ? `After ${runway.billCount} bill(s) by ${runway.nextPayDate ? formatDate(runway.nextPayDate) : 'window'}`
        : 'After bills (none held)',
      value: formatCurrency(runway.afterBills),
      tone: afterBillsTone,
    },
  ];
  if (runway.nextPayDate && runway.nextPayAmount > 0) {
    steps.push({
      label: `After pay ${formatDate(runway.nextPayDate)}`,
      value: formatCurrency(runway.afterNextPay),
      tone: 'positive',
    });
  }

  const foot = [];
  if (runway.buffer > 0) {
    foot.push(`${formatCurrency(runway.buffer)} cushion kept after bills (Settings)`);
  }
  if (runway.surplus > 0) {
    foot.push(`Safe to send today ${formatCurrency(runway.surplus)}`);
  }
  if (runway.capped && runway.heldBack > 0.02) {
    foot.push(`${formatCurrency(runway.heldBack)} held back from budget leftover`);
  }

  return el('div', { className: 'section card cash-runway-card' },
    el('div', { className: 'cash-runway-header' },
      el('div', {},
        el('div', { className: 'card-title' }, 'Cash runway (if you snowball today)'),
        el('p', { className: 'tx-form-hint', style: 'margin:0.25rem 0 0' },
          'Uses cash free today, not the month-end forecast. Envelopes are labels, not separate piles.',
        ),
      ),
      runway.surplus > 0
        ? el('button', {
          type: 'button',
          className: 'btn btn-sm btn-primary',
          onClick: onSnowball,
        }, 'Snowball $')
        : null,
    ),
    el('div', { className: 'cash-runway-steps' },
      ...steps.map((s, i) => el('div', { className: 'cash-runway-step' },
        el('div', { className: 'cash-runway-step-num' }, String(i + 1)),
        el('div', { className: 'cash-runway-step-body' },
          el('div', { className: 'cash-runway-step-label' }, s.label),
          el('div', { className: `cash-runway-step-value ${s.tone || ''}` }, s.value),
        ),
      )),
    ),
    foot.length
      ? el('p', { className: 'tx-form-hint cash-runway-foot' }, foot.join(' · '))
      : null,
    runway.bills?.length
      ? el('details', { className: 'cash-runway-bills' },
        el('summary', {}, `Bills in window (${runway.bills.length})`),
        el('ul', { className: 'cash-runway-bill-list' },
          ...runway.bills.slice(0, 12).map(b => el('li', {},
            `${b.name}: ${formatCurrency(b.amount)}`
            + (b.dueDate ? ` · ${formatDate(b.dueDate)}` : ' · no due date'),
          )),
        ),
      )
      : null,
  );
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
  const snowball = store.getSnowballDebts();
  const paused = store.getPausedDebts();

  let line = 'Debt free! 🎉';
  if (snowball.length) {
    line = `${snowball.length} in snowball · ~${months} mo ETA`;
    if (paused.length) line += ` · ${paused.length} on hold`;
  } else if (paused.length) {
    line = `${paused.length} on hold · no active snowball target`;
  }

  return el('div', { className: 'card' },
    el('div', { className: 'card-title' }, 'Debt Snowball'),
    el('div', { className: 'card-value', style: 'font-size:1.4rem' }, formatCurrency(total)),
    el('p', { style: 'font-size:0.8rem;color:var(--text-muted);margin-top:0.25rem' }, line)
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
  const modal = showModal({
    title: isChecking ? 'Update Checking Balance' : 'Update Emergency Fund',
    body: el('div', { className: 'form-group' }, el('label', {}, 'Current Balance'), input),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        store.update(s => {
          if (isChecking) s.balances.checking = Number(input.value);
          else s.balances.emergencyFund = Number(input.value);
        });
        modal.close();
        showToast('Balance updated!');
      },
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

  const card = el('div', { className: 'card' },
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
  );

  if (!recon.matched && recon.candidates?.length) {
    card.appendChild(renderReconciliationMatches(recon.candidates, { compact: true, limit: 2 }));
  }

  card.appendChild(el('button', {
    className: 'btn btn-sm btn-primary',
    onClick: () => openReconciliationDialog(recon),
  }, recon.bankBalance == null ? 'Reconcile' : 'Update'));

  return card;
}

function renderReconciliationMatches(candidates, { compact = false, limit = 5 } = {}) {
  const shown = candidates.slice(0, limit);
  const anyExact = shown.some(c => c.exact !== false && !c.nearMiss);
  return el('div', { className: `reconcile-matches${compact ? ' reconcile-matches-compact' : ''}` },
    el('div', { className: 'reconcile-matches-title' },
      anyExact ? 'Possible explanations' : 'Closest transactions (no exact gap match)',
    ),
    el('p', { className: 'reconcile-matches-note' },
      anyExact
        ? 'Logged transactions whose checking impact matches the gap — often a double-post, wrong amount, or bank not posted yet.'
        : 'Nothing in your log nets exactly to this gap. Showing nearest amounts — or the gap may be a bank fee / missing deposit not in the app yet.',
    ),
    ...shown.map((candidate, idx) => renderReconciliationCandidate(candidate, idx)),
    candidates.length > shown.length
      ? el('div', { className: 'reconcile-matches-more' },
        `+ ${candidates.length - shown.length} more`
      )
      : null,
  );
}

function renderReconciliationCandidate(candidate, idx) {
  const lines = formatCandidateSummary(candidate);
  const gapLabel = candidate.nearMiss
    ? `${formatCurrency(candidate.gapMatch)} (${formatCurrency(candidate.amtDist || 0)} off)`
    : formatCurrency(candidate.gapMatch ?? candidate.totalAmount);
  return el('div', { className: `reconcile-candidate${candidate.nearMiss ? ' reconcile-candidate-near' : ''}` },
    el('div', { className: 'reconcile-candidate-head' },
      el('span', { className: 'reconcile-candidate-label' },
        candidate.nearMiss ? `Near ${idx + 1}` : `Match ${idx + 1}`,
      ),
      el('span', { className: 'reconcile-candidate-total', title: 'Amount vs gap' }, gapLabel),
    ),
    el('p', { className: 'reconcile-candidate-hint' }, candidate.hint),
    el('ul', { className: 'reconcile-candidate-list' },
      ...lines.map(line => el('li', {}, line)),
    ),
    el('button', {
      className: 'btn btn-sm btn-secondary',
      onClick: () => window.appNavigate('transactions'),
    }, 'Review in Transactions'),
  );
}

function openReconciliationDialog(recon) {
  // Always open with "as of today" — re-entering a bank balance means a fresh check
  const today = todayISO();
  const input = el('input', { type: 'number', step: '0.01', value: recon.bankBalance ?? recon.logged });
  const dateIn = el('input', { type: 'date', value: today });
  const gapPreview = el('p', { className: 'reconcile-gap-preview' });
  const matchesHost = el('div', {});

  function refreshGapPreview() {
    const bank = Number(input.value);
    if (Number.isNaN(bank)) {
      gapPreview.textContent = '';
      matchesHost.replaceChildren();
      return;
    }
    const gap = Math.round((bank - recon.logged) * 100) / 100;
    if (Math.abs(gap) < 0.02) {
      gapPreview.textContent = 'Balances match.';
      gapPreview.style.color = 'var(--positive)';
      matchesHost.replaceChildren();
      return;
    }
    gapPreview.textContent = `Gap: ${formatCurrency(Math.abs(gap))} ${gap > 0 ? 'higher' : 'lower'} than logged`;
    gapPreview.style.color = 'var(--negative)';

    const candidates = store.findReconciliationCandidates(gap, dateIn.value || todayISO());
    matchesHost.replaceChildren(
      candidates.length
        ? renderReconciliationMatches(candidates, { limit: 5 })
        : el('div', { className: 'reconcile-matches-empty' },
          el('p', {}, 'No matching transactions in the last 90 days that affect checking.'),
          el('p', { className: 'tx-form-hint', style: 'margin-top:0.35rem' },
            gap > 0
              ? 'Bank is higher — often a deposit not imported yet, or a fee/refund only on the bank side.'
              : 'Bank is lower — often a purchase not imported yet, or a duplicate income entry in the app.',
          ),
        ),
    );
  }

  // Changing the bank amount always stamps "as of" to today (you can still edit the date after)
  input.addEventListener('input', () => {
    dateIn.value = todayISO();
    refreshGapPreview();
  });
  dateIn.addEventListener('change', refreshGapPreview);
  refreshGapPreview();

const reconModal = showModal({
    title: 'Reconcile Checking',
    body: el('div', {},
      el('p', { style: 'margin-bottom:1rem;color:var(--text-muted);font-size:0.9rem' },
        'Enter the balance shown in your bank app. As-of date defaults to today when you update the amount. We scan recent transactions for combinations that explain any gap.'
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Bank balance'), input),
      el('div', { className: 'form-group' },
        el('label', {}, 'As of date'),
        dateIn,
        el('p', { className: 'tx-form-hint', style: 'margin-top:0.35rem;margin-bottom:0' },
          'Resets to today whenever you change the bank balance.',
        ),
      ),
      el('p', { style: 'font-size:0.85rem;margin-bottom:0.5rem' }, `Logged checking: ${formatCurrency(recon.logged)}`),
      gapPreview,
      matchesHost,
    ),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        store.setReconciliation(Number(input.value), dateIn.value || todayISO());
        reconModal.close();
        showToast('Reconciliation saved');
      },
    }, 'Save'),
  });
}

/** Shared with Advisor — open the snowball surplus allocation modal. */
export function allocateSurplus() {
  const forecast = store.getMonthEndSnowballForecast();
  const surplus = forecast.safe; // month-end target
  const todayMax = store.getBankSurplusForSnowball(); // can send now
  const cap = store.getSurplusCapInfo();
  const target = store.getSnowballTarget();
  if (!target) {
    showToast('No active debts in your snowball!', 'info');
    return;
  }
  if (surplus <= 0 && todayMax <= 0) {
    showToast(
      'Month-end snowball forecast is $0 with current income left, bills, and envelope plan. Update Income calendar or lower envelope budgets if that looks wrong.',
      'info',
      7000,
    );
    return;
  }

  // Prefill: what you can send today, or the forecast if today is already free enough
  const prefill = Math.min(
    surplus > 0 ? surplus : todayMax,
    todayMax > 0 ? todayMax : surplus,
  );
  const input = el('input', {
    type: 'number',
    step: '0.01',
    value: String(Math.round((prefill || 0) * 100) / 100),
    min: 0,
  });
  const preview = el('div', { className: 'snowball-runway-preview tx-form-hint' });

  function paintPreview() {
    const amt = Number(input.value) || 0;
    const r = store.getCashRunway(amt);
    preview.innerHTML = '';
    preview.appendChild(el('div', {},
      `If you send ${formatCurrency(amt)} *today* → checking ${formatCurrency(r.afterSnowball)}`
      + ` → after bills ${formatCurrency(r.afterBills)}`
      + (r.buffer > 0 ? ` (cushion target ${formatCurrency(r.buffer)})` : '')
      + (r.nextPayDate && r.nextPayAmount
        ? ` → after ${formatDate(r.nextPayDate)} pay ~${formatCurrency(r.afterNextPay)}`
        : ''),
    ));
    if (amt > todayMax + 0.02) {
      preview.appendChild(el('div', { style: 'color:var(--negative);margin-top:0.35rem' },
        `Only ${formatCurrency(todayMax)} is free in checking today (month-end forecast is ${formatCurrency(surplus)}). Wait for paychecks or send less now.`,
      ));
    } else if (r.negative) {
      preview.appendChild(el('div', { style: 'color:var(--negative);margin-top:0.35rem' },
        'That amount would leave checking short of bills before next pay.',
      ));
    } else if (r.tight) {
      preview.appendChild(el('div', { style: 'color:var(--warning, #b45309);margin-top:0.35rem' },
        'Tight: near the cushion floor until next deposit.',
      ));
    }
  }
  input.addEventListener('input', paintPreview);
  paintPreview();

  const modal = showModal({
    title: 'Snowball extra to debt',
    body: el('div', {},
      el('p', { style: 'margin-bottom:1rem' }, `Send extra money to ${target.name}`),
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        'Month-end forecast assumes remaining income lands and you still cover unpaid bills + the envelope plan. '
        + 'Sending money *today* is limited by cash free after bills before next pay.',
      ),
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        `Month-end forecast: ${formatCurrency(surplus)}`
        + ` · Safe to send today: ${formatCurrency(todayMax)}`
        + ` · Income left: ${formatCurrency(forecast.incomeLeft || 0)}`
        + ` · Bills still due: ${formatCurrency(forecast.billsLeft || 0)}`
        + ` · Envelope plan left: ${formatCurrency(forecast.envelopeLeft || 0)}`
        + ` · Cushion: ${formatCurrency(forecast.buffer || 0)}`,
      ),
      el('div', { className: 'form-group' }, el('label', {}, 'Amount to send now'), input),
      preview,
    ),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        const amt = Number(input.value);
        if (!(amt > 0)) {
          showToast('Enter an amount', 'info');
          return;
        }
        if (amt > todayMax + 0.02) {
          showToast(
            `Only ${formatCurrency(todayMax)} is free today. Month-end forecast is ${formatCurrency(surplus)} — wait for income or pay less now.`,
            'info',
            6000,
          );
          return;
        }
        const r = store.getCashRunway(amt);
        if (r.negative) {
          showToast('That would leave checking short of bills before next pay', 'info');
          return;
        }
        let confirmMsg = `Send ${formatCurrency(amt)} to ${target.name}?\n\n`
          + `Checking after snowball: ${formatCurrency(r.afterSnowball)}\n`
          + `After bills by ${r.nextPayDate ? formatDate(r.nextPayDate) : 'window'}: ${formatCurrency(r.afterBills)}`;
        if (r.nextPayAmount) {
          confirmMsg += `\nAfter next pay (~${formatCurrency(r.nextPayAmount)}): ~${formatCurrency(r.afterNextPay)}`;
        }
        if (r.tight) confirmMsg += '\n\nThis is tight until the next deposit.';
        confirmDialog('Confirm snowball payment', confirmMsg, () => {
          const result = store.allocateSurplusToDebt(amt);
          modal.close();
          if (result) {
            showUndoToast(
              `Allocated ${formatCurrency(result.pay || amt)} to ${result.name}`,
              () => {
                const u = store.undoLastAction();
                if (u.ok) {
                  showToast('Snowball payment undone', 'info');
                  window.appRefresh();
                } else {
                  showToast('Undo expired', 'info');
                }
              },
            );
            window.appRefresh();
          }
        });
      },
    }, 'Review & allocate'),
  });
}