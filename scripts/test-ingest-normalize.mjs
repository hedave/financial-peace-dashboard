import {
  normalizeIngestTransactions,
  inboxRowsToImportObjects,
  redactSensitive,
  normalizeIngestSplits,
} from '../js/ingest-normalize.js';
import { resolveRequestedEnvelope, resolveRequestedSplits, normalizeMerchantDescription } from '../js/csv-import.js';
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
  { date: '2026-08-30', amount: -4.25, description: 'C', pending: true },
  { date: 'nope', amount: -3, description: 'bad date' },
  { date: '2026-08-30', amount: 0, description: 'zero amount' },
  { date: '2026-08-30', description: 'missing amount' },
]);
assert(mixed.length === 3, `mixed batch should keep 3 dated/amounted rows, got ${mixed.length}`);
assert(mixed[0].requestedEnvelope === 'dad', 'row A envelope');
assert(mixed[1].requestedEnvelope === 'Groceries', 'row B envelope');
assert(mixed[2].requestedEnvelope == null, 'row C has no envelope');
assert(mixed[0].requestedEnvelope !== mixed[1].requestedEnvelope, 'per-row envelopes');
assert(!mixed.some(t => /bad date|zero amount|missing amount/i.test(t.description)), 'skip undateable / unamountable');

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

const walmartSplit = normalizeIngestSplits([
  { envelope: 'Household / Misc', amount: 45.12 },
  { envelope: 'Groceries' },
], 100);
assert(walmartSplit?.length === 2, 'need two split lines');
assert(walmartSplit[0].amount === 45.12, 'first line keeps $45.12');
assert(walmartSplit[1].amount === 54.88, 'omitted amount takes the rest');
assert(walmartSplit[1].envelope === 'Groceries', 'rest line keeps Groceries');

const bothAmounts = normalizeIngestSplits([
  { category: 'Household / Misc', amount: 45.12 },
  { envelope: 'Groceries', amount: 54.88 },
], 100);
assert(bothAmounts?.[1].amount === 54.88, 'explicit rest amount');

assert(normalizeIngestSplits([
  { envelope: 'Household / Misc' },
  { envelope: 'Groceries' },
], 100) == null, 'two rest lines are invalid');
assert(normalizeIngestSplits([
  { envelope: 'Household / Misc', amount: 40 },
  { envelope: 'Groceries', amount: 50 },
], 100) == null, 'amounts that do not cover the total are invalid');

const splitRow = normalizeIngestTransactions([{
  date: '2026-08-30',
  amount: -100,
  description: 'WALMART #4428',
  pending: true,
  splits: [
    { envelope: 'Household / Misc', amount: 45.12 },
    { envelope: 'Groceries' },
  ],
}]);
assert(splitRow[0].requestedSplits?.[0].amount === 45.12, 'ingest captures split amounts');
assert(splitRow[0].requestedSplits?.[1].amount === 54.88, 'ingest fills rest');
assert(inboxRowsToImportObjects(splitRow)[0].Splits.length === 2, 'splits travel on import row');

const catsWithHouse = [
  { id: 'env-house', name: 'Household / Misc', parentId: null },
  { id: 'env-groceries', name: 'Groceries', parentId: null },
];
const resolvedSplit = resolveRequestedSplits(splitRow[0].requestedSplits, catsWithHouse, 100);
assert(resolvedSplit?.length === 2, 'split envelopes resolve');
assert(resolvedSplit[0].categoryId === 'env-house' && resolvedSplit[0].amount === 45.12, 'household line');
assert(resolvedSplit[1].categoryId === 'env-groceries' && resolvedSplit[1].amount === 54.88, 'groceries rest');
assert(resolveRequestedSplits(splitRow[0].requestedSplits, cats, 100) == null, 'unknown split envelope fails closed');

console.log('test-ingest-normalize: ok');
