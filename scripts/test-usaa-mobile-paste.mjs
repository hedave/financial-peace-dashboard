import {
  parseBankCsvText,
  looksLikeUsaaMobileWebPaste,
  normalizeImportRow,
} from '../js/csv-import.js';

const sample = [
  'Date Description Category AmountCurrent Balance',
  'Aug 03, 2026 Example Market Groceries -$12.34$100.00',
  'Aug 04, 2026 Example Payroll Paycheck $40.00$140.00',
  'https://mobile.usaa.com/my/checking/?accountId=REDACTED Page 1 of 1',
].join('');

console.log('looksLike', looksLikeUsaaMobileWebPaste(sample));
const rows = parseBankCsvText(sample);
console.log('count', rows.length);
const norm = rows.map(r => normalizeImportRow(r, { includePending: true })).filter(Boolean);
console.log('normalized', norm.length);
rows.forEach((r, i) => {
  console.log(
    String(i + 1).padStart(2),
    r.Date,
    String(r.Amount).padStart(10),
    (r.Status || '').slice(0, 7).padEnd(7),
    (r.Description || '').slice(0, 55),
  );
});
const totalExp = norm.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
const totalInc = norm.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
console.log('expense total', totalExp.toFixed(2), 'income total', totalInc.toFixed(2));
const pending = rows.filter(r => /pending/i.test(r.Status || '')).length;
console.log('pending rows', pending);
