import {
  parseBankCsvText,
  selfCheckImportReconcile,
  isImportDuplicateTransaction,
  areLikelyDuplicatePair,
  normalizeMerchantDescription,
} from '../js/csv-import.js';
import { findMatchingRule, descriptionMatchesPattern } from '../js/category-rules.js';
import { addMonths, getCurrentMonth } from '../js/utils.js';
import { getGsaEftDates, isGsaEftDate } from '../js/gsa-eft-dates.js';

const { ok, failures } = selfCheckImportReconcile();
if (!ok) {
  console.error('selfCheckImportReconcile failed:');
  failures.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('selfCheckImportReconcile ok');

const walmartRule = { pattern: 'walmart', categoryId: 'groceries', createdAt: '2026-01-01' };
if (!descriptionMatchesPattern('WAL-MART #4428 082626', 'walmart')) {
  console.error('WAL-MART should match walmart rule');
  process.exit(1);
}
const hit = findMatchingRule('WAL-MART #4428 082626', [
  { pattern: 'ingles', categoryId: 'ingles', createdAt: '2020-01-01' },
  walmartRule,
]);
if (hit?.categoryId !== 'groceries') {
  console.error('findMatchingRule should pick walmart, got', hit);
  process.exit(1);
}

const gas = findMatchingRule('INGLES GAS EXPRESS #134 CANDLER NC', [
  { pattern: 'ingles', categoryId: 'markets', createdAt: '2020-01-01' },
  { pattern: 'ingles gas', categoryId: 'gas', createdAt: '2021-01-01' },
]);
if (gas?.categoryId !== 'gas') {
  console.error('longest pattern should win for ingles gas, got', gas);
  process.exit(1);
}
console.log('rule matching ok (WAL-MART, ingles gas longest-wins)');

const csv = `Date,Description,Amount,Status
08/26/2026,WAL-MART #4428 082626,-67.26,Pending
08/27/2026,Walmart,-67.26,Posted
08/25/2026,ICPayment,-287.39,Posted
08/17/2026,Citi Credit Card Payment,-2061.13,Posted
08/24/2026,Chick-fil-A,-20.00,Posted
08/24/2026,Lindt,-20.00,Posted
`;
const rows = parseBankCsvText(csv);
if (rows.length < 6) {
  console.error('fixture CSV parsed', rows.length, 'rows, expected 6');
  process.exit(1);
}
console.log('fixture CSV parsed', rows.length, 'rows');
console.log('normalize pending walmart →', normalizeMerchantDescription('WAL-MART #4428 082626'));

const dda = { date: '2026-08-25', amount: 287.39, type: 'expense', description: 'DDA DEBIT', id: '1' };
const icp = { date: '2026-08-25', amount: 287.39, type: 'expense', description: 'ICPayment', id: '2' };
if (!isImportDuplicateTransaction([dda], icp) || !areLikelyDuplicatePair(dda, icp)) {
  console.error('ICPayment vs DDA DEBIT should merge');
  process.exit(1);
}
const debt = { date: '2026-08-17', amount: 2061.13, type: 'debt_payment', description: 'Snowball', id: 'd' };
const citi = { date: '2026-08-17', amount: 2061.13, type: 'expense', description: 'Citi Credit Card Payment', id: 'c' };
if (!isImportDuplicateTransaction([debt], citi)) {
  console.error('Citi payment should merge into debt_payment');
  process.exit(1);
}
const chick = { date: '2026-08-24', amount: 20, type: 'expense', description: 'Chick-fil-A', id: 'ch' };
const lindt = { date: '2026-08-24', amount: 20, type: 'expense', description: 'Lindt', id: 'li' };
if (isImportDuplicateTransaction([chick], lindt) || areLikelyDuplicatePair(chick, lindt)) {
  console.error('Chick-fil-A vs Lindt must stay two rows');
  process.exit(1);
}

console.log('csv-import checks passed');

function cents(n) {
  return Math.round(Number(n) * 100);
}

function usaaCsv(rows) {
  const lines = ['Date,Description,Original Description,Category,Amount,Status'];
  rows.forEach(r => {
    lines.push([
      r.date,
      r.description,
      r.description,
      r.category || '',
      Number(r.amount).toFixed(2),
      r.status,
    ].join(','));
  });
  return lines.join('\n');
}

function fail(msg, extra) {
  console.error(msg, extra ?? '');
  process.exit(1);
}

// Store-level: pending→posted must be one checking hit (USPS + VACP)
globalThis.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const { store } = await import('../js/store.js');

function resetBooks(checking = 0) {
  store.state.transactions = [];
  store.state.balances.checking = checking;
  store.state.categoryRules = [];
  store.state.monthEnvelopeMoves = {};
  store.state.monthBonusAllocations = {};
  store.state.upcomingHolds = [];
  (store.state.categories || []).forEach(c => {
    if (String(c.name || '').trim().toLowerCase() === 'work travel') c.carryOver = 0;
  });
}

resetBooks(0);

const uspsRows = parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'USPS PO 36248007', amount: -12.90, status: 'Pending' },
]));
let stats = store.importTransactions(uspsRows, { includePending: true });
const afterUspsPending = Number(store.state.balances.checking);
if (cents(afterUspsPending) !== -1290) {
  fail('USPS pending should credit checking -12.90, got', { afterUspsPending, stats });
}
if (store.state.transactions.filter(t => Math.abs(Number(t.amount) - 12.9) < 0.001).length !== 1) {
  fail('USPS pending should add one row');
}

const envelopeId = store.state.categories[0]?.id || 'household';
const uspsTx = store.state.transactions.find(t => Math.abs(Number(t.amount) - 12.9) < 0.001);
uspsTx.categoryId = envelopeId;

const uspsPostedRows = parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'US Postal Service', amount: -12.90, status: 'Posted' },
]));
stats = store.importTransactions(uspsPostedRows, { includePending: true });
if (stats.matchedPending < 1) {
  fail('USPS posted should merge pending, stats', stats);
}
if (cents(store.state.balances.checking) !== -1290) {
  fail('USPS posted must not move checking again, got', store.state.balances.checking);
}
const uspsAfter = store.state.transactions.filter(t => Math.abs(Number(t.amount) - 12.9) < 0.001);
if (uspsAfter.length !== 1) fail('USPS should remain one row');
if (uspsAfter[0].categoryId !== envelopeId) {
  fail('posted merge must keep existing envelope', uspsAfter[0]);
}
if (uspsAfter[0].bankPending) fail('posted merge should clear bankPending');
console.log('USPS pending→posted: one row, checking -12.90 once, envelope kept');

const vacpPending = parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'VACP TREAS XXVA BENEF', amount: 2378.45, status: 'Pending' },
]));
const checkingBeforeVacp = Number(store.state.balances.checking);
stats = store.importTransactions(vacpPending, { includePending: true });
const afterVacpPending = Number(store.state.balances.checking);
if (cents(afterVacpPending - checkingBeforeVacp) !== 237845) {
  fail('VACP pending should credit +2378.45, delta', {
    delta: afterVacpPending - checkingBeforeVacp, stats,
  });
}

const vacpPosted = parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'VACP TREAS XXVA BENEF', amount: 2378.45, status: 'Posted' },
]));
stats = store.importTransactions(vacpPosted, { includePending: true });
if (stats.matchedPending < 1) {
  fail('VACP posted should merge pending, stats', stats);
}
if (cents(store.state.balances.checking) !== cents(afterVacpPending)) {
  fail('VACP posted must not double-credit, got', store.state.balances.checking);
}
console.log('VACP pending ACH: checking +2378.45 once; posted twin merges');

// Walmart fractionals stay (do not auto-delete)
const wmFrac = parseBankCsvText(usaaCsv([
  { date: '08/20/2026', description: 'WAL-MART #4428', amount: -0.03, status: 'Posted' },
  { date: '08/20/2026', description: 'WAL-MART #4428', amount: -67.26, status: 'Posted' },
]));
stats = store.importTransactions(wmFrac, { includePending: true });
const wmRows = store.state.transactions.filter(t => /wal-?mart/i.test(t.description));
if (wmRows.length !== 2) fail('Walmart fractionals must stay as two rows', wmRows);
console.log('Walmart fractionals kept as two rows');

// 27 Aug file: prior pending USPS already in the log; 50-row USAA export
// includes posted US Postal Service + pending VACP. Checking = USAA available.
resetBooks(0);
store.importTransactions(parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'USPS PO 36248007 157 082626', amount: -12.90, status: 'Pending' },
])), { includePending: true });

const fileRows = [
  { date: '08/27/2026', description: 'US Postal Service', amount: -12.90, status: 'Posted' },
  { date: '08/27/2026', description: 'VACP TREAS XXVA BENEF', amount: 2378.45, status: 'Pending' },
];
for (let i = 0; i < 48; i++) {
  const day = String((i % 27) + 1).padStart(2, '0');
  fileRows.push({
    date: `08/${day}/2026`,
    description: `Merchant ${String(i + 1).padStart(2, '0')} Candler NC`,
    amount: -((10 * 100) + i + 1) / 100,
    status: 'Posted',
  });
}
if (fileRows.length !== 50) fail('expected 50-row file, got', fileRows.length);

const fileSignedCents = fileRows.reduce((s, r) => s + cents(r.amount), 0);
// Prior pending USPS is the same economic event as posted US Postal Service
const usaaAvailableCents = fileSignedCents; // start 0; USPS counted once in the file

const fifty = parseBankCsvText(usaaCsv(fileRows));
if (fifty.length !== 50) fail('50-row USAA file parsed', fifty.length);
stats = store.importTransactions(fifty, { includePending: true });
if (cents(store.state.balances.checking) !== usaaAvailableCents) {
  fail('FigPig checking must equal USAA available after 50-row file', {
    checking: store.state.balances.checking,
    available: usaaAvailableCents / 100,
    stats,
  });
}
const uspsCount = store.state.transactions.filter(t => Math.abs(Number(t.amount) - 12.9) < 0.001).length;
const vacpCount = store.state.transactions.filter(t => Math.abs(Number(t.amount) - 2378.45) < 0.001).length;
if (uspsCount !== 1) fail('50-row file should leave one USPS row', uspsCount);
if (vacpCount !== 1) fail('50-row file should leave one VACP row', vacpCount);
if (stats.matchedPending < 1) fail('50-row file should merge pending USPS', stats);

const afterFifty = cents(store.state.balances.checking);
stats = store.importTransactions(parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'VACP TREAS XXVA BENEF', amount: 2378.45, status: 'Posted' },
])), { includePending: true });
if (stats.matchedPending < 1) fail('later posted VACP should merge', stats);
if (cents(store.state.balances.checking) !== afterFifty) {
  fail('posted VACP twin must not change checking', store.state.balances.checking);
}
if (store.state.transactions.filter(t => Math.abs(Number(t.amount) - 2378.45) < 0.001).length !== 1) {
  fail('VACP should remain one row after posted twin');
}
console.log('50-row USAA file: FigPig checking equals USAA available; posted twins merge');

// Legacy holdChecking pending income: re-import of the same pending ACH
// must backfill checking once (Home awaiting-bank → cleared + bankPending).
resetBooks(1506.22);
store.state.transactions.push({
  id: 'legacy-vacp',
  date: '2026-08-27',
  amount: 2378.45,
  type: 'income',
  description: 'VACP TREAS XXVA BENEF',
  clearingStatus: 'pending',
});
const vacpLegacyPending = parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'VACP TREAS XXVA BENEF', amount: 2378.45, status: 'Pending' },
]));
stats = store.importTransactions(vacpLegacyPending, { includePending: true });
if (cents(store.state.balances.checking) !== 388467) {
  fail('legacy pending VACP re-import should credit +2378.45 → 3884.67', {
    checking: store.state.balances.checking, stats,
  });
}
const legacyVacp = store.state.transactions.find(t => t.id === 'legacy-vacp');
if (!legacyVacp || store.state.transactions.filter(t => Math.abs(Number(t.amount) - 2378.45) < 0.001).length !== 1) {
  fail('legacy VACP must stay one row', store.state.transactions);
}
if (legacyVacp.clearingStatus === 'pending') fail('Home must not still show awaiting bank', legacyVacp);
if (legacyVacp.clearingStatus !== 'cleared' || !legacyVacp.bankPending) {
  fail('legacy VACP should be cleared + bankPending until posted', legacyVacp);
}

stats = store.importTransactions(vacpLegacyPending, { includePending: true });
if (!(stats.duplicates >= 1) || stats.count !== 0) {
  fail('second pending re-import should be duplicates, checking unchanged', stats);
}
if (cents(store.state.balances.checking) !== 388467) {
  fail('second pending re-import must not move checking', store.state.balances.checking);
}

stats = store.importTransactions(parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'VACP TREAS XXVA BENEF', amount: 2378.45, status: 'Posted' },
])), { includePending: true });
if (stats.matchedPending < 1) fail('posted VACP twin should merge legacy row', stats);
if (cents(store.state.balances.checking) !== 388467) {
  fail('posted twin must not double-credit', store.state.balances.checking);
}
if (legacyVacp.bankPending) fail('posted twin should clear bankPending', legacyVacp);
if (store.state.transactions.filter(t => Math.abs(Number(t.amount) - 2378.45) < 0.001).length !== 1) {
  fail('posted twin must not add a second VACP row');
}
console.log('legacy pending VACP: checking +2378.45 once; Home not awaiting bank');

// Pending purchase already on-book must not get a second checking hit
resetBooks(0);
store.state.transactions.push({
  id: 'usps-onbook',
  date: '2026-08-27',
  amount: 12.90,
  type: 'expense',
  description: 'USPS PO 36248007 157 082626',
  clearingStatus: 'cleared',
  bankPending: true,
});
store.state.balances.checking = -12.90;
stats = store.importTransactions(parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'USPS PO 36248007 157 082626', amount: -12.90, status: 'Pending' },
])), { includePending: true });
if (cents(store.state.balances.checking) !== -1290) {
  fail('on-book pending purchase must not hit checking again', store.state.balances.checking);
}
if (store.state.transactions.filter(t => Math.abs(Number(t.amount) - 12.9) < 0.001).length !== 1) {
  fail('on-book USPS must stay one row');
}
console.log('on-book pending purchase: no second checking hit');

// Work travel: Federal Travel Payments earmark; leftover after card payoff → Dad
resetBooks(0);
if (!store.state.categories.some(c => String(c.name).trim().toLowerCase() === 'dad')) {
  store.state.categories.push({
    id: 'test-dad',
    name: 'Dad',
    icon: '🧌',
    parentId: null,
    isSinkingFund: true,
    monthlyBudget: 20,
    carryOver: 0,
    goalAmount: 0,
    note: '',
    allowGifts: true,
  });
}
const travelCat = store.state.categories.find(c => String(c.name).trim().toLowerCase() === 'work travel');
const dadCat = store.state.categories.find(c => String(c.name).trim().toLowerCase() === 'dad');
if (!travelCat || !dadCat) fail('need Work travel and Dad envelopes');
travelCat.carryOver = 0;
dadCat.carryOver = 0;

const toAllocBefore = store.getToAllocate();
const bonusBefore = store.getBonusAvailable();
stats = store.importTransactions(parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'Federal Travel Payments', amount: 1285.56, status: 'Posted' },
])), { includePending: true });
const travelIncome = store.state.transactions.find(t => t.type === 'income' && /federal travel/i.test(t.description));
if (!travelIncome) fail('Federal Travel Payments should import');
if (travelIncome.categoryId !== travelCat.id || !travelIncome.earmarkedEnvelope) {
  fail('Federal Travel Payments should earmark to Work travel', travelIncome);
}
if (cents(store.state.balances.checking) !== 128556) {
  fail('Federal Travel Payments should credit checking +1285.56', store.state.balances.checking);
}
if (cents(store.getToAllocate() - toAllocBefore) !== 0) {
  fail('earmarked travel reimbursement must not change To Allocate', {
    before: toAllocBefore, after: store.getToAllocate(),
  });
}
if (cents(store.getBonusAvailable() - bonusBefore) !== 0) {
  fail('earmarked travel reimbursement must not land in bonus', store.getBonusAvailable());
}
if (cents(store.getCategoryRemaining(travelCat.id)) !== 128556) {
  fail('Work travel remaining should be 1285.56 after reimbursement', store.getCategoryRemaining(travelCat.id));
}

stats = store.importTransactions(parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'Federal Travel Payments', amount: 1285.56, status: 'Posted' },
])), { includePending: true });
if (!(stats.duplicates >= 1)) fail('re-import of Federal Travel Payments should be duplicates', stats);
if (cents(store.getCategoryRemaining(travelCat.id)) !== 128556) {
  fail('re-import must not double-earmark Work travel', store.getCategoryRemaining(travelCat.id));
}

const dadBeforePay = store.getCategoryRemaining(dadCat.id);
const payId = store.addTransaction({
  date: '2026-08-27',
  amount: 1020.71,
  type: 'expense',
  categoryId: travelCat.id,
  description: 'Work travel card payoff',
  clearingStatus: 'cleared',
});
if (!payId) fail('card payoff should log');
if (cents(store.state.balances.checking) !== 26485) {
  fail('after card payoff checking should be +264.85 net', store.state.balances.checking);
}
if (cents(store.getCategoryRemaining(travelCat.id)) !== 0) {
  fail('Work travel leftover should move to Dad (remaining 0)', store.getCategoryRemaining(travelCat.id));
}
if (cents(store.getCategoryRemaining(dadCat.id) - dadBeforePay) !== 26485) {
  fail('Dad should receive 264.85 leftover', {
    dadBefore: dadBeforePay,
    dadAfter: store.getCategoryRemaining(dadCat.id),
  });
}
const leftoverMove = (store.state.monthEnvelopeMoves['2026-08'] || []).find(m =>
  m.fromId === travelCat.id && m.toId === dadCat.id,
);
if (!leftoverMove || cents(leftoverMove.amount) !== 26485) {
  fail('expected Work travel leftover → Dad move of 264.85', leftoverMove);
}
console.log('Federal Travel Payments: earmark Work travel; leftover 264.85 → Dad');

// Partial card payment still holds leftover on Work travel
resetBooks(0);
travelCat.carryOver = 0;
dadCat.carryOver = 0;
store.importTransactions(parseBankCsvText(usaaCsv([
  { date: '08/27/2026', description: 'Federal Travel Payments', amount: 1285.56, status: 'Posted' },
])), { includePending: true });
store.addTransaction({
  date: '2026-08-27',
  amount: 50,
  type: 'expense',
  categoryId: travelCat.id,
  description: 'Partial travel card',
  clearingStatus: 'cleared',
});
if (cents(store.getCategoryRemaining(travelCat.id)) !== 123556) {
  fail('partial payoff should keep leftover on Work travel', store.getCategoryRemaining(travelCat.id));
}
if ((store.state.monthEnvelopeMoves['2026-08'] || []).some(m => m.toId === dadCat.id)) {
  fail('partial payoff must not dump leftover to Dad');
}
console.log('partial Work travel payment holds leftover');

// Upcoming hold: out of snowball / safe-today, not To Allocate
resetBooks(4000);
const medicalCat = store.state.categories.find(c => /medical/i.test(c.name) && !c.parentId);
const toAlloc0 = store.getToAllocate();
const today0 = store.getBankSurplusForSnowball();
const snow0 = store.getSurplusForSnowball();
const holdDate = `${addMonths(getCurrentMonth(), 1)}-15`;
const hold = store.addUpcomingHold({
  date: holdDate,
  amount: 1500,
  categoryId: medicalCat?.id || null,
  description: 'Roman medical',
});
if (!hold) fail('should add upcoming hold');
if (cents(store.getToAllocate() - toAlloc0) !== 0) {
  fail('upcoming hold must not change To Allocate', { before: toAlloc0, after: store.getToAllocate() });
}
if (cents(today0 - store.getBankSurplusForSnowball()) !== 150000) {
  fail('safe-to-send today should drop by 1500', {
    before: today0, after: store.getBankSurplusForSnowball(),
  });
}
if (store.getSurplusForSnowball() > snow0 + 0.001) {
  fail('month-end snowball should not rise after a hold');
}
if (cents(store.getUpcomingHoldReserve({ mode: 'today' })) !== 150000) {
  fail('today hold reserve should be 1500');
}
store.dismissUpcomingHold(hold.id);
if (cents(store.getBankSurplusForSnowball() - today0) !== 0) {
  fail('dismissing hold should restore safe-to-send', store.getBankSurplusForSnowball());
}
console.log('upcoming hold: To Allocate unchanged; safe-today −1500 until dismissed');

const eft2027 = getGsaEftDates(2027);
if (eft2027.length !== 26) fail('2027 GSA EFT should be 26 dates', eft2027.length);
if (!isGsaEftDate('2027-01-15') || !isGsaEftDate('2027-12-30')) {
  fail('2027 purple EFT endpoints missing');
}
if (isGsaEftDate('2027-01-20')) fail('official paycheck date must not count as EFT');
resetBooks(0);
const primary = store.state.incomeSources.find(s => s.name === 'Primary');
if (!primary) fail('need Primary source');
const added = store.addPayChecks(primary.id, eft2027, 2571.64);
if (added !== 26) fail('should add 26 GSA dates', added);
if (store.addPayChecks(primary.id, eft2027, 2571.64) !== 0) fail('second fill should skip existing');
const livePrimary = () => store.state.incomeSources.find(s => s.id === primary.id);
if (!livePrimary().paySchedule.checks.some(c => c.date === '2027-01-15')) {
  fail('fill should include 2027-01-15');
}
store.togglePayCheck(primary.id, '2027-01-15');
if (livePrimary().paySchedule.checks.some(c => c.date === '2027-01-15')) {
  fail('toggle should remove Jan 15');
}
console.log('GSA EFT 2027: 26 purple dates; fill + click-toggle ok');

console.log('all import-reconcile checks passed');
