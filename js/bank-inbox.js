import { store } from './store.js';
import {
  listPendingBankInbox,
  markBankInbox,
  isNotesOnlyRole,
} from './cloud-sync.js';
import { inboxRowsToImportObjects } from './ingest-normalize.js';

let cached = [];
let lastError = null;

export function getCachedBankInbox() {
  return cached;
}

export function bankInboxError() {
  return lastError;
}

export async function refreshBankInboxCache() {
  lastError = null;
  if (isNotesOnlyRole()) {
    cached = [];
    return cached;
  }
  try {
    cached = await listPendingBankInbox();
  } catch (err) {
    lastError = err;
    cached = [];
  }
  return cached;
}

function flattenTransactions(batches) {
  const rows = [];
  for (const batch of batches) {
    const txs = batch?.payload?.transactions;
    if (!Array.isArray(txs)) continue;
    rows.push(...inboxRowsToImportObjects(txs));
  }
  return rows;
}

/**
 * Apply every pending CoS/Grok drop through the same import engine as paste/CSV.
 * Marks batches applied (or rejected if empty).
 */
export async function applyPendingBankInbox({ includePending = true } = {}) {
  const batches = cached.length ? cached : await refreshBankInboxCache();
  if (!batches.length) return { empty: true, stats: null, batchCount: 0 };

  const rows = flattenTransactions(batches);
  const stats = !rows.length
    ? { count: 0, skipped: 0, duplicates: 0, parsed: 0, matchedPending: 0 }
    : store.importTransactions(rows, { includePending });

  const status = rows.length ? 'applied' : 'rejected';
  await Promise.all(batches.map((b) => markBankInbox(b.id, status, stats)));
  cached = [];
  return { empty: false, stats, batchCount: batches.length };
}

export function inboxMerchantPreview(batches, limit = 3) {
  const names = [];
  for (const batch of batches || []) {
    for (const t of batch?.payload?.transactions || []) {
      const d = String(t.description || '').trim();
      if (d) names.push(d);
      if (names.length >= limit) return names;
    }
  }
  return names;
}

export function inboxTransactionCount(batches) {
  let n = 0;
  for (const batch of batches || []) {
    n += Array.isArray(batch?.payload?.transactions) ? batch.payload.transactions.length : 0;
  }
  return n;
}
