import { getPayDaysInMonth, todayISO, formatLocalISODate } from './utils.js';

export const DEFAULT_RECURRING = { frequency: 'monthly', day1: 1, day2: null };

export function normalizePaySchedule(paySchedule) {
  if (!paySchedule || typeof paySchedule !== 'object') {
    return { mode: 'recurring', checks: [], recurring: { ...DEFAULT_RECURRING }, perCheckAmount: null };
  }
  if (Array.isArray(paySchedule.checks)) {
    const recurring = { ...DEFAULT_RECURRING, ...(paySchedule.recurring || {}) };
    if (!recurring.frequency) recurring.frequency = 'monthly';
    return {
      mode: paySchedule.mode === 'dates' ? 'dates' : 'recurring',
      checks: paySchedule.checks
        .filter(c => c?.date)
        .map(c => ({ date: c.date.slice(0, 10), amount: c.amount != null ? Number(c.amount) : null }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      recurring,
      perCheckAmount: paySchedule.perCheckAmount != null ? Number(paySchedule.perCheckAmount) : null,
    };
  }
  return {
    mode: 'recurring',
    checks: [],
    recurring: {
      frequency: paySchedule.frequency || 'monthly',
      day1: paySchedule.day1 ?? 1,
      day2: paySchedule.day2 ?? null,
    },
    perCheckAmount: null,
  };
}

export function getChecksPerMonthFromRecurring(recurring) {
  const freq = recurring?.frequency || 'monthly';
  if (freq === 'twice_monthly' || freq === 'biweekly') return 2;
  return 1;
}

export function getDefaultPerCheckAmount(source) {
  const sched = normalizePaySchedule(source.paySchedule);
  if (sched.perCheckAmount > 0) return sched.perCheckAmount;
  const total = Number(source.amount) || 0;
  const n = getChecksPerMonthFromRecurring(sched.recurring);
  return n > 0 ? total / n : total;
}

/** Sum of scheduled paycheck amounts for a specific month */
export function getSourceIncomeForMonth(source, month) {
  const checks = getScheduledChecksForMonth(source, month);
  if (checks.length > 0) {
    return checks.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  }
  return Number(source.amount) || 0;
}

export function getScheduledChecksForMonth(source, month) {
  const sched = normalizePaySchedule(source.paySchedule);
  const perCheck = getDefaultPerCheckAmount(source);
  const explicit = sched.checks.filter(c => c.date.startsWith(month));

  if (sched.mode === 'dates' && sched.checks.length) {
    return explicit.map(c => ({
      date: c.date,
      amount: c.amount > 0 ? c.amount : perCheck,
    }));
  }

  if (explicit.length) {
    return explicit.map(c => ({
      date: c.date,
      amount: c.amount > 0 ? c.amount : perCheck,
    }));
  }

  const days = getPayDaysInMonth(month, sched.recurring.day1, sched.recurring.day2);
  return days.map(date => ({ date, amount: perCheck }));
}

export function getUpcomingChecks(source, { fromDate = todayISO(), limit = 6 } = {}) {
  const sched = normalizePaySchedule(source.paySchedule);
  const perCheck = getDefaultPerCheckAmount(source);
  let list = [];

  if (sched.mode === 'dates' && sched.checks.length) {
    list = sched.checks.map(c => ({
      date: c.date,
      amount: c.amount > 0 ? c.amount : perCheck,
    }));
  } else if (sched.checks.length) {
    list = sched.checks.map(c => ({
      date: c.date,
      amount: c.amount > 0 ? c.amount : perCheck,
    }));
  } else {
    const from = new Date(fromDate + 'T12:00:00');
    for (let m = 0; m < 4; m++) {
      const d = new Date(from.getFullYear(), from.getMonth() + m, 1);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      list.push(...getScheduledChecksForMonth(source, month));
    }
  }

  return list
    .filter(c => c.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}

export function getChecksForYear(source, year) {
  const sched = normalizePaySchedule(source.paySchedule);
  const perCheck = getDefaultPerCheckAmount(source);
  return sched.checks
    .filter(c => c.date.startsWith(String(year)))
    .map(c => ({ date: c.date, amount: c.amount > 0 ? c.amount : perCheck }));
}

export function amountsClose(a, b, tolerance = 1.5) {
  return Math.abs(Math.abs(Number(a)) - Math.abs(Number(b))) <= tolerance;
}

export function daysBetween(dateA, dateB) {
  const a = new Date(String(dateA).slice(0, 10) + 'T12:00:00');
  const b = new Date(String(dateB).slice(0, 10) + 'T12:00:00');
  return Math.round((a - b) / 86400000);
}

export function getIncomeMatchTerms(source) {
  const terms = [];
  if (source.name) terms.push(source.name);
  (source.matchTerms || []).forEach(t => {
    if (t && !terms.some(x => x.toLowerCase() === String(t).toLowerCase())) terms.push(t);
  });
  return terms;
}

export function descriptionMatchesIncomeSource(description, source) {
  const desc = String(description || '').toLowerCase();
  if (!desc) return false;
  // Require meaningful terms — ignore ultra-short names that false-positive in bank text
  return getIncomeMatchTerms(source).some(term => {
    const t = String(term || '').toLowerCase().trim();
    if (t.length < 3) return false;
    return desc.includes(t);
  });
}

/**
 * Pick planned income source for a deposit, or Bonus as last resort.
 * opts: { date, amount } — used so real paychecks aren't mis-tagged Bonus
 * when match terms aren't set (which double-counts planned + bonus).
 */
export function resolveIncomeSource(description, incomeSources = [], opts = {}) {
  const planned = (incomeSources || []).filter(src => src && src.type !== 'bonus');
  const bonus = (incomeSources || []).find(src => src?.type === 'bonus') || null;
  const amt = Math.abs(Number(opts.amount)) || 0;
  const iso = opts.date ? String(opts.date).slice(0, 10) : null;

  // 1) Unique bank-description match (match terms + source name)
  const descMatches = planned.filter(src => descriptionMatchesIncomeSource(description, src));
  if (descMatches.length === 1) return descMatches[0];
  if (descMatches.length > 1) {
    return descMatches.sort((a, b) => {
      const aLen = Math.max(0, ...getIncomeMatchTerms(a).map(t => String(t).length));
      const bLen = Math.max(0, ...getIncomeMatchTerms(b).map(t => String(t).length));
      return bLen - aLen;
    })[0];
  }

  // 2) Near a scheduled check (date window + amount) — strongest signal for payroll
  if (amt > 0 && iso) {
    const scored = [];
    planned.forEach(src => {
      const per = getDefaultPerCheckAmount(src);
      const month = iso.slice(0, 7);
      const checks = getScheduledChecksForMonth(src, month);
      checks.forEach(c => {
        const dayDiff = Math.abs(daysBetween(c.date, iso));
        if (dayDiff > 5) return;
        const checkAmt = Number(c.amount) > 0 ? Number(c.amount) : per;
        const tol = Math.max(1.5, Math.abs(checkAmt || per || amt) * 0.03);
        if (checkAmt > 0 && amountsClose(amt, checkAmt, tol)) {
          scored.push({ src, dayDiff, amtDiff: Math.abs(amt - checkAmt) });
          return;
        }
        if (per > 0 && amountsClose(amt, per, tol)) {
          scored.push({ src, dayDiff, amtDiff: Math.abs(amt - per) });
        }
      });
    });
    if (scored.length) {
      scored.sort((a, b) => a.dayDiff - b.dayDiff || a.amtDiff - b.amtDiff);
      const best = scored[0];
      const rival = scored.find(s => s.src.id !== best.src.id);
      if (!rival || best.dayDiff < rival.dayDiff || best.amtDiff + 0.01 < rival.amtDiff) {
        return best.src;
      }
    }
  }

  // 3) Unique typical per-check amount among planned sources
  if (amt > 0) {
    const byAmt = planned.filter(src => {
      const per = getDefaultPerCheckAmount(src);
      if (!(per > 0)) return false;
      const tol = Math.max(1.5, per * 0.03);
      return amountsClose(amt, per, tol);
    });
    if (byAmt.length === 1) return byAmt[0];
  }

  // 4) True unmatched / gifts → Bonus
  return bonus;
}

/** Apply a CSV/logged income deposit to pay schedule amounts */
export function syncPaycheckFromImport(source, date, amount) {
  if (source?.type === 'bonus') {
    return { paySchedule: source.paySchedule, monthlyAmount: 0 };
  }
  const iso = String(date).slice(0, 10);
  const amt = Math.abs(Number(amount)) || 0;
  if (!amt) return { paySchedule: source.paySchedule, monthlyAmount: source.amount };

  const sched = normalizePaySchedule(source.paySchedule);
  const nearIdx = sched.checks.findIndex(c => Math.abs(daysBetween(c.date, iso)) <= 5);

  if (nearIdx >= 0) {
    sched.checks[nearIdx].amount = amt;
    sched.checks[nearIdx].date = iso;
  } else {
    sched.checks.push({ date: iso, amount: amt });
    sched.checks.sort((a, b) => a.date.localeCompare(b.date));
  }

  sched.perCheckAmount = amt;
  if (sched.checks.length) sched.mode = 'dates';

  const month = iso.slice(0, 7);
  const monthChecks = sched.checks.filter(c => c.date.startsWith(month));
  const perCheck = sched.perCheckAmount || amt;
  let monthlyAmount = source.amount;

  if (monthChecks.length) {
    monthlyAmount = monthChecks.reduce(
      (sum, c) => sum + (Number(c.amount) > 0 ? Number(c.amount) : perCheck),
      0,
    );
  }

  return { paySchedule: sched, monthlyAmount };
}

export function transactionMatchesIncomeSource(tx, source) {
  if (!tx || tx.type !== 'income') return false;
  if (tx.incomeSourceId && tx.incomeSourceId === source.id) return true;
  if (descriptionMatchesIncomeSource(tx.description, source)) return true;
  const amt = Math.abs(Number(tx.amount)) || 0;
  const perCheck = getDefaultPerCheckAmount(source);
  if (perCheck > 0 && amountsClose(amt, perCheck)) return true;
  return false;
}

export function matchCheckToTransaction(check, transactions, source) {
  const windowStart = check.date;
  const start = new Date(windowStart + 'T12:00:00');
  start.setDate(start.getDate() - 3);
  const end = new Date(windowStart + 'T12:00:00');
  end.setDate(end.getDate() + 5);
  // Local calendar dates — UTC slice was shifting the match window
  const startIso = formatLocalISODate(start);
  const endIso = formatLocalISODate(end);

  return transactions.find(t => {
    if (t.type !== 'income') return false;
    if (t.date < startIso || t.date > endIso) return false;
    if (transactionMatchesIncomeSource(t, source)) return true;
    if (amountsClose(t.amount, check.amount)) return true;
    return false;
  }) || null;
}

export function resolveCheckStatus(check, tx, today = todayISO()) {
  if (tx) return 'received';
  if (check.date < today) return 'overdue';
  const daysUntil = Math.ceil((new Date(check.date + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
  if (daysUntil <= 3) return 'soon';
  return 'pending';
}

export function scheduleSummary(source) {
  const sched = normalizePaySchedule(source.paySchedule);
  if (sched.mode === 'dates') {
    const n = sched.checks.length;
    const years = [...new Set(sched.checks.map(c => c.date.slice(0, 4)))].sort();
    if (!n) return 'Exact dates — none added yet';
    return `${n} date${n === 1 ? '' : 's'} (${years.join(', ')})`;
  }
  const r = sched.recurring;
  const freq = { monthly: 'Monthly', twice_monthly: '2×/month', biweekly: 'Biweekly' }[r.frequency] || 'Monthly';
  if (r.frequency === 'twice_monthly' && r.day2) return `${freq} · days ${r.day1} & ${r.day2}`;
  return `${freq} · day ${r.day1}`;
}