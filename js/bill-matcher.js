/** Match imported expenses to unpaid bills */

/** Penny-level equality (CSV rounding, cents). */
const AMOUNT_EXACT = 0.02;

/**
 * Utilities / streaming often swing month to month (e.g. Spectrum $80 plan → $90 bill).
 * Allow a wider window when the merchant name also matches.
 */
const AMOUNT_CLOSE_ABS = 25;
const AMOUNT_CLOSE_PCT = 0.35;

/** Auto-pay auto-link (no human review): slightly tighter than review suggestions. */
const AUTOPAY_CLOSE_ABS = 20;
const AUTOPAY_CLOSE_PCT = 0.25;

export function amountsMatch(a, b) {
  return Math.abs(Math.abs(Number(a)) - Math.abs(Number(b))) <= AMOUNT_EXACT;
}

/**
 * True when amounts are near enough for a bill that varies (name match required by caller).
 * Uses max(absolute $, percent of larger amount).
 */
export function amountsClose(a, b, {
  abs = AMOUNT_CLOSE_ABS,
  pct = AMOUNT_CLOSE_PCT,
} = {}) {
  const aa = Math.abs(Number(a)) || 0;
  const bb = Math.abs(Number(b)) || 0;
  if (!aa || !bb) return false;
  const diff = Math.abs(aa - bb);
  if (diff <= abs) return true;
  const base = Math.max(aa, bb);
  return diff / base <= pct;
}

export function amountDelta(a, b) {
  return Math.round((Math.abs(Number(a) || 0) - Math.abs(Number(b) || 0)) * 100) / 100;
}

const GENERIC_NAME_WORDS = new Set([
  'card', 'bill', 'payment', 'bank', 'credit', 'loan', 'auto', 'account', 'and',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole token, or a prefix of a token when the word is long enough that "citi" can match CITICARD. */
function hasToken(desc, word) {
  const body = escapeRegExp(word);
  if (!body) return false;
  const whole = new RegExp(`(?:^|[^a-z0-9])${body}(?![a-z0-9])`, 'i');
  if (whole.test(desc)) return true;
  if (word.length < 4) return false;
  return new RegExp(`(?:^|[^a-z0-9])${body}`, 'i').test(desc);
}

/** Drop parentheses and other punctuation glued onto a name token. */
function bareNameWord(word) {
  return String(word || '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Search words for a bill or debt name.
 * "Tesla (Bridgecrest)" contributes both tesla and bridgecrest.
 */
function nameWords(entityName) {
  const raw = String(entityName || '').toLowerCase();
  const found = [];
  const push = (word) => {
    const bare = bareNameWord(word);
    if (bare.length >= 3 && !GENERIC_NAME_WORDS.has(bare)) found.push(bare);
  };
  raw.split(/\s+/).forEach(push);
  for (const match of raw.matchAll(/\(([^)]*)\)/g)) push(match[1]);
  return [...new Set(found)];
}

/** Short bank labels that do not share words with the bill name. */
const NAME_ALIASES = [
  { short: 'p&c', long: 'property and casualty' },
];

function hasAliasForm(text, form) {
  const raw = String(text || '').toLowerCase();
  if (form.includes('&')) {
    const tight = form.replace(/\s*&\s*/g, '&');
    return hasToken(raw, tight);
  }
  const words = form.split(/\s+/).filter(w => w.length >= 3 && w !== 'and');
  return words.length > 0 && words.every(w => hasToken(raw, w));
}

function aliasNameMatch(entityName, description) {
  return NAME_ALIASES.some(alias =>
    (hasAliasForm(entityName, alias.long) && hasAliasForm(description, alias.short))
    || (hasAliasForm(entityName, alias.short) && hasAliasForm(description, alias.long))
  );
}

export function nameInDescription(entityName, description) {
  const name = String(entityName || '').toLowerCase().trim();
  const desc = String(description || '').toLowerCase();
  if (!name || !desc) return false;
  if (hasToken(desc, name)) return true;
  if (nameWords(name).some(w => hasToken(desc, w))) return true;
  return aliasNameMatch(name, desc);
}

function billNameInDescription(billName, description) {
  return nameInDescription(billName, description);
}

function unpaidBills(bills = []) {
  return (bills || []).filter(b => b && b.status !== 'paid');
}

/**
 * True if bill due date is in the same month as the tx, overdue relative to the tx,
 * or due within ~3 weeks after (paid early). Blocks auto-pay on a cycle already advanced.
 */
function billDueNearTransaction(bill, tx) {
  const due = String(bill?.dueDate || '').slice(0, 10);
  const day = String(tx?.date || '').slice(0, 10);
  if (!due || !day) return true;
  if (due.slice(0, 7) === day.slice(0, 7)) return true;
  if (due <= day) return true; // overdue / same day
  // due after payment date — allow if within 21 days (early pay)
  const t0 = new Date(day + 'T12:00:00').getTime();
  const t1 = new Date(due + 'T12:00:00').getTime();
  const days = Math.round((t1 - t0) / 86400000);
  return days >= 0 && days <= 21;
}

function scoreMatch(bill, tx, amt) {
  const billAmt = Math.abs(Number(bill.amount)) || 0;
  const exact = amountsMatch(billAmt, amt);
  const close = amountsClose(billAmt, amt);
  const name = billNameInDescription(bill.name, tx.description);
  const due = billDueNearTransaction(bill, tx);
  let score = 0;
  if (name) score += 40;
  if (exact) score += 30;
  else if (close) score += 18;
  if (due) score += 12;
  if (bill.autoPay && name) score += 5;
  // Prefer closer amounts when multiple name hits
  if (billAmt && amt) {
    const rel = Math.abs(billAmt - amt) / Math.max(billAmt, amt);
    score += Math.max(0, 10 - Math.round(rel * 40));
  }
  return { score, exact, close, name, due };
}

/**
 * Strong match for auto-pay: name + due window + amount exact or reasonably close.
 * Safe to auto-complete the bill cycle on CSV/PDF/paste import.
 * @returns {object|null} bill
 */
export function findAutoPayBillForTransaction(tx, bills = []) {
  if (!tx || tx.type !== 'expense' || tx.billId || tx.ignoreBillMatch) return null;
  const amt = Math.abs(Number(tx.amount)) || 0;
  if (!amt) return null;

  const named = unpaidBills(bills).filter(b =>
    b.autoPay
    && billNameInDescription(b.name, tx.description)
    && billDueNearTransaction(b, tx),
  );
  const amountOk = named.filter(b =>
    amountsMatch(b.amount, amt)
    || amountsClose(b.amount, amt, { abs: AUTOPAY_CLOSE_ABS, pct: AUTOPAY_CLOSE_PCT }),
  );

  const pickClosest = (list) => {
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    const sorted = [...list].sort((a, b) =>
      Math.abs(Math.abs(a.amount) - amt) - Math.abs(Math.abs(b.amount) - amt)
    );
    return sorted[0];
  };

  // Unique auto-pay merchant. A short name must also be close in amount,
  // so "Car" does not roll a $200 bill on a $5 card charge.
  // Longer names still match when the payment differs from the plan (Citi).
  if (named.length === 1) {
    const bill = named[0];
    const shortName = String(bill.name || '').trim().length < 4;
    if (!shortName) return bill;
    if (amountsMatch(bill.amount, amt) || amountsClose(bill.amount, amt, {
      abs: AUTOPAY_CLOSE_ABS,
      pct: AUTOPAY_CLOSE_PCT,
    })) return bill;
  }
  if (amountOk.length) return pickClosest(amountOk);
  return null;
}

/**
 * Find the best unpaid bill match for a transaction (review inbox / suggestions).
 * Name + amount close (not only exact) so Spectrum $90 still pairs with an $80 plan.
 * @returns {object|null} bill
 */
export function findBillForTransaction(tx, bills = []) {
  if (!tx || tx.type !== 'expense' || tx.billId || tx.ignoreBillMatch) return null;

  const unpaid = unpaidBills(bills);
  const amt = Math.abs(Number(tx.amount)) || 0;
  if (!amt) return null;

  // Prefer auto-pay strong match first
  const autoPay = findAutoPayBillForTransaction(tx, bills);
  if (autoPay) return autoPay;

  const ranked = unpaid
    .map(b => ({ bill: b, ...scoreMatch(b, tx, amt) }))
    .filter(r => r.name && (r.exact || r.close) && r.due)
    .sort((a, b) => b.score - a.score || Math.abs(Number(a.bill.amount) - amt) - Math.abs(Number(b.bill.amount) - amt));

  if (ranked.length) return ranked[0].bill;

  // Unique merchant + due: credit-card / loan payments rarely equal the planned bill $
  const byName = unpaid.filter(b =>
    billNameInDescription(b.name, tx.description) && billDueNearTransaction(b, tx)
  );
  if (byName.length === 1) return byName[0];

  return null;
}

/**
 * One unpaid bill, same name (including P&C = Property and Casualty), penny-level amount.
 * Safe to complete without a review tap. Close-but-not-equal amounts stay suggestions.
 */
export function findExactBillForTransaction(tx, bills = []) {
  if (!tx || tx.type !== 'expense' || tx.billId || tx.ignoreBillMatch) return null;
  const amt = Math.abs(Number(tx.amount) || 0);
  if (!amt) return null;
  const hits = unpaidBills(bills).filter(b =>
    billNameInDescription(b.name, tx.description)
    && billDueNearTransaction(b, tx)
    && amountsMatch(b.amount, amt)
  );
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Unique active debt whose name appears in the bank description (Citi, LightStream, …).
 */
export function findDebtForTransaction(tx, debts = []) {
  if (!tx || tx.debtId) return null;
  if (tx.type !== 'expense' && tx.type !== 'debt_payment' && tx.type !== 'transfer') return null;
  const active = (debts || []).filter(d => d && !d.archived && (Number(d.balance) || 0) > 0);
  const matches = active.filter(d => nameInDescription(d.name, tx.description));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const amt = Math.abs(Number(tx.amount) || 0);
    matches.sort((a, b) =>
      Math.abs((Number(a.minPayment) || Number(a.balance) || 0) - amt)
      - Math.abs((Number(b.minPayment) || Number(b.balance) || 0) - amt)
    );
    return matches[0];
  }
  return null;
}
