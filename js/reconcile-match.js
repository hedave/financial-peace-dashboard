import { formatCurrency, formatDate, formatLocalISODate } from './utils.js';

const CHECKING_TYPES = new Set(['income', 'expense', 'debt_payment', 'transfer']);

const TYPE_LABELS = {
  expense: 'expense',
  income: 'income',
  debt_payment: 'debt payment',
  transfer: 'transfer',
};

function roundCents(n) {
  return Math.round(Number(n) * 100) / 100;
}

function amountsClose(a, b, tolerance = 0.02) {
  return Math.abs(roundCents(a) - roundCents(b)) <= tolerance;
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - days);
  return formatLocalISODate(d);
}

/**
 * Recent txs that affect checking. Prefer amount proximity to the gap so a
 * $15.04 issue isn't drowned out by 35 unrelated large transactions.
 */
function getRecentCheckingItems(transactions, asOfDate, getCheckingDelta, absGap) {
  const cutoff = subtractDays(asOfDate, 90);
  const items = (transactions || [])
    .filter(t => CHECKING_TYPES.has(t.type) && t.date && t.date >= cutoff && t.date <= asOfDate)
    .map(tx => {
      const status = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
      const delta = getCheckingDelta(tx.type, tx.amount, status);
      const absAmt = Math.abs(Number(tx.amount) || 0);
      return {
        tx,
        delta: roundCents(delta),
        absAmt: roundCents(absAmt),
        // How close this single amount is to the gap size
        amtDist: Math.abs(absAmt - absGap),
      };
    })
    // Pending never moves checking in-app — skip them for "why is balance off"
    .filter(it => it.delta !== 0 && it.absAmt > 0);

  // Keep a mix: closest amounts to the gap + most recent overall
  const byProximity = [...items].sort((a, b) => a.amtDist - b.amtDist || b.tx.date.localeCompare(a.tx.date));
  const byDate = [...items].sort((a, b) => b.tx.date.localeCompare(a.tx.date) || String(b.tx.id).localeCompare(String(a.tx.id)));

  const picked = new Map();
  byProximity.slice(0, 40).forEach(it => picked.set(it.tx.id, it));
  byDate.slice(0, 40).forEach(it => picked.set(it.tx.id, it));

  return [...picked.values()]
    .sort((a, b) => a.amtDist - b.amtDist || b.tx.date.localeCompare(a.tx.date))
    .slice(0, 60);
}

/**
 * Find subsets whose checking deltas sum to targetDelta.
 * Prefers fewer / closer-amount transactions.
 */
function findSubsetMatches(items, targetDelta, { maxSubsetSize = 4, tolerance = 0.02, maxResults = 12 } = {}) {
  const target = roundCents(targetDelta);
  const results = [];
  const seen = new Set();

  function signature(indices) {
    return [...indices].sort((a, b) => a - b).join(',');
  }

  function push(indices, total) {
    if (results.length >= maxResults) return;
    const key = signature(indices);
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ indices: [...indices], totalDelta: roundCents(total) });
  }

  // Exact single matches first (most useful for small gaps like $15.04)
  for (let i = 0; i < items.length; i++) {
    if (amountsClose(items[i].delta, target, tolerance)) {
      push([i], items[i].delta);
    }
  }

  // Pairs
  if (results.length < maxResults) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const sum = items[i].delta + items[j].delta;
        if (amountsClose(sum, target, tolerance)) push([i, j], sum);
        if (results.length >= maxResults) break;
      }
      if (results.length >= maxResults) break;
    }
  }

  // Triples / quads with pruning (items sorted by |delta| desc helps)
  const order = items
    .map((it, i) => ({ i, mag: Math.abs(it.delta) }))
    .sort((a, b) => b.mag - a.mag)
    .map(x => x.i);

  function search(pos, indices, sum) {
    if (results.length >= maxResults) return;
    if (indices.length > 0 && amountsClose(sum, target, tolerance)) {
      push(indices, sum);
    }
    if (indices.length >= maxSubsetSize || pos >= order.length) return;

    const remaining = maxSubsetSize - indices.length;
    // Bound: even taking the largest remaining magnitudes can't reach target
    let maxAdd = 0;
    let minAdd = 0;
    for (let k = pos; k < Math.min(order.length, pos + remaining); k++) {
      const d = items[order[k]].delta;
      if (d > 0) maxAdd += d;
      if (d < 0) minAdd += d;
    }
    const need = target - sum;
    if (need > maxAdd + tolerance || need < minAdd - tolerance) return;

    for (let k = pos; k < order.length; k++) {
      const idx = order[k];
      search(k + 1, [...indices, idx], sum + items[idx].delta);
      if (results.length >= maxResults) return;
    }
  }

  if (results.length < maxResults && maxSubsetSize >= 3) {
    search(0, [], 0);
  }

  results.sort((a, b) => {
    if (a.indices.length !== b.indices.length) return a.indices.length - b.indices.length;
    // Prefer combinations whose amounts are closer to the gap
    const score = (m) => m.indices.reduce((s, i) => s + Math.abs(items[i].absAmt - Math.abs(target)), 0);
    return score(a) - score(b);
  });

  return results.slice(0, maxResults);
}

/** Near-miss singles when nothing nets exactly to the gap */
function findNearMisses(items, absGap, { limit = 5, maxDist = null } = {}) {
  const cap = maxDist != null ? maxDist : Math.max(25, absGap * 2);
  return [...items]
    .filter(it => it.amtDist <= cap)
    .sort((a, b) => a.amtDist - b.amtDist || b.tx.date.localeCompare(a.tx.date))
    .slice(0, limit);
}

export function describeReconciliationCandidate(transactions, gap, { nearMiss = false, amtDist = 0 } = {}) {
  const absGap = Math.abs(roundCents(gap));
  const types = new Set(transactions.map(t => t.type));
  const outflowTypes = ['expense', 'debt_payment', 'transfer'];
  const allOutflows = [...types].every(t => outflowTypes.includes(t));
  const allIncome = [...types].every(t => t === 'income');

  if (nearMiss) {
    const t = transactions[0];
    const label = TYPE_LABELS[t.type] || t.type;
    const diff = formatCurrency(amtDist);
    if (gap > 0 && outflowTypes.includes(t.type)) {
      return `Close: this ${label} is ${diff} off the gap — check for a partial match or fee`;
    }
    if (gap < 0 && t.type === 'income') {
      return `Close: this ${label} is ${diff} off the gap — check amount or split deposit`;
    }
    return `Closest logged amount (${diff} from gap) — may be related`;
  }

  if (transactions.length === 1) {
    const t = transactions[0];
    const label = TYPE_LABELS[t.type] || t.type;
    if (gap > 0 && outflowTypes.includes(t.type)) {
      return `Bank is higher: this ${label} may be duplicated in the app, or not posted at the bank yet`;
    }
    if (gap > 0 && t.type === 'income') {
      return `Unusual: income of this size matches the gap but bank is already higher — verify dates`;
    }
    if (gap < 0 && t.type === 'income') {
      return `Bank is lower: this ${label} may be duplicated in the app, or not at the bank`;
    }
    if (gap < 0 && outflowTypes.includes(t.type)) {
      return `Bank is lower: this ${label} may be missing from the bank side, or amount differs`;
    }
    return `Single ${label} matches the ${formatCurrency(absGap)} gap`;
  }

  if (gap > 0 && allOutflows) {
    return `${transactions.length} logged outflows net to the gap — bank may not have all of them, or one is a double-post`;
  }
  if (gap < 0 && allIncome) {
    return `${transactions.length} income rows net to the gap — possible duplicate deposit in the app`;
  }
  return `${transactions.length} transactions net to the ${formatCurrency(absGap)} gap`;
}

/**
 * @param {function(type, amount, clearingStatus): number} getCheckingDelta
 */
export function findReconciliationCandidates(transactions, gap, asOfDate, getCheckingDelta) {
  const roundedGap = roundCents(gap);
  if (!asOfDate || Math.abs(roundedGap) < 0.02) return [];

  const absGap = Math.abs(roundedGap);
  // Reversing these checking deltas would close the gap
  const targetDelta = roundCents(-roundedGap);

  const items = getRecentCheckingItems(transactions, asOfDate, getCheckingDelta, absGap);
  if (!items.length) return [];

  const subsets = findSubsetMatches(items, targetDelta, {
    maxSubsetSize: absGap < 50 ? 3 : 4,
    tolerance: 0.02,
    maxResults: 10,
  });

  const exact = subsets.map(match => {
    const txs = match.indices.map(i => items[i].tx);
    const gapMatch = roundCents(Math.abs(match.totalDelta));
    return {
      transactions: txs,
      totalDelta: match.totalDelta,
      /** How much of the gap this explanation covers (should ≈ |gap|) */
      gapMatch,
      /** Sum of absolute transaction amounts (secondary; can be larger for multi-item) */
      totalAmount: roundCents(txs.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0)),
      exact: true,
      nearMiss: false,
      hint: describeReconciliationCandidate(txs, roundedGap),
    };
  });

  if (exact.length) return exact;

  // No exact subset — surface nearest amounts so the UI isn't empty / useless
  const near = findNearMisses(items, absGap, { limit: 6 });
  return near.map((it, idx) => ({
    transactions: [it.tx],
    totalDelta: it.delta,
    gapMatch: it.absAmt,
    totalAmount: it.absAmt,
    exact: false,
    nearMiss: true,
    amtDist: it.amtDist,
    hint: describeReconciliationCandidate([it.tx], roundedGap, {
      nearMiss: true,
      amtDist: it.amtDist,
    }),
    rank: idx + 1,
  }));
}

export function formatCandidateSummary(candidate) {
  return (candidate.transactions || []).map(t => {
    const label = TYPE_LABELS[t.type] || t.type;
    const pending = t.clearingStatus === 'pending' ? ' · pending' : '';
    const desc = t.description ? ` · ${t.description}` : '';
    return `${formatDate(t.date)} · ${label} · ${formatCurrency(t.amount)}${pending}${desc}`;
  });
}
