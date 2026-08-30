import {
  normalizeIngestTransactions,
  inboxRowsToImportObjects,
  redactSensitive,
} from '../js/ingest-normalize.js';
import { resolveRequestedEnvelope, normalizeMerchantDescription } from '../js/csv-import.js';
import { guessMerchantPattern, findMatchingRule } from '../js/category-rules.js';

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

const dadHint = normalizeIngestTransactions([{
  date: '2026-08-30',
  amount: -10,
  description: 'CURSOR USAGE AUG 083026',
  pending: true,
  category: 'dad',
}]);
assert(dadHint.length === 1, 'dad category row');
assert(dadHint[0].requestedEnvelope === 'dad', 'category maps to requestedEnvelope');
assert(dadHint[0].description === 'CURSOR USAGE AUG 083026', 'keep merchant text');
assert(inboxRowsToImportObjects(dadHint)[0].Envelope === 'dad', 'envelope field on import row');

const envField = normalizeIngestTransactions([{
  date: '2026-08-30',
  amount: -10,
  description: 'CURSOR USAGE AUG 083026',
  pending: true,
  envelope: 'dad',
}]);
assert(envField[0].requestedEnvelope === 'dad', 'envelope field is captured');
assert(envField[0].bankCategory == null, 'envelope-only does not invent a bank label');

const byId = normalizeIngestTransactions([{
  date: '2026-08-30',
  amount: -4.25,
  description: 'Other merchant',
  pending: true,
  categoryId: 'env-groceries',
}]);
assert(byId[0].requestedEnvelope === 'env-groceries', 'categoryId captured');

const mixed = normalizeIngestTransactions([
  { date: '2026-08-30', amount: -10, description: 'A', pending: true, category: 'dad' },
  { date: '2026-08-30', amount: -5, description: 'B', pending: true, envelope: 'Groceries' },
]);
assert(mixed[0].requestedEnvelope === 'dad', 'row A envelope');
assert(mixed[1].requestedEnvelope === 'Groceries', 'row B envelope');
assert(mixed[0].requestedEnvelope !== mixed[1].requestedEnvelope, 'per-row envelopes');

const cats = [
  { id: 'env-dad', name: 'Dad', parentId: null },
  { id: 'env-groceries', name: 'Groceries', parentId: null },
];
assert(resolveRequestedEnvelope('dad', cats) === 'env-dad', 'name match');
assert(resolveRequestedEnvelope('Dad', cats) === 'env-dad', 'case-insensitive name');
assert(resolveRequestedEnvelope('env-groceries', cats) === 'env-groceries', 'id match');
assert(resolveRequestedEnvelope('nope', cats) == null, 'unknown envelope');

const desc = 'CURSOR USAGE AUG 083026';
const normalized = normalizeMerchantDescription(desc);
assert(normalized.includes('cursor') && normalized.includes('usage'), `merchant normalize: ${normalized}`);
const pattern = guessMerchantPattern(desc);
assert(pattern, 'guessMerchantPattern');
const later = findMatchingRule('CURSOR USAGE AUG 090126', [
  { pattern, categoryId: 'env-dad', createdAt: '2026-08-30' },
]);
assert(later?.categoryId === 'env-dad', 'later CURSOR USAGE AUG still matches import-rule path');

console.log('test-ingest-normalize: ok');
