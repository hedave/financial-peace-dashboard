import {
  parseBankCsvText,
  selfCheckImportReconcile,
  isImportDuplicateTransaction,
  areLikelyDuplicatePair,
  normalizeMerchantDescription,
} from '../js/csv-import.js';
import { findMatchingRule, descriptionMatchesPattern } from '../js/category-rules.js';

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

console.log('all import-reconcile checks passed');
