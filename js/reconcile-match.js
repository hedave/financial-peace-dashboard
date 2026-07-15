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

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - days);
  return formatLocalISODate(d);
}

function getRecentCheckingTransactions(transactions, asOfDate, { maxDays = 90, limit = 35 } = {}) {
  const cutoff = subtractDays(asOfDate, maxDays);
  return (transactions || [])
    .filter(t => CHECKING_TYPES.has(t.type) && t.date >= cutoff && t.date <= asOfDate)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)))
    .slice(0, limit);
}

function findSubsetMatches(items, targetDelta, { maxSubsetSize = 5, tolerance = 0.02, maxResults = 10 } = {}) {
  const target = roundCents(targetDelta);
  const results = [];
  const seen = new Set();

  function signature(indices) {
    return [...indices].sort((a, b) => a - b).join(',');
  }

  function search(start, indices, sum) {
    if (results.length >= maxResults) return;

    const total = roundCents(sum);
    if (indices.length > 0 && Math.abs(total - target) <= tolerance) {
      const key = signature(indices);
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ indices: [...indices], totalDelta: total });
      }
    }

    if (indices.length >= maxSubsetSize) return;

    for (let i = start; i < items.length; i++) {
      search(i + 1, [...indices, i], sum + items[i].delta);
    }
  }

  search(0, [], 0);

  results.sort((a, b) => {
    if (a.indices.length !== b.indices.length) return a.indices.length - b.indices.length;
    return Math.min(...a.indices) - Math.min(...b.indices);
  });

  return results.slice(0, maxResults);
}

export function describeReconciliationCandidate(transactions, gap) {
  const absGap = Math.abs(roundCents(gap));
  const types = new Set(transactions.map(t => t.type));
  const outflowTypes = ['expense', 'debt_payment', 'transfer'];
  const allOutflows = [...types].every(t => outflowTypes.includes(t));
  const allIncome = [...types].every(t => t === 'income');

  if (transactions.length === 1) {
    const t = transactions[0];
    const label = TYPE_LABELS[t.type] || t.type;
    if (gap > 0 && outflowTypes.includes(t.type)) {
      return `This ${label} may be duplicated or not yet cleared at the bank`;
    }
    if (gap < 0 && t.type === 'income') {
      return `This ${label} may be duplicated or not reflected at the bank`;
    }
    return `Single ${label} matches the ${formatCurrency(absGap)} gap`;
  }

  if (gap > 0 && allOutflows) {
    return `${transactions.length} logged outflows may explain why the bank shows ${formatCurrency(absGap)} more`;
  }
  if (gap < 0 && allIncome) {
    return `${transactions.length} income entries may explain why the bank shows ${formatCurrency(absGap)} less`;
  }
  return `${transactions.length} transactions net to the ${formatCurrency(absGap)} gap`;
}

export function findReconciliationCandidates(transactions, gap, asOfDate, getCheckingDelta) {
  const roundedGap = roundCents(gap);
  if (!asOfDate || Math.abs(roundedGap) < 0.02) return [];

  const targetDelta = roundCents(-roundedGap);
  const recent = getRecentCheckingTransactions(transactions, asOfDate);
  const items = recent.map(tx => ({
    tx,
    delta: getCheckingDelta(tx.type, tx.amount),
  }));

  const subsets = findSubsetMatches(items, targetDelta);

  return subsets.map(match => {
    const txs = match.indices.map(i => items[i].tx);
    const totalAmount = roundCents(txs.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0));
    return {
      transactions: txs,
      totalDelta: match.totalDelta,
      totalAmount,
      hint: describeReconciliationCandidate(txs, roundedGap),
    };
  });
}

export function formatCandidateSummary(candidate) {
  const lines = candidate.transactions.map(t => {
    const label = TYPE_LABELS[t.type] || t.type;
    return `${formatDate(t.date)} · ${label} · ${formatCurrency(t.amount)}${t.description ? ` · ${t.description}` : ''}`;
  });
  return lines;
}