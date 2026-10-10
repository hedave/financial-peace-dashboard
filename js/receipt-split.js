/**
 * Receipt → split for an EXISTING bank transaction (pure logic, no DOM, no store).
 *
 * Shared by the Netlify function (POST /api/transactions/split) and the browser
 * "Receipts to review" card, so both apply the same rules:
 *   - candidate = expense, |amount| within $0.03, date ±3 days, merchant
 *     similarity ≥ 0.6 (descriptionSimilarity), not already split.
 *     A match.externalId wins over the fuzzy search.
 *   - 0 or >1 candidates → refuse (no_match / multiple_matches).
 *   - splits must equal the bank amount within $0.03 (the same tolerance used
 *     to list the row as a candidate), else sum_mismatch. A gap of up to 3¢ is
 *     put on the largest split so the stored splits equal the bank amount
 *     exactly; the adjustment is reported (API) and shown (Receipts to review).
 *   - already split → already_split.
 *   - receiptId already on a row: compared by fingerprint (row id + split
 *     cents). Same → "unchanged"; different → receipt_conflict; the user
 *     removed / changed the split since → "removed_by_user" / "changed_by_user"
 *     (never re-applied).
 *   - an existing single envelope is only replaced when it is Groceries,
 *     Household / Misc, missing, or was set by a merchant rule
 *     (tx.categorySource === 'rule'); otherwise category_conflict.
 * Splits only: the bank amount and checking are never touched.
 */
import { descriptionSimilarity, resolveRequestedEnvelope } from './csv-import.js';

export const RECEIPT_REPLACEABLE_ENVELOPES = ['Groceries', 'Household / Misc'];
export const AMOUNT_TOLERANCE_CENTS = 3;
/** Receipt lines vs the receipt's own total (review intake). */
export const SUM_TOLERANCE_CENTS = 1;
/** Split total vs the BANK amount: same window as candidate matching, so a listed row can always be approved. */
export const BANK_TOLERANCE_CENTS = AMOUNT_TOLERANCE_CENTS;
export const DATE_WINDOW_DAYS = 3;
export const MERCHANT_MIN_SIMILARITY = 0.6;
export const MAX_SPLITS = 12;
export const MAX_ITEMS = 100;
export const MAX_PENDING_REVIEW = 50;
export const MAX_KEPT_DONE_REVIEW = 30;
export const MAX_REVIEW_CANDIDATES = 5;
export const MAX_AMOUNT = 1e6;
export const MEMO_MAX = 200;

export const RECEIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// C0/C1 control chars, bidi overrides, zero-width — never stored from the API.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export const REVIEW_REASONS = [
  'no_match', 'multiple_matches', 'sum_mismatch', 'already_split',
  'category_conflict', 'low_confidence',
];

/** Error code → HTTP status (the function uses this; the UI only uses the code). */
export const ERROR_STATUS = {
  invalid_body: 400,
  unknown_envelope: 422,
  invalid_splits: 422,
  sum_mismatch: 422,
  no_match: 404,
  multiple_matches: 409,
  already_split: 409,
  category_conflict: 409,
  not_expense: 409,
  receipt_conflict: 409,
  not_a_candidate: 409,
  review_full: 409,
  review_not_found: 404,
};

export const ERROR_MESSAGE = {
  no_match: 'No bank transaction fits this receipt (amount ±$0.03, date ±3 days, merchant).',
  multiple_matches: 'More than one bank transaction fits; send it to review instead.',
  sum_mismatch: 'Splits must add up to the bank amount (within $0.03).',
  already_split: 'That transaction is already split.',
  category_conflict: 'That transaction already has a different envelope set by hand.',
  not_expense: 'That transaction is not an expense.',
  receipt_conflict: 'That receiptId was already used for a different transaction or different splits.',
  not_a_candidate: 'That transaction is not one of this receipt’s candidates.',
  unknown_envelope: 'Envelope not found.',
  invalid_splits: 'Need at least two different envelopes with positive amounts.',
  review_full: 'Too many receipts waiting for review.',
  review_not_found: 'That receipt is not waiting for review.',
};

function fail(code, extra = {}) {
  return { ok: false, code, message: ERROR_MESSAGE[code] || code, ...extra };
}

function bad(message) {
  return { ok: false, code: 'invalid_body', message };
}

export function cleanText(value, max) {
  return String(value ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Whole cents; null when not a finite number with at most 2 decimals. */
export function toCents(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const c = Math.round(n * 100);
  if (Math.abs(n * 100 - c) > 1e-6) return null;
  return c;
}

export function fromCents(c) {
  return Math.round(c) / 100;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function unknownKey(obj, allowed) {
  return Object.keys(obj).find(k => !allowed.includes(k)) || null;
}

function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function dayDiff(a, b) {
  const da = Date.parse(`${String(a).slice(0, 10)}T12:00:00Z`);
  const db = Date.parse(`${String(b).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.round(Math.abs(da - db) / 86400000);
}

export function txCents(tx) {
  return Math.round(Math.abs(Number(tx?.amount) || 0) * 100);
}

export function isSplitTx(tx) {
  return Array.isArray(tx?.splits) && tx.splits.length > 0;
}

/** Validate a split list shape (envelope name/id + amount). Does not resolve names. */
function validateSplitList(list, label) {
  if (!Array.isArray(list) || !list.length) return bad(`${label} must be a non-empty array`);
  if (list.length > MAX_SPLITS) return bad(`${label}: max ${MAX_SPLITS} lines`);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!isPlainObject(s)) return bad(`${label}[${i}] must be an object`);
    const extra = unknownKey(s, ['envelope', 'amount']);
    if (extra) return bad(`Unknown field: ${label}[${i}].${extra}`);
    const envelope = typeof s.envelope === 'string' ? cleanText(s.envelope, 80) : '';
    if (!envelope || s.envelope.length > 80) return bad(`${label}[${i}].envelope must be a short non-empty string`);
    const cents = toCents(s.amount);
    if (cents == null || cents <= 0 || cents > MAX_AMOUNT * 100) {
      return bad(`${label}[${i}].amount must be a positive number with at most 2 decimals`);
    }
    out.push({ envelope, cents });
  }
  return { ok: true, value: out };
}

function validateMatch(match) {
  if (!isPlainObject(match)) return bad('match must be an object');
  const extra = unknownKey(match, ['externalId', 'date', 'amount', 'merchant']);
  if (extra) return bad(`Unknown field: match.${extra}`);
  const out = {};
  if ('externalId' in match) {
    if (typeof match.externalId !== 'string' || !match.externalId.trim() || match.externalId.length > 128) {
      return bad('match.externalId must be a non-empty string (max 128)');
    }
    out.externalId = match.externalId.trim();
  }
  const fuzzyKeys = ['date', 'amount', 'merchant'].filter(k => k in match);
  if (fuzzyKeys.length && fuzzyKeys.length < 3) {
    return bad('match needs date, amount and merchant together');
  }
  if (fuzzyKeys.length === 3) {
    if (!isIsoDate(match.date)) return bad('match.date must be YYYY-MM-DD');
    const cents = toCents(match.amount);
    if (cents == null || cents === 0 || Math.abs(cents) > MAX_AMOUNT * 100) {
      return bad('match.amount must be a non-zero number with at most 2 decimals');
    }
    if (typeof match.merchant !== 'string' || match.merchant.length > 120 || !cleanText(match.merchant, 120)) {
      return bad('match.merchant must be a non-empty string (max 120)');
    }
    out.date = match.date;
    out.cents = Math.abs(cents);
    out.merchant = cleanText(match.merchant, 120);
  }
  if (!out.externalId && !out.merchant) return bad('match needs externalId or date + amount + merchant');
  return { ok: true, value: out };
}

function validateReceiptId(v) {
  if (typeof v !== 'string' || !RECEIPT_ID_RE.test(v)) {
    return bad('receiptId must be 1-128 chars: letters, digits, . _ : -');
  }
  return { ok: true, value: v };
}

/**
 * Validate a review item posted by the bot. candidates / status are always
 * computed by FigPig, never accepted from the caller.
 */
export function validateReviewInput(r) {
  if (!isPlainObject(r)) return bad('receipt must be an object');
  const extra = unknownKey(r, ['receiptId', 'store', 'date', 'total', 'proposedSplits', 'items', 'reason']);
  if (extra) return bad(`Unknown field: receipt.${extra}`);
  const rid = validateReceiptId(r.receiptId);
  if (!rid.ok) return rid;
  if (typeof r.store !== 'string' || r.store.length > 80 || !cleanText(r.store, 80)) {
    return bad('receipt.store must be a non-empty string (max 80)');
  }
  if (!isIsoDate(r.date)) return bad('receipt.date must be YYYY-MM-DD');
  const totalCents = toCents(r.total);
  if (totalCents == null || totalCents <= 0 || totalCents > MAX_AMOUNT * 100) {
    return bad('receipt.total must be a positive number with at most 2 decimals');
  }
  const splits = validateSplitList(r.proposedSplits, 'receipt.proposedSplits');
  if (!splits.ok) return splits;
  let items = [];
  if ('items' in r) {
    if (!Array.isArray(r.items) || r.items.length > MAX_ITEMS) return bad(`receipt.items must be an array (max ${MAX_ITEMS})`);
    for (let i = 0; i < r.items.length; i++) {
      const it = r.items[i];
      if (!isPlainObject(it)) return bad(`receipt.items[${i}] must be an object`);
      const x = unknownKey(it, ['desc', 'amount', 'bucket', 'confidence']);
      if (x) return bad(`Unknown field: receipt.items[${i}].${x}`);
      if (typeof it.desc !== 'string' || it.desc.length > 120 || !cleanText(it.desc, 120)) {
        return bad(`receipt.items[${i}].desc must be a non-empty string (max 120)`);
      }
      const c = toCents(it.amount);
      if (c == null || c === 0 || Math.abs(c) > MAX_AMOUNT * 100) {
        return bad(`receipt.items[${i}].amount must be a non-zero number with at most 2 decimals`);
      }
      if (typeof it.bucket !== 'string' || it.bucket.length > 80 || !cleanText(it.bucket, 80)) {
        return bad(`receipt.items[${i}].bucket must be an envelope name`);
      }
      if ('confidence' in it && (typeof it.confidence !== 'number' || !(it.confidence >= 0 && it.confidence <= 1))) {
        return bad(`receipt.items[${i}].confidence must be 0..1`);
      }
      items.push({
        desc: cleanText(it.desc, 120),
        cents: c,
        bucket: cleanText(it.bucket, 80),
        ...('confidence' in it ? { confidence: Math.round(it.confidence * 100) / 100 } : {}),
      });
    }
  }
  let reason = 'low_confidence';
  if ('reason' in r) {
    if (!REVIEW_REASONS.includes(r.reason)) return bad(`receipt.reason must be one of ${REVIEW_REASONS.join(', ')}`);
    reason = r.reason;
  }
  return {
    ok: true,
    value: {
      receiptId: rid.value,
      store: cleanText(r.store, 80),
      date: r.date,
      totalCents,
      proposedSplits: splits.value,
      items,
      reason,
    },
  };
}

/**
 * Strict body check for POST /api/transactions/split.
 * Apply: {match, splits, receiptId, memo?, dryRun?}
 * Review: {review: true, receipt: {...}, dryRun?}
 */
export function validateSplitBody(body) {
  if (!isPlainObject(body)) return bad('JSON object required');
  if (body.review !== undefined && body.review !== true) return bad('review must be true when present');
  if ('dryRun' in body && typeof body.dryRun !== 'boolean') return bad('dryRun must be a boolean');
  const dryRun = body.dryRun === true;
  if (body.review === true) {
    const extra = unknownKey(body, ['review', 'receipt', 'dryRun']);
    if (extra) return bad(`Unknown field: ${extra}`);
    const rev = validateReviewInput(body.receipt);
    if (!rev.ok) return rev;
    return { ok: true, value: { mode: 'review', dryRun, receipt: rev.value } };
  }
  const extra = unknownKey(body, ['match', 'splits', 'receiptId', 'memo', 'dryRun']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const match = validateMatch(body.match);
  if (!match.ok) return match;
  const splits = validateSplitList(body.splits, 'splits');
  if (!splits.ok) return splits;
  const rid = validateReceiptId(body.receiptId);
  if (!rid.ok) return rid;
  let memo = '';
  if ('memo' in body) {
    if (typeof body.memo !== 'string' || body.memo.length > MEMO_MAX) return bad(`memo must be a string (max ${MEMO_MAX})`);
    memo = cleanText(body.memo, MEMO_MAX);
  }
  return {
    ok: true,
    value: { mode: 'apply', dryRun, match: match.value, splits: splits.value, receiptId: rid.value, memo },
  };
}

/**
 * Resolve envelope names/ids → [{categoryId, cents}], merging repeats.
 * Needs ≥ 2 distinct envelopes.
 */
export function resolveSplitEnvelopes(lines, categories) {
  const byId = new Map();
  for (const line of lines || []) {
    const id = line.categoryId || resolveRequestedEnvelope(line.envelope, categories || []);
    if (!id || !(categories || []).some(c => c && c.id === id)) {
      return fail('unknown_envelope', { envelope: cleanText(line.envelope || line.categoryId, 80) });
    }
    byId.set(id, (byId.get(id) || 0) + line.cents);
  }
  const out = [...byId.entries()].map(([categoryId, cents]) => ({ categoryId, cents }));
  if (out.length < 2 || out.some(s => !(s.cents > 0))) return fail('invalid_splits');
  return { ok: true, value: out };
}

/**
 * Splits must equal the bank amount within BANK_TOLERANCE_CENTS (3¢). The gap
 * goes on the largest line (first one on ties) so the stored splits sum
 * exactly to the bank amount. Returns which line moved and by how much.
 */
export function reconcileSplitCents(lines, bankCents, tolerance = BANK_TOLERANCE_CENTS) {
  const sum = lines.reduce((s, l) => s + l.cents, 0);
  const diff = bankCents - sum;
  if (Math.abs(diff) > tolerance) {
    return fail('sum_mismatch', { bankAmount: fromCents(bankCents), splitsTotal: fromCents(sum) });
  }
  const out = lines.map(l => ({ ...l }));
  let adjustedCategoryId = null;
  if (diff !== 0) {
    let big = 0;
    out.forEach((l, i) => { if (l.cents > out[big].cents) big = i; });
    out[big].cents += diff;
    if (out[big].cents <= 0) return fail('sum_mismatch', { bankAmount: fromCents(bankCents), splitsTotal: fromCents(sum) });
    adjustedCategoryId = out[big].categoryId ?? null;
  }
  return { ok: true, value: out, adjustedCents: diff, adjustedCategoryId };
}

/** "+3¢ on Groceries to match bank" (null when no adjustment). */
export function describeAdjustment(cents, envelopeName) {
  if (!cents) return null;
  const sign = cents > 0 ? '+' : '\u2212';
  return `${sign}${Math.abs(cents)}¢ on ${envelopeName || 'the largest envelope'} to match bank`;
}

/** Stable fingerprint of an applied receipt: row id + split cents per envelope. */
export function receiptFingerprint(txId, splits) {
  const parts = (splits || [])
    .map(sp => `${sp.categoryId}=${sp.cents ?? Math.round((Number(sp.amount) || 0) * 100)}`)
    .sort();
  return `${txId}|${parts.join(',')}`;
}

/** Fuzzy candidates (any split state). */
export function fuzzyCandidates(transactions, { date, cents, merchant }) {
  return (transactions || []).filter(t =>
    t && t.type === 'expense'
    && Math.abs(txCents(t) - cents) <= AMOUNT_TOLERANCE_CENTS
    && dayDiff(t.date, date) <= DATE_WINDOW_DAYS
    && descriptionSimilarity(merchant, t.description) >= MERCHANT_MIN_SIMILARITY,
  );
}

/** Find the one transaction a receipt belongs to. */
export function findSplitCandidate(state, match) {
  const txs = Array.isArray(state?.transactions) ? state.transactions : [];
  if (match.externalId) {
    const hits = txs.filter(t => t && t.externalId && String(t.externalId) === match.externalId);
    if (hits.length === 1) {
      if (hits[0].type !== 'expense') return fail('not_expense');
      if (isSplitTx(hits[0])) return fail('already_split');
      return { ok: true, tx: hits[0] };
    }
    if (hits.length > 1) return fail('multiple_matches', { count: hits.length });
    if (!match.merchant) return fail('no_match');
  }
  const all = fuzzyCandidates(txs, match);
  const open = all.filter(t => !isSplitTx(t));
  if (open.length === 1) return { ok: true, tx: open[0] };
  if (open.length > 1) return fail('multiple_matches', { count: open.length });
  if (all.length) return fail('already_split');
  return fail('no_match');
}

export function categoryAllowsReceipt(tx, categories) {
  if (!tx?.categoryId) return true;
  if (tx.categorySource === 'rule') return true;
  const cat = (categories || []).find(c => c && c.id === tx.categoryId);
  if (!cat) return true; // envelope deleted → effectively uncategorized
  return RECEIPT_REPLACEABLE_ENVELOPES.includes(cat.name);
}

/**
 * Plan a split on a specific transaction. Pure: no mutation.
 * @returns {{ok:true, tx, splits:[{categoryId, amount}], adjustedCents} | {ok:false, code}}
 */
export function planSplitForTx(state, tx, lines) {
  if (!tx || tx.type !== 'expense') return fail('not_expense');
  if (isSplitTx(tx)) return fail('already_split');
  if (!categoryAllowsReceipt(tx, state?.categories)) return fail('category_conflict');
  const rec = reconcileSplitCents(lines, txCents(tx));
  if (!rec.ok) return rec;
  return {
    ok: true,
    tx,
    splits: rec.value.map(l => ({ categoryId: l.categoryId, amount: fromCents(l.cents) })),
    adjustedCents: rec.adjustedCents,
    adjustedCategoryId: rec.adjustedCategoryId,
    fingerprint: receiptFingerprint(tx.id, rec.value),
  };
}

/** Transaction already carrying this receiptId (idempotency). */
export function findReceiptTx(state, receiptId) {
  return (state?.transactions || []).find(t => t && t.receiptId === receiptId) || null;
}

/** Does this request's match point at `tx`? externalId wins when any row carries it. */
function requestTargetsTx(state, match, tx) {
  if (match.externalId) {
    const owner = (state?.transactions || []).find(t => t && t.externalId && String(t.externalId) === match.externalId);
    if (owner) return owner.id === tx.id;
    if (!match.merchant) return false;
  }
  return fuzzyCandidates([tx], match).length === 1;
}

/**
 * The receiptId is already on `done`. Never writes.
 *   request ≠ stored fingerprint (other row or other split cents) → receipt_conflict
 *   user removed the split since → status removed_by_user
 *   user changed the split since → status changed_by_user
 *   otherwise → status unchanged (idempotent retry)
 */
function planRepeat(state, input, done, resolvedLines) {
  const stored = typeof done.receiptFingerprint === 'string' && done.receiptFingerprint
    ? done.receiptFingerprint
    : receiptFingerprint(done.id, done.splits || []);
  const rec = reconcileSplitCents(resolvedLines, txCents(done));
  const requested = rec.ok && requestTargetsTx(state, input.match, done)
    ? receiptFingerprint(done.id, rec.value)
    : null;
  if (requested !== stored) return fail('receipt_conflict');
  if (!isSplitTx(done)) return { ok: true, status: 'removed_by_user', tx: done, splits: [] };
  if (receiptFingerprint(done.id, done.splits) !== stored) {
    return { ok: true, status: 'changed_by_user', tx: done, splits: done.splits };
  }
  return { ok: true, status: 'unchanged', tx: done, splits: done.splits };
}

/**
 * Full plan for an API apply request (validated input from validateSplitBody).
 * A receiptId already on a row never writes (see planRepeat).
 */
export function planReceiptSplit(state, input) {
  const resolved = resolveSplitEnvelopes(input.splits, state?.categories);
  const done = findReceiptTx(state, input.receiptId);
  if (done) {
    if (!resolved.ok) return fail('receipt_conflict');
    return planRepeat(state, input, done, resolved.value);
  }
  if (!resolved.ok) return resolved;
  const found = findSplitCandidate(state, input.match);
  if (!found.ok) return found;
  const plan = planSplitForTx(state, found.tx, resolved.value);
  if (!plan.ok) return plan;
  return { ...plan, status: 'ready' };
}

export function candidateSummary(tx) {
  return {
    id: String(tx.id),
    date: String(tx.date || '').slice(0, 10),
    amount: fromCents(txCents(tx)),
    description: cleanText(tx.description, 120),
  };
}

export function publicSplits(splits, categories) {
  return (splits || []).map(s => ({
    envelope: (categories || []).find(c => c && c.id === s.categoryId)?.name || null,
    amount: Math.round((Number(s.amount) || 0) * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------
// Receipts to review (state.receiptReview)
// ---------------------------------------------------------------------------

/** Live candidates for a review item: fuzzy match on store / date / total, unsplit only. */
export function reviewCandidates(state, item) {
  const fuzzy = fuzzyCandidates(state?.transactions, {
    date: item.date,
    cents: item.totalCents,
    merchant: item.store,
  }).filter(t => !isSplitTx(t));
  return fuzzy.slice(0, MAX_REVIEW_CANDIDATES);
}

/** Build the stored review item from validated input. Resolves envelope names to ids. */
export function buildReviewItem(state, input, nowIso = new Date().toISOString()) {
  const resolved = resolveSplitEnvelopes(input.proposedSplits, state?.categories);
  if (!resolved.ok) return resolved;
  const sum = resolved.value.reduce((s, l) => s + l.cents, 0);
  if (Math.abs(sum - input.totalCents) > SUM_TOLERANCE_CENTS) {
    return fail('sum_mismatch', { bankAmount: fromCents(input.totalCents), splitsTotal: fromCents(sum) });
  }
  const items = [];
  for (const it of input.items || []) {
    const id = resolveRequestedEnvelope(it.bucket, state?.categories || []);
    if (!id) return fail('unknown_envelope', { envelope: it.bucket });
    items.push({
      desc: it.desc,
      amount: fromCents(it.cents),
      bucket: id,
      ...(it.confidence !== undefined ? { confidence: it.confidence } : {}),
    });
  }
  const item = {
    receiptId: input.receiptId,
    store: input.store,
    date: input.date,
    total: fromCents(input.totalCents),
    proposedSplits: resolved.value.map(l => ({ categoryId: l.categoryId, amount: fromCents(l.cents) })),
    items,
    candidates: [],
    reason: input.reason,
    status: 'pending',
    createdAt: nowIso,
  };
  item.candidates = reviewCandidates(state, { ...item, totalCents: input.totalCents }).map(t => String(t.id));
  return { ok: true, value: item };
}

/**
 * Insert or refresh a pending review item. Idempotent by receiptId:
 * applied / dismissed items and receipts already on a transaction stay put.
 * Mutates state.receiptReview.
 */
export function upsertReviewItem(state, item) {
  if (!Array.isArray(state.receiptReview)) state.receiptReview = [];
  if (findReceiptTx(state, item.receiptId)) return { ok: true, status: 'unchanged' };
  const idx = state.receiptReview.findIndex(r => r && r.receiptId === item.receiptId);
  if (idx >= 0) {
    const prev = state.receiptReview[idx];
    if (prev.status !== 'pending') return { ok: true, status: 'unchanged' };
    state.receiptReview[idx] = { ...item, createdAt: prev.createdAt || item.createdAt };
    return { ok: true, status: 'updated' };
  }
  const pending = state.receiptReview.filter(r => r && r.status === 'pending').length;
  if (pending >= MAX_PENDING_REVIEW) return fail('review_full');
  state.receiptReview.push(item);
  return { ok: true, status: 'queued' };
}

/** Mark a review item done and keep the done-list short. Mutates state. */
export function closeReviewItem(state, receiptId, status, extra = {}) {
  const list = Array.isArray(state.receiptReview) ? state.receiptReview : [];
  const item = list.find(r => r && r.receiptId === receiptId);
  if (!item) return false;
  item.status = status;
  item.closedAt = new Date().toISOString();
  Object.assign(item, extra);
  const done = list.filter(r => r.status !== 'pending');
  if (done.length > MAX_KEPT_DONE_REVIEW) {
    const drop = new Set(done
      .sort((a, b) => String(a.closedAt || '').localeCompare(String(b.closedAt || '')))
      .slice(0, done.length - MAX_KEPT_DONE_REVIEW));
    state.receiptReview = list.filter(r => !drop.has(r));
  }
  return true;
}

/** Drop malformed review entries (runs in normalizeState; never throws). */
export function sanitizeReceiptReview(list) {
  if (!Array.isArray(list)) return [];
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
  return list.filter(r => isPlainObject(r) && typeof r.receiptId === 'string' && RECEIPT_ID_RE.test(r.receiptId))
    .slice(-(MAX_PENDING_REVIEW + MAX_KEPT_DONE_REVIEW))
    .map(r => ({
      receiptId: r.receiptId,
      ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt.slice(0, 40) } : {}),
      ...(typeof r.closedAt === 'string' ? { closedAt: r.closedAt.slice(0, 40) } : {}),
      ...(r.appliedTxId ? { appliedTxId: String(r.appliedTxId).slice(0, 64) } : {}),
      store: cleanText(r.store, 80),
      date: isIsoDate(r.date) ? r.date : '',
      total: num(r.total),
      proposedSplits: (Array.isArray(r.proposedSplits) ? r.proposedSplits : [])
        .filter(isPlainObject).slice(0, MAX_SPLITS)
        .map(s => ({ categoryId: String(s.categoryId || ''), amount: num(s.amount) })),
      items: (Array.isArray(r.items) ? r.items : []).filter(isPlainObject).slice(0, MAX_ITEMS)
        .map(i => ({
          desc: cleanText(i.desc, 120),
          amount: num(i.amount),
          bucket: String(i.bucket || ''),
          ...(typeof i.confidence === 'number' ? { confidence: num(i.confidence) } : {}),
        })),
      candidates: (Array.isArray(r.candidates) ? r.candidates : []).map(String).slice(0, MAX_REVIEW_CANDIDATES),
      reason: REVIEW_REASONS.includes(r.reason) ? r.reason : 'low_confidence',
      status: ['pending', 'applied', 'dismissed'].includes(r.status) ? r.status : 'pending',
    }));
}

/**
 * Edit view: bucket totals from item assignments. Items are pre-tax; the gap
 * to the receipt total (tax, coupons) is spread across buckets in proportion
 * to their item totals (largest remainder, whole cents) so the result sums to
 * the receipt total exactly.
 * @param {{total:number, items:{amount:number}[]}} item
 * @param {string[]} buckets  categoryId per item (same order as item.items)
 * @returns {{ok:true, value:[{categoryId, cents}]} | {ok:false, code}}
 */
export function splitsFromItemBuckets(item, buckets) {
  const totalCents = Math.round((Number(item?.total) || 0) * 100);
  const sums = new Map();
  (item?.items || []).forEach((it, i) => {
    const id = buckets[i] || it.bucket;
    sums.set(id, (sums.get(id) || 0) + Math.round((Number(it.amount) || 0) * 100));
  });
  const entries = [...sums.entries()].filter(([, c]) => c !== 0);
  const base = entries.reduce((s, [, c]) => s + c, 0);
  if (!entries.length || base <= 0 || entries.some(([, c]) => c < 0)) return fail('invalid_splits');
  const raw = entries.map(([categoryId, c]) => {
    const exact = (c * totalCents) / base;
    return { categoryId, cents: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = totalCents - raw.reduce((s, r) => s + r.cents, 0);
  [...raw].sort((a, b) => b.rem - a.rem).forEach(r => { if (left > 0) { r.cents += 1; left -= 1; } });
  const out = raw.filter(r => r.cents > 0).map(({ categoryId, cents }) => ({ categoryId, cents }));
  if (out.length < 2) return fail('invalid_splits');
  return { ok: true, value: out };
}
