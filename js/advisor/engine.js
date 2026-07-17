/**
 * Deterministic Advisor engine — pure math + rules over a snapshot.
 * No network. No mutations.
 */
import { formatCurrency, addMonths, getMonthLabel, formatDate, todayISO } from '../utils.js';
import { store } from '../store.js';
import { buildAdvisorSnapshot } from './context.js';

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @typedef {{ label: string, page?: string, arg?: any, action?: string, focusId?: string, targetName?: string }} AdvisorAction
 * @typedef {{
 *   id: string,
 *   title: string,
 *   paragraphs: string[],
 *   bullets?: string[],
 *   metrics?: { label: string, value: string, tone?: string }[],
 *   actions?: AdvisorAction[],
 * }} AdvisorAnswer
 */

export const ADVISOR_CHIPS = [
  { id: 'situation', label: "What's our situation this month?" },
  { id: 'payday', label: 'Payday brief' },
  { id: 'afford', label: 'Can we afford $___?' },
  { id: 'surplus_split', label: 'How should we split surplus?' },
  { id: 'snowball', label: 'If surplus goes to the snowball…' },
  { id: 'cut_dining', label: 'What if we cut dining 20%?' },
  { id: 'month_close', label: 'Explain month-close status' },
  { id: 'hot_envelopes', label: 'Which envelopes are hot right now?' },
  { id: 'fund_first', label: 'Vacation vs Christmas — fund first?' },
];

/**
 * @param {string} chipId
 * @param {{ amount?: number, cutPct?: number, snapshot?: object }} [opts]
 * @returns {AdvisorAnswer}
 */
export function answerChip(chipId, opts = {}) {
  const snap = opts.snapshot || buildAdvisorSnapshot();
  switch (chipId) {
    case 'situation':
      return answerSituation(snap);
    case 'payday':
      return answerPayday(snap);
    case 'afford':
      return answerAfford(snap, Number(opts.amount) || 0);
    case 'surplus_split':
      return answerSurplusSplit(snap);
    case 'snowball':
      return answerSnowball(snap);
    case 'cut_dining':
      return answerCutDining(snap, opts.cutPct != null ? Number(opts.cutPct) : 20);
    case 'month_close':
      return answerMonthClose(snap);
    case 'hot_envelopes':
      return answerHotEnvelopes(snap);
    case 'fund_first':
      return answerFundFirst(snap);
    default:
      return {
        id: 'unknown',
        title: 'Unknown question',
        paragraphs: ['Pick a question chip above — this coach only answers the built-in set for now.'],
        actions: [],
      };
  }
}

/**
 * Format an answer as plain text for a sticky note.
 * @param {AdvisorAnswer} answer
 */
export function formatAnswerForNotes(answer) {
  const lines = [];
  if (answer.title) lines.push(answer.title, '');
  (answer.paragraphs || []).forEach(p => { if (p) lines.push(p); });
  if (answer.bullets?.length) {
    lines.push('');
    answer.bullets.forEach(b => lines.push(`• ${b}`));
  }
  if (answer.metrics?.length) {
    lines.push('');
    answer.metrics.forEach(m => lines.push(`${m.label}: ${m.value}`));
  }
  lines.push('', `Saved from Advisor · ${todayISO()}`);
  return lines.join('\n').trim();
}

/**
 * Save the current answer as a sticky on an "Advisor plans" board.
 * @param {AdvisorAnswer} answer
 * @returns {{ boardId: string, noteId: string }}
 */
export function saveAnswerToNotes(answer) {
  const boards = store.getNoteBoards();
  let board = boards.find(b => /^advisor\s*plans$/i.test(String(b.title || '').trim()));
  let boardId = board?.id;
  if (!boardId) {
    boardId = store.addNoteBoard('Advisor plans');
  }
  const noteId = store.addStickyNote(boardId, {
    title: (answer.title || 'Advisor plan').slice(0, 80),
    text: formatAnswerForNotes(answer),
    color: 'blue',
  });
  return { boardId, noteId };
}

function answerPayday(snap) {
  const pd = snap.payday || {};
  const next = pd.next;

  if (!next) {
    return {
      id: 'payday',
      title: 'No upcoming paycheck on the calendar',
      paragraphs: [
        'Couldn’t find a future pay date on your income sources. Add or update pay dates under Income & Balances, then try again.',
      ],
      actions: [
        { label: 'Income & Balances', page: 'income' },
        { label: 'Bills', page: 'bills' },
      ],
    };
  }

  const checking = pd.checking ?? 0;
  const cashThroughPay = pd.cashThroughPay ?? r2(checking + next.amount);

  const paragraphs = [
    `Next paycheck: ${next.source} on ${formatDate(next.date)} for about ${formatCurrency(next.amount)}.`,
    `Checking now: ${formatCurrency(checking)} · cash through payday (checking + check): ${formatCurrency(cashThroughPay)}.`,
    pd.billsBeforePay?.length
      ? `${pd.billsBeforePay.length} bill(s) due on or before that day, totaling ${formatCurrency(pd.billsTotal)}.`
      : 'No unpaid bills due on or before that paycheck.',
  ];

  if (pd.remainingMinsOutsideBudget > 0) {
    paragraphs.push(
      `Debt minimums still due this month (not already in envelopes): ${formatCurrency(pd.remainingMinsOutsideBudget)}.`
    );
  }

  if (pd.afterBills != null) {
    paragraphs.push(
      `Rough room after those bills: ${formatCurrency(pd.afterBills)}`
      + ` (checking ${formatCurrency(checking)} + check ${formatCurrency(next.amount)} − bills ${formatCurrency(pd.billsTotal || 0)})`
      + (pd.remainingMinsOutsideBudget > 0
        ? ` · after bills + outside-budget mins: ${formatCurrency(pd.afterBillsAndMins)}.`
        : '.')
    );
    paragraphs.push(
      'This is not a full budget — groceries, gas, and other envelopes still apply. Checking is your logged balance under Income & Balances.'
    );
  }

  const bullets = [
    ...(pd.billsBeforePay || []).slice(0, 8).map(b =>
      `${b.name}: ${formatCurrency(b.amount)} · ${b.dueDate ? formatDate(b.dueDate) : 'no due date'}`
      + (b.daysLeft < 0 ? ' (overdue)' : b.daysLeft === 0 ? ' (today)' : '')
    ),
    ...(pd.upcoming || []).slice(1, 4).map(c =>
      `Later pay: ${c.source} · ${formatDate(c.date)} · ${formatCurrency(c.amount)}`
    ),
  ];

  return {
    id: 'payday',
    title: `Payday brief · ${formatDate(next.date)}`,
    paragraphs,
    bullets: bullets.length ? bullets : undefined,
    metrics: [
      { label: 'Checking', value: formatCurrency(checking), tone: '' },
      { label: 'Next check', value: formatCurrency(next.amount), tone: 'accent' },
      { label: 'Bills before', value: formatCurrency(pd.billsTotal || 0), tone: '' },
      {
        label: 'After bills',
        value: formatCurrency(pd.afterBills ?? 0),
        tone: (pd.afterBills ?? 0) >= 0 ? 'positive' : 'negative',
      },
    ],
    actions: [
      { label: 'Income & Balances', page: 'income' },
      { label: 'Bills', page: 'bills' },
      { label: 'Budget', page: 'budget' },
    ],
  };
}

function answerSurplusSplit(snap) {
  const surplus = snap.cashflow.surplus;
  const step = snap.mode.babyStep;
  const ef = snap.balances.emergencyFund;
  const efTarget = snap.balances.emergencyFundTarget || 1000;
  const efShort = Math.max(0, r2(efTarget - ef));
  const target = snap.snowballTarget;
  const vac = snap.named.vacation;
  const xmas = snap.named.christmas;
  const monthNum = Number(String(snap.month).slice(5, 7));
  const christmasSoon = monthNum >= 9 || monthNum === 1;

  if (surplus <= 0.01) {
    return {
      id: 'surplus_split',
      title: 'No free surplus to split',
      paragraphs: [
        'Snowball surplus is $0 right now. Finish To Allocate / cash flow first, then come back for a split plan.',
      ],
      metrics: [
        { label: 'Surplus', value: formatCurrency(0), tone: '' },
        { label: 'Baby Step', value: String(step), tone: 'accent' },
      ],
      actions: [
        { label: 'Open Budget', page: 'budget' },
        { label: 'Do these next', action: 'scroll-priority' },
      ],
    };
  }

  let left = surplus;
  const rows = [];

  const take = (label, amount, note) => {
    const amt = r2(Math.min(left, Math.max(0, amount)));
    if (amt <= 0.005) return 0;
    rows.push({ label, amount: amt, note: note || '' });
    left = r2(left - amt);
    return amt;
  };

  if (step <= 1) {
    take('Starter emergency fund (to $1,000)', Math.min(efShort, left) || (ef < 1000 ? 1000 - ef : 0),
      ef < 1000 ? `EF now ${formatCurrency(ef)}` : 'Starter EF already at/above $1,000');
    if (left > 0 && target) {
      take(`Debt snowball → ${target.name}`, left, 'Only after starter EF is full');
    } else if (left > 0) {
      take('Hold / true expenses', left, 'No active consumer debt');
    }
  } else if (step === 2) {
    // Gazelle intensity: snowball first; small seasonal carve-out if holiday fund is short
    let seasonal = 0;
    if (christmasSoon && xmas && (xmas.shortfall || 0) > 0) {
      seasonal = r2(Math.min(left * 0.1, xmas.shortfall, left));
    }
    if (seasonal > 0) {
      take(`${xmas.name} (seasonal 10% max)`, seasonal, 'Keeps Christmas from hitting the cards');
    }
    if (left > 0 && target) {
      take(`Debt snowball → ${target.name}`, left, 'Baby Step 2 default: attack debt');
    } else if (left > 0) {
      take('Emergency fund / sinking funds', left, 'No active debt target');
    }
  } else {
    // Step 3+: fill EF to target, then sinking shortfalls, then extra
    if (efShort > 0) {
      take('Full emergency fund', efShort, `Target ${formatCurrency(efTarget)} · now ${formatCurrency(ef)}`);
    }
    const funds = [vac, xmas].filter(f => f && (f.shortfall || 0) > 0);
    funds.sort((a, b) => (a.shortfall || 0) - (b.shortfall || 0));
    funds.forEach(f => {
      if (left <= 0) return;
      take(f.name, f.shortfall, f.goal ? `Goal ${formatCurrency(f.goal)}` : 'Sinking fund');
    });
    if (left > 0) {
      take(target ? `Extra → ${target.name} / wealth building` : 'Wealth building / giving', left,
        'After EF and priority sinking funds');
    }
  }

  if (!rows.length) {
    rows.push({ label: 'Unassigned surplus', amount: surplus, note: 'Could not build a split — check EF and debts' });
  }

  const paragraphs = [
    `Baby Step ${step} (${snap.mode.babyStepTitle}) · free surplus ${formatCurrency(surplus)}.`,
    'Rule-based split only — not advice, and it never moves money until you act.',
  ];

  return {
    id: 'surplus_split',
    title: 'Surplus split plan',
    paragraphs,
    bullets: rows.map(r =>
      `${formatCurrency(r.amount)} → ${r.label}${r.note ? ` (${r.note})` : ''}`
    ),
    metrics: [
      { label: 'Surplus', value: formatCurrency(surplus), tone: 'positive' },
      { label: 'Baby Step', value: String(step), tone: 'accent' },
      { label: 'EF gap', value: formatCurrency(efShort), tone: efShort > 0 ? 'warning' : 'positive' },
    ],
    actions: [
      target && rows.some(r => /snowball|debt/i.test(r.label))
        ? { label: 'Allocate surplus', action: 'allocate-surplus' }
        : null,
      { label: 'Open Budget', page: 'budget' },
      { label: 'Income & Balances', page: 'income' },
    ].filter(Boolean),
  };
}

function answerSituation(snap) {
  const { cashflow: c, mode, snowballTarget, totalDebt, monthsToDebtFree } = snap;
  const spendDelta = r2(c.spent - c.prevSpentTotal);
  const paragraphs = [
    `As of ${snap.asOf}, we're on Baby Step ${mode.babyStep} — ${mode.babyStepTitle}. ${mode.babyStepDescription}`,
    mode.daveRamsey
      ? 'Dave Ramsey mode is on: every dollar should have a job (To Allocate near $0).'
      : 'Dave Ramsey mode is off — zero-based budgeting is still available as a guide.',
  ];

  const bullets = [
    `Planned income: ${formatCurrency(c.plannedIncome)} · Logged: ${formatCurrency(c.loggedIncome)}${c.bonusLogged ? ` (+${formatCurrency(c.bonusLogged)} bonus)` : ''}`,
    `Budgeted: ${formatCurrency(c.budgeted)} · Spent so far: ${formatCurrency(c.spent)}`,
    `To Allocate: ${formatCurrency(c.toAllocate)} · Snowball surplus: ${formatCurrency(c.surplus)} (${basisLabel(mode.surplusBasis, mode.usesLoggedIncome)})`,
    totalDebt > 0
      ? `Total consumer debt: ${formatCurrency(totalDebt)}${snowballTarget ? ` · Target: ${snowballTarget.name} (${formatCurrency(snowballTarget.balance)})` : ''}`
      : 'No active consumer debts — nice work.',
    totalDebt > 0 && monthsToDebtFree > 0
      ? `At today's surplus + minimums, rough debt-free ETA: ~${monthsToDebtFree} month${monthsToDebtFree === 1 ? '' : 's'}.`
      : null,
    `Spending vs ${snap.prevMonthLabel}: ${spendDelta === 0 ? 'flat' : `${spendDelta > 0 ? '+' : ''}${formatCurrency(spendDelta)}`}.`,
  ].filter(Boolean);

  return {
    id: 'situation',
    title: `${snap.monthLabel} — household snapshot`,
    paragraphs,
    bullets,
    metrics: [
      { label: 'To Allocate', value: formatCurrency(c.toAllocate), tone: Math.abs(c.toAllocate) < 0.01 ? 'positive' : 'warning' },
      { label: 'Surplus', value: formatCurrency(c.surplus), tone: c.surplus > 0 ? 'accent' : '' },
      { label: 'Spent', value: formatCurrency(c.spent), tone: '' },
      { label: 'Debt', value: formatCurrency(totalDebt), tone: totalDebt > 0 ? 'negative' : 'positive' },
    ],
    actions: [
      { label: 'Open Budget', page: 'budget' },
      { label: 'Open Debt', page: 'debt' },
      { label: 'Reports', page: 'reports' },
    ],
  };
}

function answerAfford(snap, amount) {
  const amt = r2(amount);
  if (!(amt > 0)) {
    return {
      id: 'afford',
      title: 'Can we afford it?',
      paragraphs: [
        'Enter a dollar amount above, then run this question again. We’ll check surplus, loose envelope room, and sinking funds.',
      ],
      actions: [{ label: 'Open Budget', page: 'budget' }],
    };
  }

  const surplus = snap.cashflow.surplus;
  const vacation = snap.named.vacation;
  const flexible = snap.envelopes
    .filter(e => !e.isSinkingFund && e.remaining > 0 && e.health !== 'over')
    .sort((a, b) => b.remaining - a.remaining);
  const flexibleTotal = r2(flexible.reduce((s, e) => s + Math.max(0, e.remaining), 0));

  const paths = [];
  if (vacation && vacation.remaining >= amt) {
    paths.push({
      ok: true,
      rank: 1,
      kind: 'vacation',
      label: `Yes — use ${vacation.name} sinking fund (${formatCurrency(vacation.remaining)} available).`,
    });
  }
  if (surplus >= amt) {
    paths.push({
      ok: true,
      rank: 2,
      kind: 'surplus',
      label: `Yes — cover from snowball surplus (${formatCurrency(surplus)} free). This pauses / reduces extra debt payment this month.`,
    });
  }
  if (flexibleTotal >= amt) {
    const top = flexible.slice(0, 3).map(e => `${e.name} (${formatCurrency(e.remaining)})`).join(', ');
    paths.push({
      ok: true,
      rank: 3,
      kind: 'envelopes',
      label: `Maybe — trim discretionary envelopes (about ${formatCurrency(flexibleTotal)} room). Strongest cushions: ${top}.`,
    });
  }

  const best = paths.sort((a, b) => a.rank - b.rank)[0];
  const ok = !!best;
  const paragraphs = [
    ok
      ? `For ${formatCurrency(amt)}: ${best.label}`
      : `For ${formatCurrency(amt)}: not comfortably this month without new income or cutting deeper than remaining cushions.`,
  ];

  if (!ok) {
    paragraphs.push(
      `Available surplus: ${formatCurrency(surplus)}. Discretionary envelope room: ${formatCurrency(flexibleTotal)}.`
      + (vacation ? ` ${vacation.name} fund: ${formatCurrency(vacation.remaining)}.` : '')
    );
  } else if (paths.length > 1) {
    paragraphs.push('Other paths:');
  }

  const bullets = ok && paths.length > 1
    ? paths.slice(1).map(p => p.label)
    : [
        `Snowball surplus: ${formatCurrency(surplus)}`,
        `Discretionary remaining (sum): ${formatCurrency(flexibleTotal)}`,
        vacation
          ? `${vacation.name}: ${formatCurrency(vacation.remaining)}${vacation.goal ? ` toward ${formatCurrency(vacation.goal)} goal` : ''}`
          : 'No Vacation-style sinking fund found by name.',
      ];

  if (snap.inbox.totalCount > 5) {
    paragraphs.push(
      `Heads-up: ${snap.inbox.totalCount} items still need review. Clean the inbox before a big yes — the picture may shift.`
    );
  }

  const vacationWins = best?.kind === 'vacation';
  const surplusWins = best?.kind === 'surplus';

  return {
    id: 'afford',
    title: ok ? `Yes path for ${formatCurrency(amt)}` : `Hold on ${formatCurrency(amt)}`,
    paragraphs,
    bullets,
    metrics: [
      { label: 'Ask', value: formatCurrency(amt), tone: 'accent' },
      { label: 'Surplus', value: formatCurrency(surplus), tone: surplus >= amt ? 'positive' : '' },
      { label: 'Envelope room', value: formatCurrency(flexibleTotal), tone: '' },
    ],
    actions: [
      vacationWins
        ? { label: `Open ${vacation.name}`, page: 'budget', focusId: vacation.id }
        : null,
      surplusWins && snap.debts.length
        ? { label: 'Allocate surplus to snowball', action: 'allocate-surplus' }
        : null,
      !vacationWins && vacation
        ? { label: `Open ${vacation.name}`, page: 'budget', focusId: vacation.id }
        : null,
      { label: 'Open Budget', page: 'budget' },
      { label: 'Debt snowball', page: 'debt' },
    ].filter(Boolean),
  };
}

function answerSnowball(snap) {
  const surplus = snap.cashflow.surplus;
  const target = snap.snowballTarget;
  if (!target) {
    return {
      id: 'snowball',
      title: 'No snowball target',
      paragraphs: [
        'There are no active consumer debts. If Baby Step 3 is next, point surplus at the emergency fund instead.',
      ],
      metrics: [
        { label: 'EF', value: formatCurrency(snap.balances.emergencyFund), tone: 'accent' },
        { label: 'Surplus', value: formatCurrency(surplus), tone: surplus > 0 ? 'positive' : '' },
      ],
      actions: [
        { label: 'Income & Balances', page: 'income' },
        { label: 'Budget', page: 'budget' },
      ],
    };
  }

  const pay = r2(target.minPayment + surplus);
  const monthsOnTarget = pay > 0 ? Math.ceil(target.balance / pay) : null;
  const etaMonth = monthsOnTarget
    ? getMonthLabel(addMonths(snap.month, monthsOnTarget))
    : null;

  const paragraphs = [
    `Current target: ${target.name} at ${formatCurrency(target.balance)} (min ${formatCurrency(target.minPayment)}).`,
    surplus > 0
      ? `If we throw ${formatCurrency(surplus)} surplus on top of the minimum, the payment is about ${formatCurrency(pay)} this month.`
      : 'Surplus is $0 right now — the snowball is minimums only until To Allocate / cash flow frees up.',
  ];

  if (monthsOnTarget != null && monthsOnTarget < 600) {
    paragraphs.push(
      `Rough payoff for this debt alone at that pace: ~${monthsOnTarget} month${monthsOnTarget === 1 ? '' : 's'}`
      + (etaMonth ? ` (around ${etaMonth}, if surplus holds).` : '.')
    );
  }

  if (snap.monthsToDebtFree > 0 && snap.monthsToDebtFree < 600) {
    paragraphs.push(
      `Whole snowball (all debts, today’s surplus every month): roughly ${snap.monthsToDebtFree} month${snap.monthsToDebtFree === 1 ? '' : 's'} to consumer debt free.`
    );
  }

  paragraphs.push('This ignores interest compounding detail — treat it as a planning sketch, not a bank payoff letter.');

  return {
    id: 'snowball',
    title: `Snowball → ${target.name}`,
    paragraphs,
    bullets: snap.debts.slice(0, 5).map(d =>
      `${d.order}. ${d.name}: ${formatCurrency(d.balance)} (min ${formatCurrency(d.minPayment)}${d.isTarget ? ` + ${formatCurrency(surplus)} extra` : ''})`
    ),
    metrics: [
      { label: 'Target', value: formatCurrency(target.balance), tone: 'accent' },
      { label: 'This payment', value: formatCurrency(pay), tone: 'positive' },
      { label: 'Surplus', value: formatCurrency(surplus), tone: '' },
    ],
    actions: [
      surplus > 0
        ? { label: 'Allocate surplus', action: 'allocate-surplus' }
        : null,
      { label: 'Open Debt', page: 'debt' },
      { label: 'Open Budget', page: 'budget' },
    ].filter(Boolean),
  };
}

function answerCutDining(snap, cutPct) {
  const pct = Math.min(100, Math.max(1, Number(cutPct) || 20));
  const dining = snap.named.dining;
  if (!dining) {
    return {
      id: 'cut_dining',
      title: 'No Eating Out envelope found',
      paragraphs: [
        'Couldn’t find an envelope whose name looks like Eating Out / Dining / Fast Food. Rename or create one, then try again.',
      ],
      actions: [{ label: 'Open Budget', page: 'budget' }],
    };
  }

  const base = dining.budgeted > 0 ? dining.budgeted : dining.spent;
  const savings = r2(base * (pct / 100));
  const newBudget = r2(Math.max(0, (dining.budgeted || base) - savings));
  const newSurplus = r2(snap.cashflow.surplus + savings);
  const target = snap.snowballTarget;
  const pay = target ? r2(target.minPayment + newSurplus) : null;
  const months = target && pay > 0 ? Math.ceil(target.balance / pay) : null;
  const monthsNow = target
    ? (() => {
        const p = r2(target.minPayment + snap.cashflow.surplus);
        return p > 0 ? Math.ceil(target.balance / p) : null;
      })()
    : null;

  const paragraphs = [
    `${dining.icon} ${dining.name}: budgeted ${formatCurrency(dining.budgeted)}, spent ${formatCurrency(dining.spent)} this month (${formatCurrency(dining.remaining)} left).`,
    `Cutting ${pct}% of ${formatCurrency(base)} frees about ${formatCurrency(savings)} / month if we stick to it.`,
    `Snowball surplus would rise from ${formatCurrency(snap.cashflow.surplus)} → about ${formatCurrency(newSurplus)}.`,
  ];

  if (target && months != null && monthsNow != null) {
    const gain = monthsNow - months;
    paragraphs.push(
      gain > 0
        ? `On ${target.name}, that could shave ~${gain} month${gain === 1 ? '' : 's'} off the rough payoff (sketch only).`
        : `On ${target.name}, the rough payoff pace barely moves — surplus is already high relative to the balance, or the cut is small.`
    );
  }

  return {
    id: 'cut_dining',
    title: `Cut ${dining.name} by ${pct}%`,
    paragraphs,
    bullets: [
      `New suggested budget: ${formatCurrency(newBudget)} (was ${formatCurrency(dining.budgeted)})`,
      `Vs last month spent: ${formatCurrency(dining.prevSpent)} → watch the habit, not just the envelope number`,
    ],
    metrics: [
      { label: 'Frees', value: formatCurrency(savings), tone: 'positive' },
      { label: 'New surplus', value: formatCurrency(newSurplus), tone: 'accent' },
      { label: 'Now remaining', value: formatCurrency(dining.remaining), tone: dining.remaining < 0 ? 'negative' : '' },
    ],
    actions: [
      { label: `Open ${dining.name}`, page: 'budget', focusId: dining.id },
      { label: 'Debt snowball', page: 'debt' },
    ],
  };
}

function answerMonthClose(snap) {
  const { monthClose, monthLabel } = snap;
  if (monthClose.alreadyClosed && monthClose.incomplete.length === 0) {
    return {
      id: 'month_close',
      title: `${monthLabel} looks closed`,
      paragraphs: [
        'This month is marked closed and the checklist is green. Export a backup when you get a chance if you haven’t recently.',
      ],
      actions: [
        { label: 'Reports', page: 'reports' },
        { label: 'Settings / backup', page: 'settings' },
      ],
    };
  }

  const incomplete = monthClose.incomplete;
  const paragraphs = [
    monthClose.alreadyClosed
      ? `${monthLabel} was marked closed, but ${incomplete.length} checklist item(s) still look open — worth a quick pass.`
      : `${monthLabel} isn’t closed yet. Finish the steps below, then run the month-close checklist.`,
  ];

  const bullets = monthClose.steps.map(s => {
    if (s.done) return `✓ ${s.label}`;
    if (s.id === 'allocate') return `○ ${s.label} — ${formatCurrency(s.count)}`;
    if (s.id === 'surplus' && s.count > 0) return `○ ${s.label} — ${formatCurrency(s.count)} ready`;
    if (s.count) return `○ ${s.label} — ${s.count}`;
    return `○ ${s.label}`;
  });

  return {
    id: 'month_close',
    title: 'Month-close coach',
    paragraphs,
    bullets,
    actions: [
      { label: 'Open month-close checklist', action: 'month-close' },
      incomplete.some(s => s.id === 'review')
        ? { label: 'Review inbox', page: 'transactions', action: 'review' }
        : null,
      incomplete.some(s => s.id === 'allocate' || s.id === 'caps')
        ? { label: 'Budget', page: 'budget', action: 'attention' }
        : null,
      incomplete.some(s => s.id === 'surplus')
        ? { label: 'Allocate surplus', action: 'allocate-surplus' }
        : null,
    ].filter(Boolean),
  };
}

function answerHotEnvelopes(snap) {
  const hot = snap.hotEnvelopes;
  const rising = snap.risingEnvelopes;

  if (!hot.length && !rising.length) {
    return {
      id: 'hot_envelopes',
      title: 'Envelopes look calm',
      paragraphs: [
        'No envelopes are over budget or in the warning zone, and nothing spiked hard vs last month. Keep logging.',
      ],
      actions: [
        { label: 'Budget', page: 'budget' },
        { label: 'Reports', page: 'reports' },
      ],
    };
  }

  const paragraphs = [];
  const bullets = [];

  if (hot.length) {
    paragraphs.push(`${hot.length} envelope(s) need a look (over / depleted / 80%+ used).`);
    hot.slice(0, 8).forEach(e => {
      bullets.push(
        `${e.icon} ${e.name}: ${formatCurrency(e.spent)} spent, ${formatCurrency(e.remaining)} left (${healthLabel(e.health)})`
      );
    });
  }

  if (rising.length) {
    paragraphs.push(`Biggest spend increases vs ${snap.prevMonthLabel}:`);
    rising.forEach(e => {
      bullets.push(
        `${e.icon} ${e.name}: ${formatCurrency(e.prevSpent)} → ${formatCurrency(e.spent)} (${e.delta > 0 ? '+' : ''}${formatCurrency(e.delta)})`
      );
    });
  }

  const topHot = hot[0] || rising[0] || null;

  return {
    id: 'hot_envelopes',
    title: 'Hot envelopes',
    paragraphs,
    bullets,
    actions: [
      topHot
        ? { label: `Open ${topHot.name}`, page: 'budget', focusId: topHot.id }
        : null,
      { label: 'Budget (attention)', page: 'budget', action: 'attention' },
      { label: 'Reports', page: 'reports' },
    ].filter(Boolean),
  };
}

function answerFundFirst(snap) {
  const vac = snap.named.vacation;
  const xmas = snap.named.christmas;
  const surplus = snap.cashflow.surplus;

  if (!vac && !xmas) {
    return {
      id: 'fund_first',
      title: 'No Vacation / Christmas funds found',
      paragraphs: [
        'Looking for sinking funds named like Vacation or Christmas. Add or rename them under Budget, then ask again.',
      ],
      actions: [{ label: 'Open Budget', page: 'budget' }],
    };
  }

  const describe = (fund) => {
    if (!fund) return null;
    const goal = fund.goal || 0;
    const have = fund.remaining;
    const short = goal > 0 ? Math.max(0, r2(goal - have)) : null;
    return {
      fund,
      goal,
      have,
      short,
      line: goal > 0
        ? `${fund.icon} ${fund.name}: ${formatCurrency(have)} on hand, goal ${formatCurrency(goal)} (${formatCurrency(short)} short)`
        : `${fund.icon} ${fund.name}: ${formatCurrency(have)} on hand (no goal set — set a goal for better advice)`,
    };
  };

  const v = describe(vac);
  const c = describe(xmas);
  const bullets = [v?.line, c?.line].filter(Boolean);

  let recommendation;
  if (v && c && v.short != null && c.short != null) {
    if (v.short === 0 && c.short === 0) {
      recommendation = 'Both goals are funded. Park extra surplus on the snowball (or Baby Step 3) instead of overstuffing sinking funds.';
    } else if (v.short === 0) {
      recommendation = `Vacation is funded — prioritize Christmas (${formatCurrency(c.short)} short) until the holiday goal is met.`;
    } else if (c.short === 0) {
      recommendation = `Christmas is funded — you can focus on Vacation (${formatCurrency(v.short)} short) or the snowball.`;
    } else {
      // Deadline heuristic: Christmas is calendar-bound; vacation is flexible unless soon
      const monthNum = Number(String(snap.month).slice(5, 7));
      const christmasSoon = monthNum >= 9 || monthNum === 1;
      if (christmasSoon) {
        recommendation = `Calendar says Christmas is the tighter deadline (Sep–Jan). Fund Christmas first (${formatCurrency(c.short)} short), then Vacation (${formatCurrency(v.short)} short).`;
      } else if (c.short <= v.short) {
        recommendation = `Christmas needs less (${formatCurrency(c.short)} vs ${formatCurrency(v.short)} for Vacation). Finish the smaller goal first for a quick win, then push Vacation.`;
      } else {
        recommendation = `Vacation is further behind (${formatCurrency(v.short)} short vs ${formatCurrency(c.short)} for Christmas). Split surplus 70/30 toward the larger shortfall unless a trip date is soon — then flip it.`;
      }
    }
  } else if (v && !c) {
    recommendation = v.short > 0
      ? `Only Vacation is set up — aim surplus at the ${formatCurrency(v.short)} shortfall, then snowball.`
      : 'Vacation looks funded (or has no goal). Point surplus at debt or emergency fund.';
  } else if (c && !v) {
    recommendation = c.short > 0
      ? `Only Christmas is set up — aim surplus at the ${formatCurrency(c.short)} shortfall before lifestyle spend.`
      : 'Christmas looks funded (or has no goal). Point surplus at debt or emergency fund.';
  }

  const paragraphs = [
    recommendation,
    surplus > 0
      ? `Current snowball surplus to redirect: ${formatCurrency(surplus)} (only after true expenses and minimums are covered).`
      : 'No surplus free this month — funding means trimming envelopes or waiting for the next paycheck.',
  ];

  return {
    id: 'fund_first',
    title: 'Sinking fund priority',
    paragraphs,
    bullets,
    metrics: [
      v ? { label: vac.name, value: formatCurrency(v.have), tone: v.short === 0 ? 'positive' : 'accent' } : null,
      c ? { label: xmas.name, value: formatCurrency(c.have), tone: c.short === 0 ? 'positive' : 'accent' } : null,
      { label: 'Surplus', value: formatCurrency(surplus), tone: '' },
    ].filter(Boolean),
    actions: [
      vac ? { label: `Open ${vac.name}`, page: 'budget', focusId: vac.id } : null,
      xmas ? { label: `Open ${xmas.name}`, page: 'budget', focusId: xmas.id } : null,
      surplus > 0 && snap.debts.length
        ? { label: 'Allocate surplus', action: 'allocate-surplus' }
        : null,
      { label: 'Open Budget', page: 'budget' },
    ].filter(Boolean),
  };
}

/**
 * Pick the most useful chip when opening Advisor (no user choice yet).
 * @param {object} snap
 * @returns {string} chip id
 */
export function pickDefaultChip(snap) {
  // Priority list already covers "what needs attention" — default chip is coaching only.
  const nextPay = snap.payday?.next?.date;
  if (nextPay) {
    const today = new Date(todayISO() + 'T12:00:00');
    const pay = new Date(nextPay + 'T12:00:00');
    const days = Math.ceil((pay - today) / 86400000);
    if (days >= 0 && days <= 3) return 'payday';
  }

  const day = new Date().getDate();
  const incomplete = snap.monthClose?.incomplete?.length || 0;
  if (day >= 25 && incomplete > 0) return 'month_close';

  if ((snap.cashflow?.surplus || 0) > 0 && (snap.debts?.length || 0) > 0) {
    return 'surplus_split';
  }

  return 'situation';
}

function basisLabel(basis, usesLogged) {
  if (basis === 'unallocated') return 'from zero-based leftover';
  if (basis === 'cashflow') return usesLogged ? 'from logged income − spending' : 'from planned income − spending';
  return 'none free yet';
}

function healthLabel(h) {
  return {
    over: 'over budget',
    depleted: 'at limit',
    warning: '80%+ used',
    ok: 'ok',
    none: 'no budget',
  }[h] || h;
}

/**
 * Run an action from an answer (navigation helpers).
 * @param {AdvisorAction} action
 */
export function runAdvisorAction(action) {
  if (!action) return;
  if (action.action === 'month-close') {
    import('../components/month-close.js').then(m => m.openMonthCloseWizard());
    return;
  }
  if (action.action === 'allocate-surplus') {
    import('../pages/dashboard.js').then(m => m.allocateSurplus());
    return;
  }
  if (action.action === 'leftover-plan') {
    openLeftoverPlanChooser(action);
    return;
  }
  if (action.action === 'save-notes' && action.answer) {
    saveAnswerToNotes(action.answer);
    import('../components/modal.js').then(({ showToast }) => {
      showToast('Saved to Notes → Advisor plans', 'success');
    });
    return;
  }
  if (action.action === 'scroll-priority') {
    document.getElementById('advisor-priority')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action.action === 'chip' && action.chipId && typeof window.appNavigate === 'function') {
    window.dispatchEvent(new CustomEvent('advisor-set-chip', { detail: { chipId: action.chipId } }));
    return;
  }
  if (action.action === 'review') {
    import('../components/review-inbox.js').then(m => m.openReviewInbox());
    return;
  }
  if (action.action === 'pending') {
    import('../components/review-inbox.js').then(m => m.openPendingReview());
    return;
  }
  if (action.action === 'bill-matches') {
    import('../components/review-inbox.js').then(m => m.openBillMatches());
    return;
  }
  if (action.page === 'budget' && action.focusId) {
    window.appNavigate('budget', { focusId: action.focusId });
    return;
  }
  if (action.page === 'budget' && action.action === 'attention') {
    window.appNavigate('budget', { filter: 'attention' });
    return;
  }
  if (action.page) {
    window.appNavigate(action.page, action.arg);
  }
}

/** When To Allocate == snowball surplus, let the household pick the path. */
function openLeftoverPlanChooser(action = {}) {
  Promise.all([
    import('../components/modal.js'),
    import('../utils.js'),
  ]).then(([{ showModal }, { el }]) => {
    const target = action.targetName || 'your snowball target';
    const api = { close: () => {} };
    const body = el('div', { className: 'advisor-leftover-chooser' },
      el('p', { style: 'margin-bottom:1rem;line-height:1.45' },
        'This is unassigned income — the same pool as snowball surplus. Pick one path (you can still adjust later):',
      ),
      el('div', { className: 'btn-group', style: 'flex-direction:column;align-items:stretch;gap:0.5rem' },
        el('button', {
          type: 'button',
          className: 'btn btn-primary',
          onClick: () => {
            api.close();
            import('../pages/dashboard.js').then(m => m.allocateSurplus());
          },
        }, `Send to snowball (${target})`),
        el('button', {
          type: 'button',
          className: 'btn btn-secondary',
          onClick: () => {
            api.close();
            window.appNavigate('budget');
          },
        }, 'Assign in Budget (give dollars a job)'),
      ),
    );
    const modal = showModal({ title: 'Plan unassigned money', body });
    api.close = modal.close;
  });
}
