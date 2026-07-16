/**
 * Compact household money snapshot for Advisor (engine + future AI).
 * Read-only: never mutates store.
 */
import { store } from '../store.js';
import {
  getCurrentMonth,
  getMonthLabel,
  getPreviousMonth,
  todayISO,
} from '../utils.js';
import { BABY_STEPS } from '../defaults.js';

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function findCategoryByNameHint(categories, hints) {
  const lower = hints.map(h => h.toLowerCase());
  return categories.find(c => {
    const name = String(c.name || '').toLowerCase();
    return lower.some(h => name.includes(h));
  }) || null;
}

/** Resolve by Settings alias id first, then name hints. Stale ids fall through. */
function resolveNamedCategory(categories, aliasId, hints) {
  if (aliasId) {
    const byId = categories.find(c => c.id === aliasId);
    if (byId) return { cat: byId, source: 'alias' };
    // Alias points at a deleted envelope — ignore and try name match
  }
  const byName = findCategoryByNameHint(categories, hints);
  return byName ? { cat: byName, source: 'name' } : { cat: null, source: 'none' };
}

function buildPaydayBrief(month) {
  const today = todayISO();
  const payStatus = store.getPaycheckStatus(month);
  const upcoming = [];

  payStatus.forEach(p => {
    (p.upcoming || []).forEach(c => {
      if (!c.date || c.date < today) return;
      upcoming.push({
        sourceId: p.id,
        source: p.name,
        date: c.date,
        amount: round2(c.amount || p.perCheck || 0),
      });
    });
    (p.checks || []).forEach(c => {
      if (!c.date || c.date < today) return;
      if (c.status === 'received') return;
      upcoming.push({
        sourceId: p.id,
        source: p.name,
        date: c.date,
        amount: round2(c.receivedAmount || c.amount || p.perCheck || 0),
        status: c.status,
      });
    });
  });

  // Dedupe by source+date
  const seen = new Set();
  const unique = upcoming.filter(c => {
    const key = `${c.sourceId}|${c.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.date.localeCompare(b.date));

  const next = unique[0] || null;
  const horizon = next?.date || null;

  const allUpcomingBills = store.getUpcomingBills(45);
  const billsBeforePay = horizon
    ? allUpcomingBills.filter(b => {
        const due = String(b.dueDate || '').slice(0, 10);
        if (!due) return true;
        return due <= horizon;
      })
    : store.getUpcomingBills(14);

  const billsTotal = round2(billsBeforePay.reduce((s, b) => s + (Number(b.amount) || 0), 0));
  const remainingMins = round2(store.getRemainingMinDebtPaymentsOutsideBudget(month));
  const nextAmount = next ? next.amount : 0;
  const afterBills = next ? round2(nextAmount - billsTotal) : null;
  const afterBillsAndMins = next ? round2(nextAmount - billsTotal - remainingMins) : null;

  return {
    next,
    upcoming: unique.slice(0, 6),
    billsBeforePay: billsBeforePay.map(b => ({
      id: b.id,
      name: b.name,
      amount: round2(b.amount),
      dueDate: b.dueDate,
      daysLeft: b.daysLeft,
    })),
    billsTotal,
    remainingMinsOutsideBudget: remainingMins,
    afterBills,
    afterBillsAndMins,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.month]
 * @returns {object} advisor snapshot
 */
export function buildAdvisorSnapshot(opts = {}) {
  const month = opts.month || getCurrentMonth();
  const prevMonth = getPreviousMonth(month);
  const state = store.getState();
  const categories = (state.categories || []).filter(c => !c.parentId);

  const plannedIncome = round2(store.getTotalIncome(month));
  const loggedIncome = round2(store.getTotalIncomeLogged(month));
  const bonusLogged = round2(store.getBonusIncomeLogged(month));
  const budgeted = round2(store.getTotalBudgeted());
  const spent = round2(store.getTotalSpent(month));
  const toAllocate = round2(store.getToAllocate());
  const surplus = round2(store.getSurplusForSnowball(month));
  const surplusBasis = store.getSurplusBasis(month);
  const babyStep = store.detectBabyStep();
  const babyMeta = BABY_STEPS.find(s => s.step === babyStep) || null;
  const target = store.getSnowballTarget();
  const activeDebts = store.getActiveDebts();
  const totalDebt = round2(store.getTotalDebt());
  const monthsToDebtFree = store.estimateMonthsToDebtFree();
  const inbox = store.getReviewInbox(month);
  const monthClose = store.getMonthCloseStatus(month);
  const upcomingBills = store.getUpcomingBills(7);
  const overCap = store.getEnvelopesOverSoftCap();
  const ef = round2(state.balances?.emergencyFund);
  const checking = round2(state.balances?.checking);

  const envelopes = categories.map(c => {
    const budgetedAmt = round2(c.monthlyBudget);
    const spentAmt = round2(store.getCategorySpent(c.id, month));
    const remaining = round2(store.getCategoryRemaining(c.id, month));
    const prevSpent = round2(store.getCategorySpent(c.id, prevMonth));
    const goal = round2(store.getCategoryGoal(c.id));
    const health = store.getEnvelopeHealth(c.id, month);
    return {
      id: c.id,
      name: c.name,
      icon: c.icon || '✉️',
      isSinkingFund: !!c.isSinkingFund,
      budgeted: budgetedAmt,
      spent: spentAmt,
      remaining,
      prevSpent,
      delta: round2(spentAmt - prevSpent),
      goal,
      health,
      carryOver: round2(c.carryOver),
    };
  });

  const hotEnvelopes = envelopes
    .filter(e => !e.isSinkingFund && (e.health === 'over' || e.health === 'depleted' || e.health === 'warning' || e.remaining < 0))
    .sort((a, b) => a.remaining - b.remaining);

  const risingEnvelopes = envelopes
    .filter(e => !e.isSinkingFund && e.delta > 5)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 6);

  const aliases = state.settings?.advisorAliases || {};
  const diningRes = resolveNamedCategory(categories, aliases.dining, ['eating out', 'dining', 'fast food', 'restaurants']);
  const vacationRes = resolveNamedCategory(categories, aliases.vacation, ['vacation', 'travel', 'holiday trip']);
  const christmasRes = resolveNamedCategory(categories, aliases.christmas, ['christmas', 'xmas', 'holiday gift']);
  const dining = diningRes.cat;
  const vacation = vacationRes.cat;
  const christmas = christmasRes.cat;

  const sinkingFunds = envelopes
    .filter(e => e.isSinkingFund)
    .map(e => ({
      ...e,
      progress: e.goal > 0 ? Math.min(1, (e.remaining) / e.goal) : null,
      shortfall: e.goal > 0 ? Math.max(0, round2(e.goal - e.remaining)) : 0,
    }));

  const payday = buildPaydayBrief(month);
  const efTarget = round2(store.getEmergencyFundTarget());

  const debts = activeDebts.map((d, i) => ({
    id: d.id,
    name: d.name,
    balance: round2(d.balance),
    minPayment: round2(d.minPayment),
    interestRate: Number(d.interestRate) || 0,
    order: i + 1,
    isTarget: i === 0,
    snowballPayment: round2(store.getSnowballPayment(d)),
  }));

  const billsNext7 = upcomingBills.map(b => ({
    id: b.id,
    name: b.name,
    amount: round2(b.amount),
    dueDate: b.dueDate,
    daysLeft: b.daysLeft,
    status: b.status,
  }));

  const attention = [];
  if (inbox.pending?.length) {
    attention.push({
      id: 'pending',
      priority: 10,
      label: `${inbox.pending.length} transaction(s) awaiting bank confirmation`,
      count: inbox.pending.length,
      page: 'transactions',
      action: 'pending',
      buttonLabel: 'Review',
    });
  }
  if (inbox.uncategorized.length) {
    attention.push({
      id: 'uncategorized',
      priority: 20,
      label: `${inbox.uncategorized.length} expense(s) need a category`,
      count: inbox.uncategorized.length,
      page: 'transactions',
      action: 'review',
      buttonLabel: 'Categorize',
    });
  }
  if (inbox.billMatches.length) {
    attention.push({
      id: 'bills',
      priority: 30,
      label: `${inbox.billMatches.length} possible bill match(es) to confirm`,
      count: inbox.billMatches.length,
      page: 'bills',
      action: 'bill-matches',
      buttonLabel: 'Match',
    });
  }
  // Money leftover: To Allocate and snowball surplus are often the same pool
  // (when surplus is driven by unassigned income). Don't list that twice.
  const sameLeftoverPool = toAllocate > 0.01
    && surplus > 0
    && Math.abs(surplus - toAllocate) < 0.02;
  const snowballTargetName = target?.name || null;

  if (toAllocate < -0.01) {
    attention.push({
      id: 'allocate',
      priority: 40,
      label: `Over-assigned by ${formatPlain(Math.abs(toAllocate))} — trim envelopes or fix income`,
      count: toAllocate,
      page: 'budget',
      action: null,
      buttonLabel: 'Budget',
    });
  } else if (sameLeftoverPool) {
    attention.push({
      id: 'leftover',
      priority: 40,
      label: debts.length
        ? `${formatPlain(toAllocate)} unassigned — put in Budget or on ${snowballTargetName || 'the snowball'}`
        : `${formatPlain(toAllocate)} unassigned — put every dollar in Budget`,
      count: toAllocate,
      page: 'budget',
      action: debts.length ? 'leftover-plan' : null,
      buttonLabel: debts.length ? 'Plan' : 'Budget',
      hasDebts: debts.length > 0,
      targetName: snowballTargetName,
    });
  } else {
    if (toAllocate > 0.01) {
      attention.push({
        id: 'allocate',
        priority: 40,
        label: `${formatPlain(toAllocate)} still needs a job (To Allocate)`,
        count: toAllocate,
        page: 'budget',
        action: null,
        buttonLabel: 'Budget',
      });
    }
    // Only list snowball separately when it's a different / extra pool
    if (surplus > 0.01 && debts.length) {
      const extra = toAllocate > 0.01 ? round2(surplus - toAllocate) : surplus;
      attention.push({
        id: 'snowball',
        priority: 70,
        label: toAllocate > 0.01 && extra > 0.01
          ? `${formatPlain(surplus)} snowball room (${formatPlain(extra)} beyond To Allocate) → ${snowballTargetName || 'debt'}`
          : `${formatPlain(surplus)} ready for snowball${snowballTargetName ? ` → ${snowballTargetName}` : ''}`,
        count: surplus,
        page: 'debt',
        action: 'allocate-surplus',
        buttonLabel: 'Allocate',
      });
    }
  }

  if (overCap.length) {
    attention.push({
      id: 'caps',
      priority: 50,
      label: `${overCap.length} envelope(s) over soft cap / goal`,
      count: overCap.length,
      page: 'budget',
      action: 'attention',
      buttonLabel: 'Review',
    });
  }
  if (billsNext7.length) {
    attention.push({
      id: 'upcoming-bills',
      priority: 60,
      label: `${billsNext7.length} bill(s) due within 7 days`,
      count: billsNext7.length,
      page: 'bills',
      action: null,
      buttonLabel: 'Bills',
    });
  }

  attention.sort((a, b) => a.priority - b.priority);

  return {
    asOf: todayISO(),
    month,
    monthLabel: getMonthLabel(month),
    prevMonth,
    prevMonthLabel: getMonthLabel(prevMonth),
    mode: {
      daveRamsey: store.isDaveRamseyMode(),
      babyStep,
      babyStepTitle: babyMeta?.title || `Baby Step ${babyStep}`,
      babyStepDescription: babyMeta?.description || '',
      surplusBasis,
      usesLoggedIncome: store.usesLoggedIncomeForSurplus(month),
    },
    balances: {
      checking,
      emergencyFund: ef,
      emergencyFundTarget: efTarget,
      emergencyFundShortfall: Math.max(0, round2(efTarget - ef)),
    },
    cashflow: {
      plannedIncome,
      loggedIncome,
      bonusLogged,
      budgeted,
      spent,
      toAllocate,
      surplus,
      prevSpentTotal: round2(
        categories.reduce((s, c) => s + store.getCategorySpent(c.id, prevMonth), 0)
      ),
    },
    payday,
    envelopes,
    hotEnvelopes,
    risingEnvelopes,
    sinkingFunds,
    aliases: {
      dining: aliases.dining || null,
      vacation: aliases.vacation || null,
      christmas: aliases.christmas || null,
    },
    named: {
      dining: dining
        ? { ...(envelopes.find(e => e.id === dining.id) || { id: dining.id, name: dining.name }), matchSource: diningRes.source }
        : null,
      vacation: vacation
        ? {
            ...(sinkingFunds.find(e => e.id === vacation.id)
              || envelopes.find(e => e.id === vacation.id)
              || { id: vacation.id, name: vacation.name }),
            matchSource: vacationRes.source,
          }
        : null,
      christmas: christmas
        ? {
            ...(sinkingFunds.find(e => e.id === christmas.id)
              || envelopes.find(e => e.id === christmas.id)
              || { id: christmas.id, name: christmas.name }),
            matchSource: christmasRes.source,
          }
        : null,
    },
    billsNext7,
    debts,
    totalDebt,
    snowballTarget: target
      ? {
          id: target.id,
          name: target.name,
          balance: round2(target.balance),
          minPayment: round2(target.minPayment),
          payment: round2(store.getSnowballPayment(target)),
        }
      : null,
    monthsToDebtFree,
    inbox: {
      uncategorized: inbox.uncategorized.length,
      billMatches: inbox.billMatches.length,
      duplicates: inbox.duplicates?.length || 0,
      pending: inbox.pending?.length || 0,
      totalCount: inbox.totalCount || 0,
    },
    monthClose: {
      alreadyClosed: monthClose.alreadyClosed,
      steps: monthClose.steps,
      incomplete: monthClose.steps.filter(s => !s.done),
    },
    attention,
  };
}

function formatPlain(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
}
