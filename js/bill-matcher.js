/** Match imported expenses to unpaid bills */

const AMOUNT_TOLERANCE = 0.02;

export function amountsMatch(a, b) {
  return Math.abs(Math.abs(Number(a)) - Math.abs(Number(b))) <= AMOUNT_TOLERANCE;
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

/**
 * Strong match only: amount + name in description, unique auto-pay bill.
 * Safe to auto-complete the bill cycle on CSV/PDF import.
 * @returns {object|null} bill
 */
export function findAutoPayBillForTransaction(tx, bills = []) {
  if (!tx || tx.type !== 'expense' || tx.billId) return null;
  const amt = Math.abs(Number(tx.amount)) || 0;
  if (!amt) return null;

  const candidates = unpaidBills(bills).filter(b =>
    b.autoPay
    && amountsMatch(b.amount, amt)
    && billNameInDescription(b.name, tx.description)
    && billDueNearTransaction(b, tx)
  );
  if (candidates.length === 1) return candidates[0];
  return null;
}

/**
 * Find the best unpaid bill match for a transaction (review inbox / suggestions).
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

  // Exact amount + name in description
  const strong = unpaid.filter(b =>
    amountsMatch(b.amount, amt) && billNameInDescription(b.name, tx.description)
  );
  if (strong.length === 1) return strong[0];
  if (strong.length > 1) return strong[0];

  // Exact amount only (single candidate) with name overlap
  const byAmount = unpaid.filter(b => amountsMatch(b.amount, amt));
  if (byAmount.length === 1 && billNameInDescription(byAmount[0].name, tx.description)) {
    return byAmount[0];
  }

  return null;
}