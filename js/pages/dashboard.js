import { el, formatCurrency, formatDate, getCurrentMonth, getMonthLabel, todayISO } from '../utils.js';
import { formatCandidateSummary } from '../reconcile-match.js';
import { store } from '../store.js';
import { BABY_STEPS } from '../defaults.js';
import { showModal, showToast } from '../components/modal.js';
import { renderReviewBanner, openPendingReview, openReviewInbox } from '../components/review-inbox.js';
import { openMonthCloseWizard } from '../components/month-close.js';
import { openEnvelopeActivity } from './budget.js';
import { getSyncStatus, isCloudConfigured } from '../cloud-sync.js';
import { refreshSyncChip } from '../components/layout.js';

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

  const reviewBanner = renderReviewBanner(inbox);
  if (reviewBanner) container.appendChild(reviewBanner);

  const overCapEnvelopes = store.getEnvelopesOverSoftCap();
  const toAllocate = store.getToAllocate();
  const daveMode = store.isDaveRamseyMode();
  const toAllocateOff = Math.abs(toAllocate) >= 0.01;

  if (daveMode && toAllocateOff) {
    container.appendChild(el('div', { className: 'banner banner-warning section' },
      el('div', { className: 'banner-icon' }, '📊'),
      el('div', { className: 'banner-text' },
        el('h3', {}, toAllocate > 0
          ? `${formatCurrency(toAllocate)} still needs a job`
          : `Over-assigned by ${formatCurrency(Math.abs(toAllocate))}`),
        el('p', {}, toAllocate > 0
          ? 'Dave Ramsey mode: give every dollar a job until To Allocate is $0.'
          : 'Dave Ramsey mode: you budgeted more than planned income — trim envelopes or fix the pay calendar.'),
      ),
      el('button', {
        className: 'btn btn-secondary btn-sm',
        style: 'margin-left:auto;align-self:center',
        onClick: () => window.appNavigate('budget'),
      }, 'Open Budget'),
    ));
  }

  if (pendingCount > 0 || inbox.uncategorized.length > 0 || overCapEnvelopes.length > 0) {
    container.appendChild(el('div', { className: 'chip-bar section dash-alert-chips' },
      pendingCount > 0 ? el('button', {
        type: 'button',
        className: 'chip chip-warn',
        onClick: () => openPendingReview(),
      }, `⏳ ${pendingCount} awaiting bank`) : null,
      inbox.uncategorized.length > 0 ? el('button', {
        type: 'button',
        className: 'chip chip-warn',
        onClick: () => openReviewInbox(),
      }, `🏷️ ${inbox.uncategorized.length} need categories`) : null,
      overCapEnvelopes.length > 0 ? el('button', {
        type: 'button',
        className: 'chip chip-warn',
        onClick: () => window.appNavigate('budget', { filter: 'attention' }),
      }, `🎯 ${overCapEnvelopes.length} over cap/goal`) : null,
    ));
  }

  const dayOfMonth = new Date().getDate();
  if (dayOfMonth <= 7) {
    container.appendChild(el('div', { className: 'banner banner-action section' },
      el('div', { className: 'banner-icon' }, '📅'),
      el('div', { className: 'banner-text' },
        el('h3', {}, 'New month checklist'),
        el('p', {},
          'Envelope budgets stay until you change them. Review kids’ envelopes, To Allocate, and optionally copy last month’s plan from Budget tools.',
        ),
      ),
      el('button', {
        className: 'btn btn-secondary btn-sm',
        style: 'margin-left:auto;align-self:center',
        onClick: () => window.appNavigate('budget'),
      }, 'Open Budget'),
    ));
  }

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

  container.appendChild(el('div', { className: 'quick-actions' },
    quickAction('📝', 'Log Expense', () => window.appNavigate('transactions', 'expense')),
    quickAction('📥', 'Review Inbox', () => openReviewInbox()),
    quickAction('💸', 'Allocate Surplus', () => allocateSurplus()),
    quickAction('✉️', 'Allocate', () => window.appNavigate('budget')),
  ));

  container.appendChild(weekAtAGlance(upcoming, paychecks));

  const lastBackup = state.settings.lastBackupAt;
  if (lastBackup) {
    const days = Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000);
    if (days >= 30) {
      container.appendChild(el('div', { className: 'banner banner-warning section' },
        el('div', { className: 'banner-icon' }, '💾'),
        el('div', { className: 'banner-text' },
          el('h3', {}, 'Backup is getting old'),
          el('p', {}, `Last JSON backup was ${days} days ago. Settings → Export Backup keeps a safety copy.`),
        ),
        el('button', {
          className: 'btn btn-secondary btn-sm',
          style: 'margin-left:auto;align-self:center',
          onClick: () => window.appNavigate('settings'),
        }, 'Settings'),
      ));
    }
  } else {
    container.appendChild(el('div', { className: 'banner banner-warning section' },
      el('div', { className: 'banner-icon' }, '💾'),
      el('div', { className: 'banner-text' },
        el('h3', {}, 'No backup yet'),
        el('p', {}, 'Export a JSON backup from Settings when you get a chance — cloud sync is great, local backup is belt-and-suspenders.'),
      ),
      el('button', {
        className: 'btn btn-secondary btn-sm',
        style: 'margin-left:auto;align-self:center',
        onClick: () => window.appNavigate('settings'),
      }, 'Settings'),
    ));
  }

  container.appendChild(el('div', { className: 'grid grid-4 dash-stats section' },
    statCard('Checking Balance', formatCurrency(state.balances.checking), 'accent', () => editBalance('checking')),
    statCard('Surplus for Snowball', formatCurrency(surplus), surplus > 0 ? 'positive' : '', null, true, surplusIncomeNote),
    statCard('Emergency Fund', formatCurrency(state.balances.emergencyFund), 'positive', () => editBalance('emergency')),
    statCard(
      'Monthly Income',
      formatCurrency(income),
      '',
      null,
      false,
      bonusLogged > 0 ? `+ ${formatCurrency(bonusLogged)} bonus income allocatable` : null,
    ),
  ));

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
      el('div', { className: 'dash-bills-list' },
        ...upcoming.slice(0, 5).map(b => {
          const tone = b.daysLeft < 0 ? 'overdue' : b.daysLeft <= 3 ? 'due' : 'ok';
          return el('article', {
            className: `dash-bill-row bill-card--${tone}`,
            onClick: () => window.appNavigate('bills'),
          },
            el('div', { className: 'dash-bill-main' },
              el('strong', {}, b.name),
              el('span', { className: 'dash-bill-amount' }, formatCurrency(b.amount)),
            ),
            el('div', { className: 'dash-bill-meta' },
              el('span', {}, b.dueDate || '—'),
              billBadge(b),
            ),
          );
        })
      )
    ));
  }
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
  const end = in7.toISOString().slice(0, 10);

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
  return el('div', { className: `reconcile-matches${compact ? ' reconcile-matches-compact' : ''}` },
    el('div', { className: 'reconcile-matches-title' }, 'Possible explanations'),
    el('p', { className: 'reconcile-matches-note' },
      'Recent transactions that add up to the gap — often a duplicate import or a missing entry.'
    ),
    ...shown.map((candidate, idx) => renderReconciliationCandidate(candidate, idx)),
    candidates.length > shown.length
      ? el('div', { className: 'reconcile-matches-more' },
        `+ ${candidates.length - shown.length} more combination${candidates.length - shown.length === 1 ? '' : 's'}`
      )
      : null,
  );
}

function renderReconciliationCandidate(candidate, idx) {
  const lines = formatCandidateSummary(candidate);
  return el('div', { className: 'reconcile-candidate' },
    el('div', { className: 'reconcile-candidate-head' },
      el('span', { className: 'reconcile-candidate-label' }, `Match ${idx + 1}`),
      el('span', { className: 'reconcile-candidate-total' }, formatCurrency(candidate.totalAmount)),
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
        ? renderReconciliationMatches(candidates, { limit: 4 })
        : el('p', { className: 'reconcile-matches-empty' },
          'No recent transactions add up to this gap. Check for a missing import or manual balance typo.'
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

  showModal({
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
      className: 'btn btn-primary',
      onClick: function() {
        store.setReconciliation(Number(input.value), dateIn.value || todayISO());
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