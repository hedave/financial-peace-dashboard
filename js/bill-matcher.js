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