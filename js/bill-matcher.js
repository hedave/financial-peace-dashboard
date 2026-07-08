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

/**
 * Find the best unpaid bill match for a transaction.
 * @returns {object|null} bill
 */
export function findBillForTransaction(tx, bills = []) {
  if (!tx || tx.type !== 'expense' || tx.billId) return null;

  const unpaid = bills.filter(b => b.status !== 'paid');
  const amt = Math.abs(Number(tx.amount)) || 0;
  if (!amt) return null;

  // Exact amount + name in description
  const strong = unpaid.filter(b =>
    amountsMatch(b.amount, amt) && billNameInDescription(b.name, tx.description)
  );
  if (strong.length === 1) return strong[0];
  if (strong.length > 1) return strong[0];

  // Exact amount only (single candidate)
  const byAmount = unpaid.filter(b => amountsMatch(b.amount, amt));
  if (byAmount.length === 1 && billNameInDescription(byAmount[0].name, tx.description)) {
    return byAmount[0];
  }

  // Auto-pay bills: amount match is enough if description shares a keyword
  const autoPay = byAmount.filter(b => b.autoPay && billNameInDescription(b.name, tx.description));
  if (autoPay.length === 1) return autoPay[0];

  return null;
}