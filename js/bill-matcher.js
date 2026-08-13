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

function billNameInDescription(billName, description) {
  const name = String(billName || '').toLowerCase().trim();
  const desc = String(description || '').toLowerCase();
  if (!name || !desc) return false;
  if (desc.includes(name)) return true;
  // Match significant words (4+ chars) from bill name
  const words = name.split(/\s+/).filter(w => w.length >= 4);
  return words.some(w => desc.includes(w));
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
  if (!tx || tx.type !== 'expense' || tx.billId) return null;
  const amt = Math.abs(Number(tx.amount)) || 0;
  if (!amt) return null;

  const candidates = unpaidBills(bills).filter(b => {
    if (!b.autoPay) return false;
    if (!billNameInDescription(b.name, tx.description)) return false;
    if (!billDueNearTransaction(b, tx)) return false;
    // Exact pennies OR close enough for variable utilities
    return amountsMatch(b.amount, amt)
      || amountsClose(b.amount, amt, { abs: AUTOPAY_CLOSE_ABS, pct: AUTOPAY_CLOSE_PCT });
  });

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // Closest amount wins
    candidates.sort((a, b) =>
      Math.abs(Math.abs(a.amount) - amt) - Math.abs(Math.abs(b.amount) - amt)
    );
    return candidates[0];
  }
  return null;
}

/**
 * Find the best unpaid bill match for a transaction (review inbox / suggestions).
 * Name + amount close (not only exact) so Spectrum $90 still pairs with an $80 plan.
 * @returns {object|null} bill
 */
export function findBillForTransaction(tx, bills = []) {
  if (!tx || tx.type !== 'expense' || tx.billId) return null;

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

  // Name + due only when unique unpaid bill matches the merchant (amount way off still surfaces in review)
  const byName = unpaid.filter(b =>
    billNameInDescription(b.name, tx.description) && billDueNearTransaction(b, tx)
  );
  if (byName.length === 1) {
    // Cap how far amount can drift for name-only (avoid random Spectrum-like word matches)
    if (amountsClose(byName[0].amount, amt, { abs: 50, pct: 0.5 })) {
      return byName[0];
    }
  }

  return null;
}
