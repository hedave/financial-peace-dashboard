import {
  normalizeIngestTransactions,
  inboxRowsToImportObjects,
  redactSensitive,
} from '../js/ingest-normalize.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(redactSensitive('acct 12345678 hello').includes('[REDACTED]'), 'redact digits');

const txs = normalizeIngestTransactions([
  { date: '2026-08-28', amount: -5.66, description: 'Chick-fil-A', pending: false },
  { date: '08/28/2026', amount: 2571.64, type: 'income', name: 'AGRI TREAS 310 FED SAL' },
  { Date: 'Aug 28, 2026', debit: '43.00', Description: 'COMPASSION', Status: 'Pending' },
  { date: 'nope', amount: 1 },
]);

assert(txs.length === 3, `expected 3 rows, got ${txs.length}`);
assert(txs[0].type === 'expense' && txs[0].amount === 5.66, 'expense sign');
assert(txs[1].type === 'income' && txs[1].description.includes('AGRI'), 'income');
assert(txs[2].pending === true && txs[2].type === 'expense', 'pending debit');

const rows = inboxRowsToImportObjects(txs);
assert(rows[0].Amount === -5.66, 'import amount signed out');
assert(rows[1].Amount === 2571.64, 'import amount signed in');
assert(rows[2].Status === 'Pending', 'pending status');

console.log('test-ingest-normalize: ok');
