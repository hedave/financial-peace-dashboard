import {
  el, formatCurrency, formatDate, getPreviousMonth, getMonthLabel, getCurrentMonth,
  emptyState, getRecentMonths, addMonths, todayISO,
} from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';
import { createEnvelopePicker } from '../components/envelope-picker.js';
import { openTransactionForm } from './transactions.js';

const SORT_OPTIONS = [
  { key: 'budgeted', dir: 'desc', label: 'Budgeted (high to low)' },
  { key: 'budgeted', dir: 'asc', label: 'Budgeted (low to high)' },
  { key: 'spent', dir: 'desc', label: 'Spent (high to low)' },
  { key: 'remaining', dir: 'desc', label: 'Remaining (high to low)' },
  { key: 'name', dir: 'asc', label: 'Name (A to Z)' },
  { key: 'name', dir: 'desc', label: 'Name (Z to A)' },
];

/** Survives modal close / soft appRefresh so sort doesn’t snap back mid-session. */
let budgetSortKey = 'budgeted';
let budgetSortDir = 'desc';
let budgetViewFilter = 'all';
/** Which month’s envelopes are on screen (YYYY-MM). */
let budgetViewMonth = getCurrentMonth();

function sortOptionValue(key, dir) {
  return `${key}:${dir}`;
}

function parseSortValue(value) {
  const [key, dir] = value.split(':');
  return { key, dir };
}

function sortCategories(cats, sortKey, sortDir, month) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...cats].sort((a, b) => {
    let va;
    let vb;
    switch (sortKey) {
      case 'spent':
        va = store.getCategorySpent(a.id, month);
        vb = store.getCategorySpent(b.id, month);
        break;
      case 'remaining':
        va = store.getCategoryRemaining(a.id, month);
        vb = store.getCategoryRemaining(b.id, month);
        break;
      case 'name':
        va = a.name.toLowerCase();
        vb = b.name.toLowerCase();
        break;
      case 'budgeted':
      default:
        va = store.getCategoryBudgeted(a.id, month);
        vb = store.getCategoryBudgeted(b.id, month);
        break;
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name);
  });
}

export function renderBudget(container, arg) {
  const state = store.getState();
  const liveMonth = getCurrentMonth();
  // Keep view month valid; snap forward if calendar rolled
  if (!budgetViewMonth || budgetViewMonth > liveMonth) budgetViewMonth = liveMonth;
  if (arg?.month) budgetViewMonth = arg.month;

  const month = budgetViewMonth;
  const isCurrentMonth = month === liveMonth;
  const overspendShare = store.getOverspendShare(month);
  const showOverspendShare = isCurrentMonth
    && !!store.getState().settings?.showOverspendShare
    && overspendShare.overspendTotal > 0.005;
  const coverIouSummary = store.getCoverIouSummary();
  const income = store.getTotalIncome(month);
  const bonusLogged = store.getBonusIncomeLogged(month);
  const bonusGross = store.getBonusIncomeGross(month);
  const bonusUsed = store.getBonusAllocated(month);
  const bonusAvailable = store.getBonusAvailable(month);
  const budgeted = store.getTotalBudgeted(month);
  const unallocated = store.getUnallocatedFunds(month);
  const focusId = arg?.focusId || arg?.categoryId || null;
  // Deep-link filters win for this visit; otherwise keep last UI choice (e.g. after activity modal refresh)
  let viewFilter = (arg && arg.filter === 'attention')
    ? 'attention'
    : (budgetViewFilter || 'all');
  // Focusing a specific envelope: show all so the card is visible
  if (focusId) viewFilter = 'all';

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Envelope Budget'),
    el('p', {}, isCurrentMonth
      ? 'Zero-based budgeting — every dollar has a job · Tap an envelope to see spending'
      : `Viewing ${getMonthLabel(month)} — spending uses each transaction’s date (edit the date to move a late post back)`),
  ));

  // Month switcher
  const monthOptions = getRecentMonths(8, liveMonth);
  const monthSelect = el('select', {
    className: 'budget-month-select',
    onChange: (e) => {
      budgetViewMonth = e.target.value;
      window.appRefresh();
    },
  },
    ...monthOptions.map(m => el('option', {
      value: m,
      selected: m === month ? true : undefined,
    }, getMonthLabel(m) + (m === liveMonth ? ' (current)' : ''))),
  );
  if (monthSelect.value !== month) monthSelect.value = month;

  container.appendChild(el('div', { className: 'toolbar section budget-month-bar' },
    el('button', {
      type: 'button',
      className: 'btn btn-sm btn-secondary',
      disabled: monthOptions[0] === month ? true : undefined,
      onClick: () => {
        budgetViewMonth = addMonths(month, -1);
        window.appRefresh();
      },
    }, '← Prev'),
    el('label', { style: 'font-size:0.85rem;font-weight:600;display:flex;align-items:center;gap:0.5rem' },
      'Month',
      monthSelect,
    ),
    el('button', {
      type: 'button',
      className: 'btn btn-sm btn-secondary',
      disabled: month >= liveMonth ? true : undefined,
      onClick: () => {
        budgetViewMonth = addMonths(month, 1);
        if (budgetViewMonth > liveMonth) budgetViewMonth = liveMonth;
        window.appRefresh();
      },
    }, 'Next →'),
    !isCurrentMonth
      ? el('button', {
        type: 'button',
        className: 'btn btn-sm btn-primary',
        onClick: () => {
          budgetViewMonth = liveMonth;
          window.appRefresh();
        },
      }, 'Jump to current')
      : null,
  ));

  if (!isCurrentMonth && !store.hasMonthBudgetSnapshot(month)) {
    container.appendChild(el('p', {
      className: 'tx-form-hint section',
      style: 'margin-top:0',
    }, `No saved budget snapshot for ${getMonthLabel(month)} — budgeted amounts fall back to today’s plan. Spending still uses transactions dated in that month.`));
  }

  const allocatable = store.getAllocatableIncome(month);
  const checkingNow = Number(store.getState().balances?.checking) || 0;

  container.appendChild(el('div', { className: `grid ${isCurrentMonth ? 'grid-4' : 'grid-3'} section` },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, `Monthly Income — ${getMonthLabel(month)}`),
      el('div', { className: 'card-value accent' }, formatCurrency(allocatable)),
      el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem;line-height:1.4' },
        bonusLogged > 0.005
          ? `Pay calendar ${formatCurrency(income)} + bonus still free ${formatCurrency(bonusLogged)}`
          : 'From pay-calendar dates & amounts (not checking balance)',
      ),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Total Budgeted'),
      el('div', { className: 'card-value' }, formatCurrency(budgeted)),
      el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem' },
        isCurrentMonth ? 'Sum of envelope monthly budgets' : 'From snapshot or current plan',
      ),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'To Allocate'),
      el('div', { className: `card-value ${unallocated === 0 ? 'positive' : unallocated > 0 ? 'accent' : 'negative'}` },
        formatCurrency(unallocated)
      ),
      el('p', {
        style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem;line-height:1.45',
      },
        `${formatCurrency(allocatable)} income − ${formatCurrency(budgeted)} budgeted`,
      ),
      unallocated === 0
        ? el('p', { style: 'font-size:0.75rem;color:var(--positive)' }, '✓ Zero-based budget!')
        : el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.2rem;line-height:1.4' },
          unallocated > 0
            ? 'Still needs a job — assign to envelopes'
            : isCurrentMonth
              ? `Over by ${formatCurrency(Math.abs(unallocated))} — lower some budgets. Checking (${formatCurrency(checkingNow)}) is cash on hand, not part of this formula.`
              : `Over by ${formatCurrency(Math.abs(unallocated))} for this month’s plan.`,
        ),
    ),
    isCurrentMonth
      ? el('div', { className: 'card' },
        el('div', { className: 'card-title' }, 'Bonus available'),
        el('div', {
          className: `card-value ${bonusAvailable > 0.005 ? 'accent' : ''}`,
        }, formatCurrency(bonusAvailable)),
        el('p', {
          style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem;line-height:1.4',
        },
          bonusGross > 0.005
            ? `${formatCurrency(bonusGross)} bonus in · ${formatCurrency(bonusUsed)} sent to envelopes`
            : 'Refunds and extra deposits land here — Assign bonus on any envelope',
          coverIouSummary.total > 0.005
            ? ` · ${formatCurrency(coverIouSummary.total)} still owed back to envelopes that covered overspend`
            : '',
        ),
      )
      : null,
  ));

  const carryTotal = isCurrentMonth
    ? (store.getState().categories || [])
      .filter(c => !c.parentId)
      .reduce((s, c) => s + (Number(c.carryOver) || 0), 0)
    : 0;
  if (isCurrentMonth && Math.abs(carryTotal) > 0.005) {
    const carryCount = (store.getState().categories || [])
      .filter(c => !c.parentId && Math.abs(Number(c.carryOver) || 0) > 0.005).length;
    container.appendChild(el('p', {
      className: 'tx-form-hint section',
      style: 'margin-top:0',
    }, `Carry-over from last month: ${formatCurrency(carryTotal)} across ${carryCount} envelope${carryCount === 1 ? '' : 's'}. That leftover is already in Remaining — To Allocate is only new income minus this month’s plan. Use Move to shift leftover this month; Allocate changes the ongoing plan.`));
  }

  if (isCurrentMonth && overspendShare.overspendTotal > 0.005) {
    const names = overspendShare.overspent
      .slice(0, 3)
      .map(o => o.name)
      .join(', ');
    const extra = overspendShare.overspent.length > 3
      ? ` +${overspendShare.overspent.length - 3} more`
      : '';
    const shareOn = !!store.getState().settings?.showOverspendShare;
    const sinkHit = overspendShare.sinkingTakeTotal > 0.005
      ? ` Sinking funds would absorb ${formatCurrency(overspendShare.sinkingTakeTotal)} of that if leftover were shared.`
      : '';
    const billHit = overspendShare.protectedCount
      ? ` Mapped bills/debts (${overspendShare.protectedNames.slice(0, 3).join(', ')}${overspendShare.protectedCount > 3 ? '…' : ''}) stay out of the share.`
      : '';
    container.appendChild(el('div', { className: 'banner banner-warning section overspend-share-banner' },
      el('div', { className: 'banner-icon' }, '📉'),
      el('div', { className: 'banner-text' },
        el('h3', {}, `${formatCurrency(overspendShare.overspendTotal)} overspent — same cash as leftover`),
        el('p', {},
          `${names}${extra} went past their envelope. That money already left checking, so leftover on flexible envelopes is on paper until you cover it.${sinkHit}${billHit}`,
        ),
      ),
      el('div', { className: 'btn-group', style: 'margin-left:auto' },
        el('button', {
          type: 'button',
          className: `btn btn-sm ${shareOn ? 'btn-primary' : 'btn-secondary'}`,
          onClick: () => {
            store.update(s => { s.settings.showOverspendShare = !shareOn; });
            window.appRefresh();
          },
        }, shareOn ? 'Hide share' : 'Show share'),
        store.canWriteBudget()
          ? el('button', {
            type: 'button',
            className: 'btn btn-sm btn-secondary',
            onClick: () => openCoverOverspend(month),
          }, 'Cover overspend')
          : null,
      ),
    ));
  }

  const holdReserve = isCurrentMonth ? store.getUpcomingHoldReserve({ mode: 'today' }) : 0;
  const activeHolds = isCurrentMonth ? store.getActiveUpcomingHolds() : [];
  if (isCurrentMonth && holdReserve > 0.005) {
    const names = activeHolds.slice(0, 2).map(h => {
      const cat = state.categories.find(c => c.id === h.categoryId);
      return h.description || cat?.name || formatDate(h.date);
    }).join(', ');
    const extra = activeHolds.length > 2 ? ` +${activeHolds.length - 2}` : '';
    container.appendChild(el('div', { className: 'banner banner-action section' },
      el('div', { className: 'banner-icon' }, '📌'),
      el('div', { className: 'banner-text' },
        el('h3', {}, `${formatCurrency(holdReserve)} held out of snowball`),
        el('p', {},
          `${names}${extra}. Checking is unchanged. To Allocate is unchanged. Safe-to-send and the month-end forecast drop until you spend it or dismiss the hold.`,
        ),
      ),
      store.canWriteBudget()
        ? el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          style: 'margin-left:auto',
          onClick: () => openUpcomingHolds(),
        }, 'Edit holds')
        : null,
    ));
  }

  if (isCurrentMonth && coverIouSummary.total > 0.005) {
    const names = coverIouSummary.donors.slice(0, 3).map(d => d.name).join(', ');
    const extra = coverIouSummary.donors.length > 3 ? ` +${coverIouSummary.donors.length - 3}` : '';
    const sinkBit = coverIouSummary.sinkingTotal > 0.005
      ? ` ${formatCurrency(coverIouSummary.sinkingTotal)} of that is sinking funds.`
      : '';
    container.appendChild(el('div', { className: 'banner banner-action section' },
      el('div', { className: 'banner-icon' }, '↩️'),
      el('div', { className: 'banner-text' },
        el('h3', {}, `${formatCurrency(coverIouSummary.total)} to restore from bonus`),
        el('p', {},
          `Cover overspend borrowed leftover from ${names}${extra}.${sinkBit} `
          + (bonusAvailable > 0.005
            ? `${formatCurrency(bonusAvailable)} bonus is free to put back.`
            : 'When bonus or refunds land, repay those envelopes first.'),
        ),
      ),
      store.canWriteBudget() && bonusAvailable > 0.005
        ? el('button', {
          type: 'button',
          className: 'btn btn-sm btn-primary',
          style: 'margin-left:auto',
          onClick: () => openRepayCoverFromBonus(month),
        }, 'Repay from bonus')
        : null,
    ));
  }

  const prevMonth = getPreviousMonth(liveMonth);
  const hasSnapshot = !!store.getState().monthBudgetSnapshots[prevMonth];

  const toolsMenu = el('details', { className: 'page-tools-menu' });
  toolsMenu.appendChild(el('summary', { className: 'btn btn-secondary' }, 'Budget tools'));
  const toolsList = el('div', { className: 'page-tools-dropdown' });
  toolsList.appendChild(el('button', {
    type: 'button',
    className: 'page-tools-item',
    onClick: () => { toolsMenu.removeAttribute('open'); addCategory(true); },
  }, '+ Add Sinking Fund'));
  toolsList.appendChild(el('button', {
    type: 'button',
    className: 'page-tools-item',
    onClick: () => { toolsMenu.removeAttribute('open'); openMoveBetweenEnvelopes(); },
  }, 'Move between envelopes'));
  if (store.canWriteBudget()) {
    toolsList.appendChild(el('button', {
      type: 'button',
      className: 'page-tools-item',
      onClick: () => { toolsMenu.removeAttribute('open'); openUpcomingHolds(); },
    }, 'Upcoming hold'));
  }
  if (isCurrentMonth && store.getOverspendShare(month).overspendTotal > 0.005 && store.canWriteBudget()) {
    toolsList.appendChild(el('button', {
      type: 'button',
      className: 'page-tools-item',
      onClick: () => { toolsMenu.removeAttribute('open'); openCoverOverspend(month); },
    }, 'Cover overspend'));
  }
  if (isCurrentMonth && coverIouSummary.total > 0.005 && store.canWriteBudget()) {
    toolsList.appendChild(el('button', {
      type: 'button',
      className: 'page-tools-item',
      onClick: () => { toolsMenu.removeAttribute('open'); openRepayCoverFromBonus(month); },
    }, 'Repay cover from bonus'));
  }
  const negCarryCount = store.countNegativeCarryOvers();
  if (negCarryCount > 0) {
    toolsList.appendChild(el('button', {
      type: 'button',
      className: 'page-tools-item',
      onClick: () => { toolsMenu.removeAttribute('open'); clearAllNegativeCarry(); },
    }, `Clear negative carry (${negCarryCount})`));
  }
  if (hasSnapshot) {
    toolsList.appendChild(el('button', {
      type: 'button',
      className: 'page-tools-item',
      onClick: () => {
        toolsMenu.removeAttribute('open');
        confirmDialog(
          'Copy Last Month\'s Budget',
          `Replace current envelope amounts with ${getMonthLabel(prevMonth)}?`,
          () => {
            if (store.copyBudgetFromMonth(prevMonth)) {
              showToast('Budget copied from last month!');
              window.appRefresh();
            }
          },
        );
      },
    }, 'Copy Last Month'));
  }
  toolsMenu.appendChild(toolsList);

  if (isCurrentMonth) {
    container.appendChild(el('div', { className: 'btn-group section budget-actions' },
      el('button', { className: 'btn btn-primary', onClick: () => addCategory(false) }, '+ Add Category'),
      store.canWriteBudget()
        ? el('button', {
          className: 'btn btn-secondary',
          onClick: () => openUpcomingHolds(),
          title: 'Hold a known future spend out of snowball — does not change To Allocate',
        }, 'Upcoming hold')
        : null,
      el('button', { className: 'btn btn-accent budget-action-secondary', onClick: () => addCategory(true) }, '+ Add Sinking Fund'),
      el('button', {
        className: 'btn btn-secondary budget-action-secondary',
        onClick: () => openMoveBetweenEnvelopes(),
        title: 'Shift leftover room this month only — does not change next month’s plan',
      }, 'Move between envelopes'),
      overspendShare.overspendTotal > 0.005 && store.canWriteBudget()
        ? el('button', {
          className: 'btn btn-secondary budget-action-secondary',
          onClick: () => openCoverOverspend(month),
          title: 'Take a percentage of leftover envelopes to cover overspend this month',
        }, 'Cover overspend')
        : null,
      negCarryCount > 0
        ? el('button', {
          className: 'btn btn-secondary budget-action-secondary',
          onClick: clearAllNegativeCarry,
          title: 'Forgive prior-month overspending so envelopes don’t start in the red',
        }, `Clear negative carry (${negCarryCount})`)
        : null,
      hasSnapshot ? el('button', {
        className: 'btn btn-secondary budget-action-secondary',
        onClick: () => {
          confirmDialog(
            'Copy Last Month\'s Budget',
            `Replace current envelope amounts with ${getMonthLabel(prevMonth)}?`,
            () => {
              if (store.copyBudgetFromMonth(prevMonth)) {
                showToast('Budget copied from last month!');
                window.appRefresh();
              }
            },
          );
        },
      }, 'Copy Last Month') : null,
      toolsMenu,
    ));
  } else {
    container.appendChild(el('p', {
      className: 'tx-form-hint section',
      style: 'margin-top:0',
    }, `Viewing ${getMonthLabel(month)} (read-only plan). Late bank posts: open a transaction → edit its date to the purchase month so it hits that month’s envelopes.`));
  }

  let sortKey = budgetSortKey;
  let sortDir = budgetSortDir;

  const sortSelect = el('select', { id: 'env-sort' },
    ...SORT_OPTIONS.map(opt => el('option', {
      value: sortOptionValue(opt.key, opt.dir),
    }, opt.label))
  );
  sortSelect.value = sortOptionValue(sortKey, sortDir);

  const favIds = () => new Set(store.getState().settings?.favoriteCategoryIds || []);
  function isKidsEnvelope(cat) {
    const n = String(cat.name || '').toLowerCase();
    return /kid|child|children|school|sport|activit|allowance|clothes|cloth|college|camp|scout|gift|birthday/.test(n);
  }

  const filterBar = el('div', { className: 'chip-bar section' });
  function renderFilterChips() {
    filterBar.innerHTML = '';
    [
      { id: 'all', label: 'All' },
      { id: 'favorites', label: '★ Favorites' },
      { id: 'kids', label: 'Kids / family' },
      { id: 'attention', label: 'Needs attention' },
    ].forEach(opt => {
      filterBar.appendChild(el('button', {
        type: 'button',
        className: `chip${viewFilter === opt.id ? ' active' : ''}`,
        onClick: () => {
          viewFilter = opt.id;
          budgetViewFilter = opt.id;
          renderFilterChips();
          renderGrid();
        },
      }, opt.label));
    });
    if (isCurrentMonth && overspendShare.overspendTotal > 0.005) {
      const shareOn = !!store.getState().settings?.showOverspendShare;
      filterBar.appendChild(el('button', {
        type: 'button',
        className: `chip${shareOn ? ' active' : ''}`,
        title: 'Show how overspent envelopes take a share of leftover on every other envelope — including sinking funds',
        onClick: () => {
          store.update(s => {
            s.settings.showOverspendShare = !shareOn;
          });
          window.appRefresh();
        },
      }, shareOn ? 'Overspend share on' : 'Overspend share'));
    }
  }
  renderFilterChips();
  container.appendChild(filterBar);

  container.appendChild(el('div', { className: 'toolbar section' },
    el('label', { style: 'font-size:0.85rem;font-weight:600;color:var(--text-muted)' }, 'Sort by'),
    sortSelect,
  ));

  const gridEl = el('div', { className: 'envelope-grid' });
  container.appendChild(gridEl);

  function needsAttention(cat) {
    const health = store.getEnvelopeHealth(cat.id, month);
    // Soft cap is plan-level; only surface for live month
    const overCap = isCurrentMonth && store.isOverSoftCap(cat.id);
    return health === 'over' || health === 'depleted' || health === 'warning' || overCap;
  }

  const cardOptsBase = { month, isCurrentMonth, overspendShare, showOverspendShare };

  function renderGrid() {
    const favorites = favIds();
    let parents = state.categories.filter(c => !c.parentId);
    if (viewFilter === 'attention') parents = parents.filter(needsAttention);
    else if (viewFilter === 'favorites') parents = parents.filter(c => favorites.has(c.id));
    else if (viewFilter === 'kids') parents = parents.filter(isKidsEnvelope);
    let sorted = sortCategories(parents, sortKey, sortDir, month);
    // Favorites first when viewing all
    if (viewFilter === 'all' && favorites.size) {
      sorted = [
        ...sorted.filter(c => favorites.has(c.id)),
        ...sorted.filter(c => !favorites.has(c.id)),
      ];
    }
    // Pin focused envelope to the top when deep-linking from Advisor
    if (focusId) {
      const idx = sorted.findIndex(c => c.id === focusId);
      if (idx > 0) {
        const [hit] = sorted.splice(idx, 1);
        sorted = [hit, ...sorted];
      }
    }
    gridEl.innerHTML = '';
    if (!sorted.length) {
      gridEl.appendChild(emptyState(
        viewFilter === 'favorites' ? '★' : '✓',
        viewFilter === 'attention' ? 'All clear'
          : viewFilter === 'favorites' ? 'No favorites yet'
            : viewFilter === 'kids' ? 'No kids/family envelopes'
              : 'No envelopes',
        viewFilter === 'attention'
          ? 'No envelopes need attention right now.'
          : viewFilter === 'favorites'
            ? 'Tap ★ on an envelope card to pin it here for a family of 7 quick scan.'
            : viewFilter === 'kids'
              ? 'Name envelopes with kid/school/sport/etc. to show them here.'
              : 'Add a category to start budgeting.',
      ));
      return;
    }
    if (viewFilter === 'all' && favorites.size) {
      const favList = sorted.filter(c => favorites.has(c.id));
      const rest = sorted.filter(c => !favorites.has(c.id));
      if (favList.length) {
        gridEl.appendChild(el('div', { className: 'envelope-group-label' }, '★ Favorites'));
        favList.forEach(cat => gridEl.appendChild(envelopeCard(cat, focusId, { ...cardOptsBase, favorite: true })));
      }
      if (rest.length) {
        gridEl.appendChild(el('div', { className: 'envelope-group-label' }, 'All envelopes'));
        rest.forEach(cat => gridEl.appendChild(envelopeCard(cat, focusId, { ...cardOptsBase, favorite: false })));
      }
      return;
    }
    sorted.forEach(cat => gridEl.appendChild(envelopeCard(cat, focusId, { ...cardOptsBase, favorite: favorites.has(cat.id) })));
  }

  sortSelect.addEventListener('change', e => {
    ({ key: sortKey, dir: sortDir } = parseSortValue(e.target.value));
    budgetSortKey = sortKey;
    budgetSortDir = sortDir;
    renderGrid();
  });

  renderGrid();

  if (focusId) {
    requestAnimationFrame(() => {
      const node = gridEl.querySelector(`[data-category-id="${focusId}"]`);
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
}

function linkedItems(cat) {
  const debts = store.getDebtsForCategory(cat.id);
  const bills = store.getBillsForCategory(cat.id);
  const target = store.getSnowballTarget();
  const retired = store.getRetiredDebtForEnvelope(cat.id);
  const remaining = store.getCategoryRemaining(cat.id);
  if (!debts.length && !bills.length && !retired) return null;

  const items = [
    ...debts.map(d => {
      const isTarget = target && d.id === target.id;
      return `❄️ ${d.name} (min ${formatCurrency(d.minPayment)}${isTarget ? ' · current snowball' : ''})`;
    }),
    ...bills.map(b => `📋 ${b.name} (${formatCurrency(b.amount)})`),
  ];

  const paidOffNote = retired && remaining > 0.005 && !debts.length
    ? el('div', { className: 'envelope-linked-hint' },
      `${retired.name} is paid off. Move leftover to the next snowball envelope so extra keeps rolling.`,
    )
    : null;

  if (!items.length && !paidOffNote) return null;

  return el('div', { className: 'envelope-linked' },
    items.length
      ? el('div', {},
        el('span', { className: 'envelope-linked-label' }, 'Linked'),
        ' ',
        items.join(' · '),
      )
      : null,
    paidOffNote,
  );
}

function goalBlock(cat) {
  const progress = store.getGoalProgress(cat.id);
  if (!progress) return null;
  const label = progress.isSinking ? 'Savings goal' : 'Soft cap';
  const over = progress.over;
  return el('div', { className: `envelope-goal${over ? ' over-cap' : ''}` },
    el('div', { className: 'envelope-goal-head' },
      el('span', {}, label),
      el('strong', {},
        over
          ? `${formatCurrency(progress.budgeted)} / ${formatCurrency(progress.goal)} over`
          : `${formatCurrency(progress.pool)} / ${formatCurrency(progress.goal)}`,
      ),
    ),
    el('div', { className: 'progress-bar envelope-goal-bar' },
      el('div', {
        className: 'progress-fill',
        style: `width:${progress.pct}%;${over ? 'background:var(--negative)' : 'background:var(--accent)'}`,
      }),
    ),
    over
      ? el('span', { className: 'envelope-health-badge health-over' }, progress.isSinking ? 'Over goal' : 'Over cap')
      : el('span', { className: 'envelope-goal-pct' }, `${progress.pct}% toward ${progress.isSinking ? 'goal' : 'cap'}`),
  );
}

function toggleFavorite(categoryId) {
  store.update(s => {
    const list = Array.isArray(s.settings.favoriteCategoryIds)
      ? [...s.settings.favoriteCategoryIds]
      : [];
    const i = list.indexOf(categoryId);
    if (i >= 0) list.splice(i, 1);
    else list.push(categoryId);
    s.settings.favoriteCategoryIds = list;
  });
  window.appRefresh();
}

function coverIouLine(cat) {
  const owed = store.getCoverIouOutstandingForEnvelope(cat.id);
  if (!(owed > 0.005)) return null;
  return el('div', {
    className: 'envelope-share-hit sinking',
    title: 'This leftover was used to cover overspend. Bonus can put it back.',
  }, `Owed back ${formatCurrency(owed)} from bonus`);
}

function overspendShareLine(cat, remaining, opts = {}) {
  if (!opts.showOverspendShare || !opts.overspendShare) return null;
  const hit = opts.overspendShare.byId?.[cat.id];
  if (!hit) return null;
  if (hit.role === 'snowball') {
    return el('div', {
      className: 'envelope-share-hit protected',
      title: 'Extra paid to the mapped debt — not a hole to fill from other envelopes',
    }, 'Extra snowball — not overspend');
  }
  if (hit.role === 'bill-extra') {
    return el('div', {
      className: 'envelope-share-hit protected',
      title: 'Extra toward a mapped bill — leftover on this envelope is not shared',
    }, 'Extra to bill — not overspend');
  }
  if (hit.role === 'over') {
    return el('div', { className: 'envelope-share-hit over' },
      `Needs ${formatCurrency(hit.over)} covered from leftover (same checking pile)`,
    );
  }
  if (hit.role === 'protected') {
    const label = hit.kind === 'debt'
      ? 'Debt envelope — leftover not shared'
      : 'Bill envelope — leftover not shared';
    return el('div', {
      className: 'envelope-share-hit protected',
      title: 'Mapped on Bills or Debt with a set amount — leftover is not shared',
    }, label);
  }
  if (hit.role === 'donor' && hit.take > 0.005) {
    return el('div', {
      className: `envelope-share-hit${hit.isSinking ? ' sinking' : ''}`,
      title: 'Pro-rata share of household overspend — leftover is on paper until you cover it',
    },
      `Share of overspend −${formatCurrency(hit.take)} → ${formatCurrency(hit.after)} real`,
    );
  }
  return null;
}

function envelopeCard(cat, focusId = null, opts = {}) {
  const month = opts.month || getCurrentMonth();
  const isCurrentMonth = opts.isCurrentMonth !== false && month === getCurrentMonth();
  const spent = store.getCategorySpent(cat.id, month);
  const remaining = store.getCategoryRemaining(cat.id, month);
  const budgeted = store.getCategoryBudgeted(cat.id, month);
  const carry = isCurrentMonth ? (Number(cat.carryOver) || 0) : 0;
  const moveDelta = store.getEnvelopeMoveDelta(cat.id, month);
  const health = store.getEnvelopeHealth(cat.id, month);
  const isOver = remaining < 0 && health === 'over';
  const healthLabel = store.getEnvelopeHealthLabel(health);
  const txCount = store.getCategoryTransactions(cat.id, { month, range: 'month' }).length;
  const overCap = isCurrentMonth && store.isOverSoftCap(cat.id);
  const isFocused = focusId && cat.id === focusId;
  const isFav = !!opts.favorite || (store.getState().settings?.favoriteCategoryIds || []).includes(cat.id);
  const hasNote = !!(cat.note && String(cat.note).trim());
  // Pool = budget + carry + month-only moves (not permanent plan)
  const pool = store.getCategoryPool(cat.id, month);
  let usedPct = 0;
  if (pool > 0.005) usedPct = Math.min(100, (spent / pool) * 100);
  else if (spent > 0) usedPct = 100; // spent with no plan still shows full bar (over)
  if (isOver) usedPct = 100;

  const openActivity = () => openEnvelopeActivity(cat, { month });

  const card = el('div', {
    className: `envelope-card envelope-${health}${overCap ? ' envelope-over-cap' : ''} envelope-card-clickable${isFocused ? ' envelope-card-focus' : ''}${isFav ? ' envelope-card-fav' : ''}`,
    'data-category-id': cat.id,
    title: isFocused ? 'Focused from Advisor' : 'Click to see transactions for this envelope',
    onClick: (e) => {
      if (e.target.closest('button, a, input, select, textarea, label, summary')) return;
      openActivity();
    },
  },
    el('div', { className: 'envelope-card-top' },
      el('div', { className: 'envelope-header' },
        el('div', { className: 'envelope-title' },
          el('span', { className: 'envelope-icon' }, cat.icon || '✉️'),
          el('span', { className: 'envelope-name' }, cat.name),
          cat.isSinkingFund ? el('span', { className: 'sinking-tag' }, 'Sinking Fund') : null,
          healthLabel ? el('span', { className: `envelope-health-badge health-${health}` }, healthLabel) : null,
          overCap ? el('span', { className: 'envelope-health-badge health-over' }, cat.isSinkingFund ? 'Over goal' : 'Over cap') : null,
          hasNote ? el('span', { className: 'envelope-badge-mini', title: cat.note }, '📝') : null,
        ),
        el('div', { className: 'btn-group' },
          el('button', {
            type: 'button',
            className: `btn btn-sm btn-secondary${isFav ? ' fav-on' : ''}`,
            title: isFav ? 'Unpin favorite' : 'Pin favorite',
            onClick: (e) => { e.stopPropagation(); toggleFavorite(cat.id); },
          }, isFav ? '★' : '☆'),
          isCurrentMonth
            ? el('button', { className: 'btn btn-sm btn-secondary', onClick: (e) => { e.stopPropagation(); editCategory(cat); } }, '✏️')
            : null,
          isCurrentMonth
            ? el('button', { className: 'btn btn-sm btn-danger', onClick: (e) => { e.stopPropagation(); deleteCategory(cat.id); } }, '×')
            : null,
        )
      ),
      el('div', { className: 'envelope-stats' },
        el('div', { className: 'envelope-stat' },
          el('label', {}, 'Budgeted'),
          el('span', {}, formatCurrency(budgeted))
        ),
        el('div', { className: 'envelope-stat envelope-stat-spent' },
          el('label', {}, 'Spent'),
          el('span', {}, formatCurrency(spent)),
          txCount > 0
            ? el('span', { className: 'envelope-tx-hint' }, `${txCount} tx`)
            : null,
        ),
        isCurrentMonth
          ? el('div', { className: 'envelope-stat' },
            el('label', {}, 'Carry-over'),
            el('span', {
              style: carry < -0.005 ? 'color:var(--negative);font-weight:600' : '',
            }, formatCurrency(carry)),
          )
          : el('div', { className: 'envelope-stat' },
            el('label', {}, 'Month'),
            el('span', { style: 'font-size:0.8rem' }, getMonthLabel(month)),
          ),
      ),
      el('div', { className: `envelope-remaining ${isOver ? 'over' : 'ok'}` },
        el('span', {}, 'Remaining'),
        el('span', { className: 'amount' }, formatCurrency(remaining))
      ),
      overspendShareLine(cat, remaining, opts),
      coverIouLine(cat),
      Math.abs(moveDelta) > 0.005
        ? el('div', {
          className: 'envelope-move-delta',
          title: 'Month-only moves between envelopes (plan budget unchanged)',
        }, moveDelta > 0
          ? `+${formatCurrency(moveDelta)} moved in this month`
          : `${formatCurrency(moveDelta)} moved out this month`)
        : null,
      store.getBonusAllocationDelta(cat.id, month) > 0.005
        ? el('div', {
          className: 'envelope-move-delta',
          title: 'Drawn from the free bonus pot this month',
        }, `+${formatCurrency(store.getBonusAllocationDelta(cat.id, month))} bonus this month`)
        : null,
      // Fixed-height track on every card so bars line up and look even
      el('div', {
        className: 'progress-bar envelope-progress',
        title: pool > 0
          ? `${Math.round(usedPct)}% of ${formatCurrency(pool)} used`
          : (spent > 0 ? 'Spending with no budget set' : 'No budget set'),
      },
        el('div', {
          className: `progress-fill${isOver || (pool <= 0 && spent > 0) ? ' progress-fill-over' : ''}`,
          style: `width:${usedPct}%`,
        }),
      ),
      el('div', { className: 'envelope-progress-meta' },
        pool > 0 || spent > 0
          ? `${Math.round(usedPct)}% used`
          : 'No budget set',
      ),
      el('div', { className: 'envelope-card-mid' },
        isCurrentMonth ? goalBlock(cat) : null,
        linkedItems(cat),
      ),
    ),
    el('div', { className: 'envelope-card-footer' },
      el('button', {
        className: 'btn btn-sm btn-secondary', style: 'width:100%',
        onClick: (e) => { e.stopPropagation(); openActivity(); },
      }, txCount ? `View ${txCount} transaction${txCount === 1 ? '' : 's'}` : 'View transactions'),
      isCurrentMonth
        ? el('button', {
          className: 'btn btn-sm btn-secondary', style: 'width:100%;margin-top:0.5rem',
          onClick: (e) => { e.stopPropagation(); openMoveBetweenEnvelopes({ fromId: cat.id }); },
        }, 'Move $')
        : null,
      isCurrentMonth && Math.abs(carry) > 0.005
        ? el('button', {
          className: 'btn btn-sm btn-secondary',
          style: 'width:100%;margin-top:0.5rem',
          title: carry < 0
            ? 'Forgive prior-month overspend — start this month at $0 carry (budget plan unchanged)'
            : 'Drop leftover carry-over from prior months (budget plan unchanged)',
          onClick: (e) => {
            e.stopPropagation();
            resetEnvelopeCarry(cat);
          },
        }, carry < 0
          ? `Clear overspend (${formatCurrency(carry)})`
          : `Reset carry (${formatCurrency(carry)})`)
        : null,
      isCurrentMonth
        ? el('button', {
          className: 'btn btn-sm btn-secondary', style: 'width:100%;margin-top:0.5rem',
          title: 'Put unmatched bonus or leftover from other envelopes on this one',
          onClick: (e) => { e.stopPropagation(); openAssignBonusToEnvelope(cat); },
        }, 'Assign bonus')
        : null,
      isCurrentMonth
        ? el('button', {
          className: 'btn btn-sm btn-primary', style: 'width:100%;margin-top:0.5rem',
          onClick: (e) => { e.stopPropagation(); fundEnvelope(cat); },
        }, 'Allocate')
        : el('p', {
          className: 'tx-form-hint',
          style: 'margin:0.5rem 0 0;font-size:0.75rem;line-height:1.35',
        }, 'Past month — edit a transaction’s date to move a late post here.'),
      cat.note && String(cat.note).trim()
        ? el('div', { className: 'envelope-note' },
          el('span', { className: 'envelope-note-label' }, 'Note'),
          el('p', { className: 'envelope-note-text' }, String(cat.note).trim()),
        )
        : null,
    ),
  );

  return card;
}

const ACTIVITY_RANGES = [
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

function rangeLabel(range, month = getCurrentMonth()) {
  if (range === '30d') return 'Last 30 days';
  if (range === 'all') return 'All time';
  return getMonthLabel(month);
}

/**
 * Envelope activity modal.
 * @param {{ range?: string, month?: string }} opts
 *   month — which budget month’s “month” range to show (defaults to current).
 */
export function openEnvelopeActivity(cat, { range: initialRange = 'month', month: viewMonth } = {}) {
  const liveMonth = getCurrentMonth();
  const activityMonth = viewMonth && viewMonth <= liveMonth ? viewMonth : liveMonth;
  const isPastMonth = activityMonth !== liveMonth;
  let range = initialRange;
  let editingNote = false;
  const bodyHost = el('div', {});
  let modal;

  function saveNote(text) {
    store.setEnvelopeNote(cat.id, text);
    editingNote = false;
    showToast(String(text || '').trim() ? 'Envelope note saved' : 'Envelope note cleared', 'success');
    paint();
    // Refresh cards behind the modal without losing this view
    // (store subscribe re-renders pages; re-open paint is enough for note)
  }

  function paint() {
    const txs = store.getCategoryTransactions(cat.id, {
      range,
      month: activityMonth,
    });
    // Activity total: spending only (gifts listed separately as income rows)
    const spendTotal = txs
      .filter(t => t.type === 'expense' || t.type === 'debt_payment')
      .reduce((s, t) => s + (Number(t.envelopeAmount) || 0), 0);
    const refundTotal = txs
      .filter(t => t.type === 'income')
      .reduce((s, t) => s + (Number(t.envelopeAmount) || 0), 0);
    const list = el('div', { className: 'envelope-activity-list' });

    if (!txs.length) {
      list.appendChild(emptyState(
        '📝',
        'No activity yet',
        `Nothing charged to ${cat.name} in this range. Log an expense, refund, gift, or import a CSV.`,
      ));
    } else {
      txs.forEach(t => {
        const isPending = store.isPending?.(t);
        const isSplit = store.isSplitTransaction(t);
        const isIncome = t.type === 'income';
        const isBonusAlloc = !!t.bonusAllocationId;
        const isRefund = isIncome && !!t.refundOfTxId;
        const memo = String(t.memo || '').trim();
        const kind = t.type === 'debt_payment'
          ? 'Debt payment'
          : isBonusAlloc
            ? 'Bonus allocated'
            : isRefund
              ? 'Refund / restored'
              : isIncome
                ? (t.earmarkedEnvelope ? 'Assigned to envelope' : 'Income / gift')
                : 'Expense';
        list.appendChild(el('div', {
          className: `envelope-activity-row${isIncome ? ' envelope-activity-row-in' : ''}`,
        },
          el('div', { className: 'envelope-activity-main' },
            el('div', { className: 'envelope-activity-top' },
              el('strong', {}, formatDate(t.date)),
              el('span', {
                className: `envelope-activity-amt${isIncome ? ' positive' : ''}`,
              }, `${isIncome ? '+' : ''}${formatCurrency(t.envelopeAmount)}`),
            ),
            el('div', { className: 'envelope-activity-desc' }, t.description || '—'),
            memo
              ? el('div', { className: 'envelope-activity-memo' }, memo)
              : null,
            el('div', { className: 'envelope-activity-meta' },
              kind,
              isSplit ? ' · Split' : '',
              isPending ? ' · Pending' : '',
              t.envelopeAmount !== Math.abs(Number(t.amount))
                ? ` · of ${formatCurrency(t.amount)} total`
                : '',
            ),
          ),
          isBonusAlloc
            ? el('button', {
              type: 'button',
              className: 'btn btn-sm btn-secondary',
              title: 'Return this amount to the bonus pot',
              onClick: () => {
                if (store.reverseBonusAllocation(t.bonusAllocationId, t.bonusAllocationMonth || activityMonth)) {
                  showToast('Bonus returned to the free pot', 'success');
                  paint();
                  window.appRefresh();
                }
              },
            }, 'Undo')
            : el('button', {
              type: 'button',
              className: 'btn btn-sm btn-secondary',
              title: isPastMonth
                ? 'Edit date to keep a late post in this month, or change envelope'
                : 'Edit transaction',
              onClick: () => {
                modal?.close();
                openTransactionForm({ transaction: t });
              },
            }, 'Edit'),
        ));
      });
      list.appendChild(el('div', { className: 'envelope-activity-total' },
        el('span', {}, 'Spent'),
        el('strong', {}, formatCurrency(spendTotal)),
      ));
      if (refundTotal > 0.005) {
        list.appendChild(el('div', { className: 'envelope-activity-total envelope-activity-total-in' },
          el('span', {}, 'Bonus / refunds'),
          el('strong', { className: 'positive' }, `+${formatCurrency(refundTotal)}`),
        ));
        list.appendChild(el('div', { className: 'envelope-activity-total' },
          el('span', {}, 'Net spent'),
          el('strong', {}, formatCurrency(Math.max(0, spendTotal - refundTotal))),
        ));
      }
    }

    const monthChipLabel = isPastMonth
      ? getMonthLabel(activityMonth)
      : 'This month';
    const chips = el('div', { className: 'chip-bar' },
      ...ACTIVITY_RANGES.map(opt => el('button', {
        type: 'button',
        className: `chip${range === opt.id ? ' active' : ''}`,
        onClick: () => { range = opt.id; paint(); },
      }, opt.id === 'month' ? monthChipLabel : opt.label)),
    );

    const live = store.getState().categories.find(c => c.id === cat.id) || cat;
    const noteText = String(live.note || '').trim();
    const noteBox = el('div', { className: 'envelope-note envelope-note-in-modal envelope-note-editable' });

    if (editingNote) {
      const ta = el('textarea', {
        className: 'envelope-note-editor',
        rows: 3,
        placeholder: 'e.g. $20 from Grandma for Emma’s birthday — don’t mix with allowance',
      });
      ta.value = noteText;
      noteBox.appendChild(el('span', { className: 'envelope-note-label' }, 'Envelope note'));
      noteBox.appendChild(ta);
      noteBox.appendChild(el('div', { className: 'btn-group', style: 'margin-top:0.5rem;flex-wrap:wrap;gap:0.35rem' },
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-primary',
          onClick: () => saveNote(ta.value),
        }, 'Save note'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => { editingNote = false; paint(); },
        }, 'Cancel'),
        noteText
          ? el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => {
              confirmDialog(
                'Clear envelope note?',
                'This removes the general note on this envelope. Transaction memos are unchanged. You can add a new note anytime.',
                () => saveNote(''),
              );
            },
          }, 'Clear note')
          : null,
      ));
      setTimeout(() => ta.focus(), 30);
    } else if (noteText) {
      noteBox.appendChild(el('div', { className: 'envelope-note-head' },
        el('span', { className: 'envelope-note-label' }, 'Envelope note'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => { editingNote = true; paint(); },
        }, 'Edit'),
      ));
      noteBox.appendChild(el('p', { className: 'envelope-note-text' }, noteText));
      noteBox.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        style: 'margin-top:0.45rem',
        onClick: () => {
          confirmDialog(
            'Clear envelope note?',
            'Removes this note only — gift money and transactions stay as they are.',
            () => saveNote(''),
          );
        },
      }, 'Clear note'));
    } else {
      noteBox.appendChild(el('span', { className: 'envelope-note-label' }, 'Envelope note'));
      noteBox.appendChild(el('p', {
        className: 'envelope-note-text',
        style: 'color:var(--text-muted);font-style:italic',
      }, 'No note yet — for gift money context, kid reminders, etc.'));
      noteBox.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-sm btn-primary',
        style: 'margin-top:0.45rem',
        onClick: () => { editingNote = true; paint(); },
      }, '+ Add note'));
    }

    bodyHost.innerHTML = '';
    bodyHost.appendChild(noteBox);
    if (isPastMonth && range === 'month') {
      bodyHost.appendChild(el('p', {
        className: 'tx-form-hint',
        style: 'margin:0 0 0.65rem;line-height:1.4',
      }, `Showing ${getMonthLabel(activityMonth)}. A purchase that posted this month but belongs here: Edit → set the date to the purchase day so it leaves the new month and hits this envelope.`));
    }
    bodyHost.appendChild(chips);
    bodyHost.appendChild(el('p', { className: 'envelope-activity-summary' },
      `${rangeLabel(range, activityMonth)} · spent ${formatCurrency(spendTotal)}`
      + (refundTotal > 0.005 ? ` · refunded ${formatCurrency(refundTotal)}` : '')
      + ` · ${txs.length} item${txs.length === 1 ? '' : 's'}`,
    ));
    bodyHost.appendChild(list);
  }

  paint();

  modal = showModal({
    title: `${cat.icon || '✉️'} ${cat.name}${isPastMonth ? ` · ${getMonthLabel(activityMonth)}` : ''}`,
    body: bodyHost,
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          modal.close();
          // Default new expense to the viewed month (1st) so late posts can be dated correctly
          const defaultDate = isPastMonth ? `${activityMonth}-01` : undefined;
          openTransactionForm({
            type: 'expense',
            categoryId: cat.id,
            ...(defaultDate ? { date: defaultDate } : {}),
          });
        },
      }, '+ Log expense'),
      !isPastMonth
        ? el('button', {
          type: 'button',
          className: 'btn btn-secondary',
          title: 'Put unmatched bonus or leftover from other envelopes here',
          onClick: () => {
            modal.close();
            openAssignBonusToEnvelope(cat);
          },
        }, 'Assign bonus')
        : null,
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        title: 'Log a new refund or extra cash and assign it to this envelope',
        onClick: () => {
          modal.close();
          const defaultDate = isPastMonth ? `${activityMonth}-01` : undefined;
          openTransactionForm({
            type: 'income',
            categoryId: cat.id,
            ...(defaultDate ? { date: defaultDate } : {}),
          });
        },
      }, '+ New refund'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => {
          modal.close();
          window.appNavigate('transactions', { categoryId: cat.id });
        },
      }, 'Open in Transactions'),
    ],
  });
  modal.modal.classList.add('modal-wide', 'modal-scrollable');
}

function doFundEnvelope(cat, amt) {
  store.fundEnvelope(cat.id, amt);
  showToast(`Assigned ${formatCurrency(amt)} to ${cat.name}`);
  window.appRefresh();
}

function resetEnvelopeCarry(cat) {
  const carry = Number(cat.carryOver) || 0;
  if (Math.abs(carry) < 0.005) {
    showToast('No carry-over on this envelope', 'info');
    return;
  }
  const isNeg = carry < 0;
  confirmDialog(
    isNeg ? 'Clear prior overspend?' : 'Reset carry-over?',
    isNeg
      ? `${cat.name} is carrying ${formatCurrency(carry)} from prior months. Clear it so this month isn’t starting in the hole? Monthly budget plan stays the same; bank checking is unchanged.`
      : `${cat.name} has ${formatCurrency(carry)} carry-over. Zero it out? Monthly budget plan stays the same; bank checking is unchanged.`,
    () => {
      store.resetEnvelopeCarryOver(cat.id);
      showToast(
        isNeg
          ? `Cleared ${formatCurrency(carry)} overspend on ${cat.name}`
          : `Reset carry on ${cat.name}`,
        'success',
      );
    },
  );
}

function clearAllNegativeCarry() {
  const n = store.countNegativeCarryOvers();
  if (!n) {
    showToast('No envelopes with negative carry-over', 'info');
    return;
  }
  confirmDialog(
    'Clear all negative carry-over?',
    `${n} envelope${n === 1 ? '' : 's'} still “owe” from prior months. Zero those carry balances so this month starts clean? Does not change budget plans or checking.`,
    () => {
      const cleared = store.clearNegativeCarryOvers();
      showToast(
        cleared
          ? `Cleared negative carry on ${cleared} envelope${cleared === 1 ? '' : 's'}`
          : 'Nothing to clear',
        cleared ? 'success' : 'info',
      );
    },
  );
}

/**
 * Month-only envelope reallocation (rob Peter to pay Paul).
 * Does not change monthlyBudget plan or bank checking.
 */
function openMoveBetweenEnvelopes({ fromId = '', toId = '' } = {}) {
  const month = getCurrentMonth();
  const cats = store.getState().categories.filter(c => !c.parentId);
  if (cats.length < 2) {
    showToast('Need at least two envelopes to move between', 'info');
    return;
  }

  const fromPicker = createEnvelopePicker({
    id: 'move-from-env',
    value: fromId || '',
    placeholder: 'From envelope…',
    emptyLabel: '— From —',
    showRemaining: true,
    allowEmpty: true,
  });
  const toPicker = createEnvelopePicker({
    id: 'move-to-env',
    value: toId || '',
    placeholder: 'To envelope…',
    emptyLabel: '— To —',
    showRemaining: true,
    allowEmpty: true,
  });
  const amountIn = el('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    placeholder: '0.00',
  });
  const noteIn = el('input', {
    type: 'text',
    placeholder: 'Optional note (e.g. cover groceries overage)',
  });
  const hint = el('p', { className: 'tx-form-hint', style: 'margin-top:0.5rem;margin-bottom:0' }, '');
  const historyHost = el('div', { className: 'envelope-move-history' });

  function fromRemaining() {
    const id = fromPicker.value;
    if (!id) return 0;
    return store.getCategoryRemaining(id, month);
  }

  function updateHint() {
    const id = fromPicker.value;
    if (!id) {
      hint.textContent = 'Pick a source envelope with leftover room this month.';
      return;
    }
    const rem = fromRemaining();
    const cat = store.getState().categories.find(c => c.id === id);
    const name = cat ? cat.name : 'Source';
    if (rem > 0.005) {
      hint.textContent = `${name} has ${formatCurrency(rem)} left this month — max you can move.`;
      if (!amountIn.value || Number(amountIn.value) <= 0) {
        amountIn.value = String(Math.round(rem * 100) / 100);
      }
    } else if (rem < -0.005) {
      hint.textContent = `${name} is already over by ${formatCurrency(Math.abs(rem))} — pick an envelope with leftover.`;
    } else {
      hint.textContent = `${name} has nothing left to move this month.`;
    }
  }

  function paintHistory() {
    historyHost.innerHTML = '';
    const moves = store.getEnvelopeMoves(month);
    if (!moves.length) {
      historyHost.appendChild(el('p', {
        className: 'tx-form-hint',
        style: 'margin:0.75rem 0 0',
      }, 'No moves yet this month.'));
      return;
    }
    historyHost.appendChild(el('div', {
      className: 'section-title',
      style: 'margin:1rem 0 0.5rem;font-size:0.85rem',
    }, 'This month’s moves'));
    const list = el('div', { className: 'envelope-move-list' });
    [...moves].reverse().forEach(m => {
      const from = store.getState().categories.find(c => c.id === m.fromId);
      const to = store.getState().categories.find(c => c.id === m.toId);
      list.appendChild(el('div', { className: 'envelope-move-row' },
        el('div', { className: 'envelope-move-row-main' },
          el('strong', {}, formatCurrency(m.amount)),
          el('span', {}, ` ${from?.name || '?'} → ${to?.name || '?'}`),
          m.note ? el('div', { className: 'tx-form-hint', style: 'margin:0.15rem 0 0' }, m.note) : null,
        ),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => {
            if (store.reverseEnvelopeTransfer(m.id, month)) {
              showToast('Move undone', 'info');
              updateHint();
              paintHistory();
              window.appRefresh();
            }
          },
        }, 'Undo'),
      ));
    });
    historyHost.appendChild(list);
  }

  fromPicker.addEventListener('change', updateHint);
  updateHint();
  paintHistory();

  const modal = showModal({
    title: 'Move between envelopes',
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        'Shift leftover room for ',
        el('strong', {}, getMonthLabel(month)),
        ' only — like covering an overspent envelope with Insurance leftover. ',
        'Does not change next month’s budget plan or your bank balance.',
      ),
      el('div', { className: 'form-group' },
        el('label', { for: 'move-from-env' }, 'From (has leftover)'),
        fromPicker.element,
      ),
      el('div', { className: 'form-group' },
        el('label', { for: 'move-to-env' }, 'To (needs room)'),
        toPicker.element,
      ),
      el('div', { className: 'form-group' },
        el('label', {}, 'Amount'),
        amountIn,
        hint,
      ),
      el('div', { className: 'form-group' },
        el('label', {}, 'Note (optional)'),
        noteIn,
      ),
      historyHost,
    ),
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          fromPicker.commitTyped?.();
          toPicker.commitTyped?.();
          const from = fromPicker.value;
          const to = toPicker.value;
          const amt = Math.round((Number(amountIn.value) || 0) * 100) / 100;
          if (!from || !to) {
            showToast('Pick both envelopes', 'info');
            return;
          }
          if (from === to) {
            showToast('Pick two different envelopes', 'info');
            return;
          }
          if (!(amt > 0)) {
            showToast('Enter an amount greater than zero', 'info');
            return;
          }
          const rem = store.getCategoryRemaining(from, month);
          if (amt > rem + 0.001) {
            showToast(`Only ${formatCurrency(rem)} left in the source envelope`, 'info');
            return;
          }
          const move = store.transferBetweenEnvelopes(from, to, amt, {
            month,
            note: noteIn.value,
          });
          if (!move) {
            showToast('Could not move that amount', 'info');
            return;
          }
          const fromName = store.getState().categories.find(c => c.id === from)?.name || 'envelope';
          const toName = store.getState().categories.find(c => c.id === to)?.name || 'envelope';
          showToast(`Moved ${formatCurrency(amt)} ${fromName} → ${toName} (this month only)`, 'success');
          modal.close();
          window.appRefresh();
        },
      }, 'Move'),
    ],
  });
  modal.modal.classList.add('modal-scrollable');
}

export function openUpcomingHolds() {
  if (!store.canWriteBudget()) {
    showToast('Upcoming holds stay on the main account', 'info');
    return;
  }
  const nextFirst = `${addMonths(getCurrentMonth(), 1)}-01`;
  const medical = (store.getState().categories || []).find(c =>
    /medical/i.test(String(c.name || '')) && !c.parentId,
  );
  const descIn = el('input', {
    type: 'text',
    placeholder: 'Roman medical',
    value: '',
  });
  const dateIn = el('input', { type: 'date', value: nextFirst });
  const amountIn = el('input', { type: 'number', step: '0.01', min: '0', value: '1500' });
  const picker = createEnvelopePicker({
    value: medical?.id || '',
    placeholder: 'Envelope (optional)',
    emptyLabel: '— Cash hold, no envelope —',
    showRemaining: true,
    allowEmpty: true,
  });

  const list = el('div', { className: 'envelope-move-list', style: 'margin-bottom:1rem' });
  function paintList() {
    list.innerHTML = '';
    const holds = store.getUpcomingHolds();
    if (!holds.length) {
      list.appendChild(el('p', { className: 'tx-form-hint' }, 'None yet.'));
      return;
    }
    holds.forEach(h => {
      const cat = store.getState().categories.find(c => c.id === h.categoryId);
      const spent = store.getUpcomingHoldSpent(h);
      const left = Math.max(0, Math.round((h.amount - spent) * 100) / 100);
      const done = store.isUpcomingHoldSatisfied(h);
      const actions = el('div', { className: 'btn-group', style: 'flex-shrink:0' });
      if (!done) {
        actions.appendChild(el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => {
            store.dismissUpcomingHold(h.id);
            paintList();
            window.appRefresh();
          },
        }, 'Dismiss'));
      }
      actions.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => {
          store.deleteUpcomingHold(h.id);
          paintList();
          window.appRefresh();
        },
      }, 'Delete'));
      list.appendChild(el('div', { className: 'envelope-move-row' },
        el('div', { className: 'envelope-move-row-main' },
          el('strong', {}, formatCurrency(h.amount)),
          el('span', {},
            ` ${h.description || cat?.name || 'Hold'} · ${formatDate(h.date)}`
            + (cat ? ` · ${cat.name}` : '')
            + (done ? ' · done' : spent > 0.005 ? ` · ${formatCurrency(left)} still held` : ''),
          ),
        ),
        actions,
      ));
    });
  }
  paintList();

  const modal = showModal({
    title: 'Upcoming hold',
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        'Known future spend (next month’s medical, travel, etc.). Held out of snowball and safe-to-send. Does not change To Allocate or checking. Drops when you spend it on that envelope or dismiss it.',
      ),
      el('div', { className: 'section-title' }, 'Active'),
      list,
      el('div', { className: 'section-title' }, 'Add one'),
      el('div', { className: 'form-group' }, el('label', {}, 'What'), descIn),
      el('div', { className: 'form-group' }, el('label', {}, 'When'), dateIn),
      el('div', { className: 'form-group' }, el('label', {}, 'Amount'), amountIn),
      el('div', { className: 'form-group' }, el('label', {}, 'Envelope'), picker.element),
    ),
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const amt = Math.round((Number(amountIn.value) || 0) * 100) / 100;
          picker.commitTyped?.();
          const row = store.addUpcomingHold({
            date: dateIn.value,
            amount: amt,
            categoryId: picker.value || null,
            description: descIn.value,
          });
          if (!row) {
            showToast('Need a date and amount greater than zero', 'info');
            return;
          }
          showToast(`Holding ${formatCurrency(row.amount)} out of snowball`, 'success');
          modal.close();
          window.appRefresh();
        },
      }, 'Hold from snowball'),
    ],
  });
  modal.modal.classList.add('modal-scrollable');
}

function openCoverOverspend(month = getCurrentMonth()) {
  if (!store.canWriteBudget()) {
    showToast('Covering overspend stays on the main account', 'info');
    return;
  }
  let includeSinking = false;
  const preview = el('div', { className: 'overspend-cover-preview' });

  function paint() {
    const plan = store.planCoverOverspend(month, { includeSinkingFunds: includeSinking });
    preview.innerHTML = '';
    preview.appendChild(el('p', { className: 'tx-form-hint', style: 'margin:0 0 0.75rem' },
      `Moves ${formatCurrency(plan.total)} this month only — next month’s budget plan is unchanged. `
      + (includeSinking
        ? 'Includes sinking funds.'
        : 'Sinking funds (Christmas, vacation, etc.) are left alone.'),
    ));
    if (!plan.moves.length) {
      preview.appendChild(el('p', { className: 'tx-form-hint', style: 'margin:0' },
        plan.overspendTotal > 0.005
          ? 'Not enough leftover in the selected envelopes to cover this. Turn on sinking funds, or Move leftover by hand.'
          : 'Nothing is overspent this month.',
      ));
      return;
    }
    const fromTotals = new Map();
    plan.moves.forEach(m => {
      const cur = fromTotals.get(m.fromId) || { name: m.fromName, amount: 0, isSinking: m.isSinking };
      cur.amount += m.amount;
      fromTotals.set(m.fromId, cur);
    });
    const list = el('div', { className: 'envelope-move-list' });
    [...fromTotals.values()]
      .sort((a, b) => b.amount - a.amount)
      .forEach(row => {
        list.appendChild(el('div', { className: 'envelope-move-row' },
          el('div', { className: 'envelope-move-row-main' },
            el('strong', {}, `−${formatCurrency(row.amount)}`),
            el('span', {}, ` ${row.name}${row.isSinking ? ' · sinking' : ''}`),
          ),
        ));
      });
    preview.appendChild(list);
    if (plan.shortfall > 0.005) {
      preview.appendChild(el('p', {
        className: 'tx-form-hint',
        style: 'margin:0.75rem 0 0;color:var(--negative)',
      }, `${formatCurrency(plan.shortfall)} still uncovered — leftover isn’t enough.`));
    }
  }

  const sinkToggle = el('label', { className: 'form-option', style: 'margin-top:0.5rem' },
    el('input', {
      type: 'checkbox',
      checked: includeSinking ? true : undefined,
      onChange: (e) => {
        includeSinking = !!e.target.checked;
        paint();
      },
    }),
    el('span', {}, 'Include sinking funds in the share'),
  );

  paint();

  const share = store.getOverspendShare(month);
  const modal = showModal({
    title: 'Cover overspend',
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        `${formatCurrency(share.overspendTotal)} overspent this month. Take a percentage of leftover on flexible envelopes (bigger leftover pays more) and move it onto the overspent ones. Envelopes mapped to a bill amount or an active debt are never skimmed. Checking does not change. We’ll remember who chipped in and offer to restore them from bonus later.`,
      ),
      sinkToggle,
      preview,
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
        onClick: () => {
          const plan = store.applyCoverOverspend(month, { includeSinkingFunds: includeSinking });
          if (!plan || !plan.moves.length) {
            showToast('Nothing to move', 'info');
            return;
          }
          showToast(
            `Covered ${formatCurrency(plan.total)} from leftover`
            + (plan.shortfall > 0.005 ? ` · ${formatCurrency(plan.shortfall)} still open` : '')
            + ' · will offer to restore from bonus later',
            'success',
          );
          modal.close();
          window.appRefresh();
        },
      }, 'Apply this month'),
    ],
  });
  modal.modal.classList.add('modal-scrollable');
}

function openRepayCoverFromBonus(month = getCurrentMonth()) {
  if (!store.canWriteBudget()) {
    showToast('Repaying cover stays on the main account', 'info');
    return;
  }
  const plan = store.planRepayCoverFromBonus(month);
  if (!plan.total) {
    showToast(
      plan.bonus < 0.005
        ? 'No free bonus yet — wait for a refund or extra deposit'
        : 'Nothing left to repay',
      'info',
    );
    return;
  }
  const list = el('div', { className: 'envelope-move-list' });
  plan.pays.forEach(p => {
    list.appendChild(el('div', { className: 'envelope-move-row' },
      el('div', { className: 'envelope-move-row-main' },
        el('strong', {}, `+${formatCurrency(p.amount)}`),
        el('span', {}, ` ${p.name}${p.isSinking ? ' · sinking' : ''}`),
      ),
    ));
  });
  const modal = showModal({
    title: 'Repay cover from bonus',
    body: el('div', {},
      el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
        `Put ${formatCurrency(plan.total)} of free bonus back onto envelopes that covered overspend. `
        + `Sinking funds first. Does not undo the original cover — those overspent envelopes stay covered. `
        + (plan.leftoverIou > 0.005
          ? `${formatCurrency(plan.leftoverIou)} still owed after this.`
          : 'This clears the IOU.'),
      ),
      list,
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
        onClick: () => {
          const result = store.repayCoverFromBonus(month);
          if (!result || !result.total) {
            showToast('Nothing to repay', 'info');
            return;
          }
          showToast(`Restored ${formatCurrency(result.total)} from bonus`, 'success');
          modal.close();
          window.appRefresh();
        },
      }, `Repay ${formatCurrency(plan.total)}`),
    ],
  });
  modal.modal.classList.add('modal-scrollable');
}

function openAssignBonusToEnvelope(cat) {
  const month = getCurrentMonth();
  const gross = store.getBonusIncomeGross(month);
  const used = store.getBonusAllocated(month);
  const available = store.getBonusAvailable(month);
  const here = store.getBonusAllocationDelta(cat.id, month);
  const deposits = store.getUnassignedBonusTransactions(month, { includePrevious: false });
  const prior = store.getBonusAllocations(month).filter(a => a.categoryId === cat.id);

  const amountIn = el('input', {
    type: 'number',
    step: '0.01',
    min: 0,
    value: available > 0.005 ? String(available) : '0',
  });
  const history = el('div', { className: 'assign-leftover-preview' });
  let modal;

  function paintHistory() {
    history.innerHTML = '';
    if (!prior.length) {
      history.appendChild(el('p', { className: 'tx-form-hint', style: 'margin:0' },
        'Nothing from the bonus pot on this envelope yet.'));
      return;
    }
    prior.forEach(a => {
      history.appendChild(el('div', { className: 'assign-leftover-row assign-leftover-row-static' },
        el('span', { className: 'assign-leftover-row-main' },
          el('strong', {}, formatDate(String(a.at || '').slice(0, 10))),
          el('span', {}, a.note || 'Bonus allocated'),
        ),
        el('span', { className: 'assign-leftover-row-amt' }, formatCurrency(a.amount)),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => {
            if (store.reverseBonusAllocation(a.id, month)) {
              showToast('Returned to the bonus pot', 'success');
              modal.close();
              window.appRefresh();
              openAssignBonusToEnvelope(cat);
            }
          },
        }, 'Undo'),
      ));
    });
  }
  paintHistory();

  modal = showModal({
    title: 'Assign bonus → ' + cat.name,
    body: el('div', {},
      el('div', { className: 'card', style: 'margin-bottom:1rem' },
        el('div', { className: 'card-title' }, 'Bonus available'),
        el('div', { className: 'card-value accent' }, formatCurrency(available)),
        el('p', { className: 'tx-form-hint', style: 'margin:0.35rem 0 0;line-height:1.4' },
          formatCurrency(gross) + ' bonus in this month · '
          + formatCurrency(used) + ' already sent to envelopes'
          + (here > 0.005 ? ' · ' + formatCurrency(here) + ' already on ' + cat.name : '')
          + '. Refunds stay in this pot — they are not sent back to the original purchase.',
        ),
      ),
      deposits.length
        ? el('div', { style: 'margin-bottom:1rem' },
          el('p', { className: 'tx-form-hint', style: 'margin:0 0 0.4rem' },
            'Feeding the pot (not assigned to a specific envelope):'),
          ...deposits.slice(0, 8).map(t => el('div', { className: 'assign-leftover-row assign-leftover-row-static' },
            el('span', { className: 'assign-leftover-row-main' },
              el('strong', {}, formatDate(t.date)),
              el('span', {}, t.description || 'Bonus'),
            ),
            el('span', { className: 'assign-leftover-row-amt' }, formatCurrency(t.amount)),
          )),
          deposits.length > 8
            ? el('p', { className: 'tx-form-hint', style: 'margin:0.35rem 0 0' },
              '+' + (deposits.length - 8) + ' more')
            : null,
        )
        : el('p', { className: 'tx-form-hint', style: 'margin-bottom:1rem' },
          'No bonus deposits this month yet. Imported refunds and extra income land here automatically.',
        ),
      el('div', { className: 'form-group' },
        el('label', {}, 'Amount for ' + cat.name),
        amountIn,
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          style: 'margin-top:0.45rem',
          disabled: available < 0.005 ? true : undefined,
          onClick: () => { amountIn.value = String(available); },
        }, 'Use all available'),
      ),
      el('p', { className: 'tx-form-hint', style: 'margin:0 0 0.5rem' },
        "This month only. Remaining on this envelope goes up. The bonus pot and To Allocate go down. Next month's plan is unchanged.",
      ),
      el('div', { className: 'section-title', style: 'margin-top:0.5rem' }, 'Already on this envelope'),
      history,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Cancel'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        disabled: available < 0.005 ? true : undefined,
        onClick: () => {
          const amt = Math.round((Number(amountIn.value) || 0) * 100) / 100;
          if (!(amt > 0)) {
            showToast('Enter an amount greater than zero', 'info');
            return;
          }
          if (amt > available + 0.001) {
            showToast('Only ' + formatCurrency(available) + ' bonus is free', 'info');
            return;
          }
          const row = store.allocateBonusToEnvelope(cat.id, amt, { month });
          modal.close();
          if (row) {
            showToast('Assigned ' + formatCurrency(amt) + ' bonus to ' + cat.name, 'success');
          } else {
            showToast('Could not assign that amount', 'info');
          }
          window.appRefresh();
        },
      }, 'Assign bonus'),
    ],
  });
  modal.modal.classList.add('modal-scrollable');
}

function fundEnvelope(cat) {
  const toAllocate = store.getToAllocate();
  const goal = store.getCategoryGoal(cat.id);
  const budgeted = Number(cat.monthlyBudget) || 0;
  const input = el('input', {
    type: 'number',
    step: '0.01',
    min: 0,
    value: toAllocate > 0 ? String(Math.round(Math.min(toAllocate, 50) * 100) / 100) : '0',
  });
  const modal = showModal({
    title: `Allocate: ${cat.name}`,
    body: el('div', {},
      el('p', {
        className: 'tx-form-hint',
        style: 'margin-bottom:1rem',
      },
        'This gives dollars a job in this envelope. Money stays in your bank checking — only the budget assignment changes.',
      ),
      el('p', {
        style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem',
      }, `To Allocate right now: ${formatCurrency(toAllocate)}`),
      goal > 0
        ? el('p', {
          style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem',
        }, `${cat.isSinkingFund ? 'Goal' : 'Soft cap'}: ${formatCurrency(goal)} · currently budgeted ${formatCurrency(budgeted)}`)
        : null,
      el('div', { className: 'form-group' },
        el('label', {}, 'Amount to assign'),
        input,
      ),
    ),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        const amt = Number(input.value);
        if (!(amt > 0)) {
          showToast('Enter an amount greater than zero', 'info');
          return;
        }
        const nextBudget = budgeted + amt;
        const assign = () => {
          modal.close();
          doFundEnvelope(cat, amt);
        };
        if (goal > 0 && nextBudget > goal + 0.005) {
          confirmDialog(
            cat.isSinkingFund ? 'Over savings goal' : 'Over soft cap',
            `This puts ${cat.name} at ${formatCurrency(nextBudget)} (cap/goal ${formatCurrency(goal)}). Assign anyway?`,
            assign,
          );
          return;
        }
        assign();
      },
    }, 'Assign'),
  });
}

function sinkingFundToggle(checked) {
  const input = el('input', { type: 'checkbox' });
  if (checked) input.checked = true;
  const row = el('div', { className: 'form-option' },
    el('div', { className: 'form-option-text' },
      el('span', { className: 'form-option-label' }, 'Sinking fund'),
      el('span', { className: 'form-option-hint' }, 'Save up over time for periodic expenses'),
    ),
    el('label', { className: 'toggle-switch' },
      input,
      el('span', { className: 'toggle-slider' }),
    ),
  );
  return { row, input };
}

function goalField(isSinking, value = 0) {
  const input = el('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    placeholder: 'e.g. 400',
  });
  // Set value after create — empty string for “no cap” so the field is clearly editable
  const n = Number(value);
  input.value = n > 0 ? String(n) : '';
  const row = el('div', { className: 'form-group' },
    el('label', {}, isSinking ? 'Savings goal (optional)' : 'Soft cap (optional)'),
    input,
    el('p', { className: 'tx-form-hint', style: 'margin-top:0.35rem;margin-bottom:0' },
      isSinking
        ? 'Target to save toward (e.g. Christmas $800). Soft warning if you assign more than the goal.'
        : 'Optional max for this envelope (e.g. $400 on Eating Out). Leave blank for no cap. Soft warning only.',
    ),
  );
  return { row, input };
}

function parseGoalInput(input) {
  const raw = String(input?.value ?? '').trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function noteField(value = '') {
  const input = el('textarea', {
    rows: 3,
    placeholder: 'e.g. $20 from Grandma for Emma’s birthday — don’t mix with allowance',
    value: value || '',
    style: 'width:100%;resize:vertical;min-height:4rem',
  });
  // textarea value via attribute may not stick in all browsers through el()
  input.value = value || '';
  const row = el('div', { className: 'form-group' },
    el('label', {}, 'Note (optional)'),
    input,
    el('p', { className: 'tx-form-hint', style: 'margin-top:0.35rem;margin-bottom:0' },
      'Shows on the envelope card and activity — gift money, kid context, reminders for your spouse.',
    ),
  );
  return { row, input };
}

function addCategory(isSinking) {
  const nameIn = el('input', { type: 'text', placeholder: 'Category name' });
  const budgetIn = el('input', { type: 'number', step: '0.01', min: 0, value: 0 });
  const iconIn = el('input', { type: 'text', placeholder: 'Icon (emoji)', value: isSinking ? '🎯' : '📁' });
  const { row: sinkingRow, input: sinkingIn } = sinkingFundToggle(isSinking);
  const { row: goalRow, input: goalIn } = goalField(isSinking, 0);
  const { row: noteRow, input: noteIn } = noteField('');

  sinkingIn.addEventListener('change', () => {
    const label = goalRow.querySelector('label');
    const hint = goalRow.querySelector('.tx-form-hint');
    if (label) label.textContent = sinkingIn.checked ? 'Savings goal (optional)' : 'Soft cap (optional)';
    if (hint) {
      hint.textContent = sinkingIn.checked
        ? 'Target to save toward (e.g. Christmas $800). Warns if you assign more than the goal.'
        : 'Max you want budgeted here. Soft warning only — you can still override.';
    }
  });

  const modal = showModal({
    title: 'Add Envelope',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Icon'), iconIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Monthly Budget'), budgetIn),
      ),
      goalRow,
      noteRow,
      sinkingRow,
    ),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        if (!nameIn.value.trim()) return;
        store.update(s => {
          s.categories.push({
            id: crypto.randomUUID(),
            name: nameIn.value.trim(),
            icon: iconIn.value || '📁',
            parentId: null,
            isSinkingFund: sinkingIn.checked,
            monthlyBudget: Number(budgetIn.value),
            carryOver: 0,
            goalAmount: parseGoalInput(goalIn),
            note: noteIn.value.trim(),
          });
        });
        modal.close();
        showToast('Envelope added!');
      },
    }, 'Add'),
  });
}

function editCategory(cat) {
  const nameIn = el('input', { type: 'text', value: cat.name });
  const budgetIn = el('input', { type: 'number', step: '0.01', min: '0' });
  budgetIn.value = String(Number(cat.monthlyBudget) || 0);
  const iconIn = el('input', { type: 'text', value: cat.icon || '' });
  const { row: sinkingRow, input: sinkingIn } = sinkingFundToggle(cat.isSinkingFund);
  const { row: goalRow, input: goalIn } = goalField(cat.isSinkingFund, Number(cat.goalAmount) || 0);
  const { row: noteRow, input: noteIn } = noteField(cat.note || '');

  sinkingIn.addEventListener('change', () => {
    const label = goalRow.querySelector('label');
    const hint = goalRow.querySelector('.tx-form-hint');
    if (label) label.textContent = sinkingIn.checked ? 'Savings goal (optional)' : 'Soft cap (optional)';
    if (hint) {
      hint.textContent = sinkingIn.checked
        ? 'Target to save toward (e.g. Christmas $800). Soft warning if you assign more than the goal.'
        : 'Optional max for this envelope. Leave blank for no cap. Soft warning only.';
    }
  });

  const modal = showModal({
    title: 'Edit Envelope',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Icon'), iconIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Monthly Budget'), budgetIn),
      ),
      goalRow,
      noteRow,
      sinkingRow,
    ),
    footer: el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        const nextBudget = Number(budgetIn.value) || 0;
        const nextGoal = parseGoalInput(goalIn);
        // Always save — including soft cap — even if currently over the cap
        store.update(s => {
          const c = s.categories.find(x => x.id === cat.id);
          if (c) {
            c.name = nameIn.value.trim() || c.name;
            c.icon = iconIn.value;
            c.monthlyBudget = nextBudget;
            c.isSinkingFund = sinkingIn.checked;
            c.goalAmount = nextGoal;
            c.note = noteIn.value.trim();
          }
        });
        modal.close();
        if (nextGoal > 0 && nextBudget > nextGoal + 0.005) {
          showToast(
            `Saved. Note: budgeted ${formatCurrency(nextBudget)} is above the ${sinkingIn.checked ? 'goal' : 'soft cap'} of ${formatCurrency(nextGoal)}.`,
            'info',
            5000,
          );
        } else if (nextGoal > 0) {
          showToast(
            sinkingIn.checked
              ? `Saved · goal ${formatCurrency(nextGoal)}`
              : `Saved · soft cap ${formatCurrency(nextGoal)}`,
            'success',
          );
        } else {
          showToast('Envelope saved');
        }
      },
    }, 'Save'),
  });
}

function deleteCategory(id) {
  confirmDialog('Delete Category', 'Remove this category? Transactions will be unlinked.', () => {
    store.removeCategory(id);
    window.appRefresh();
  });
}