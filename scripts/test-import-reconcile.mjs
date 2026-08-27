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
Aug 26, 2026,WAL-MART #4428 082626,-67.26,Pending
Aug 27, 2026,Walmart,-67.26,Posted
Aug 25, 2026,ICPayment,-287.39,Posted
Aug 17, 2026,Citi Credit Card Payment,-2061.13,Posted
Aug 24, 2026,Chick-fil-A,-20.00,Posted
Aug 24, 2026,Lindt,-20.00,Posted
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

console.log('all import-reconcile checks passed');
