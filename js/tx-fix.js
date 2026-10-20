/**
 * Pure helpers for the budget-fix transaction API (netlify/functions/transactions-read.mjs,
 * transactions-void.mjs). No network, no DOM. FAKE DATA in tests only.
 *
 * Void mirrors store.deleteTransaction exactly (checking, debt payment, earmark carry,
 * refund link) but is applied to the RAW loaded budget, so hydration side effects
 * (rollover, auto-links, normalization) are never persisted. Restore mirrors
 * store.restoreDeletedTransaction.
 */
import { toCents, cleanText } from './receipt-split.js';

export const TX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const VOID_ID_RE = /^void_[a-f0-9]{16}$/;
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const LIST_MAX = 500;
export const VOID_LOG_MAX = 100;
export const NOTE_MAX = 200;
export const ACTOR = 'CoS';

const bad = message => ({ ok: false, code: 'invalid_body', message });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function unknownKey(obj, allowed) {
  const k = Object.keys(obj).find(x => !allowed.includes(x));
  return k === undefined ? null : cleanText(k, 40);
}

/** Query for GET /api/transactions: month and/or envelope (at least one). */
export function validateListQuery(params) {
  const keys = [...params.keys()];
  const extra = keys.find(k => !['month', 'envelope', 'limit'].includes(k));
  if (extra) return bad(`Unknown query parameter: ${cleanText(extra, 40)}`);
  if (keys.length !== new Set(keys).size) return bad('Repeated query parameter');
  const month = params.get('month');
  const envelope = params.get('envelope');
  const limitIn = params.get('limit');
  if (month == null && envelope == null) return bad('Give month=YYYY-MM and/or envelope=<name>');
  if (month != null && !MONTH_RE.test(month)) return bad('month must be YYYY-MM');
  if (envelope != null && (envelope.length > 80 || !cleanText(envelope, 80))) return bad('envelope must be a short non-empty name');
  let limit = LIST_MAX;
  if (limitIn != null) {
    if (!/^\d{1,3}$/.test(limitIn) || Number(limitIn) < 1 || Number(limitIn) > LIST_MAX) return bad(`limit must be 1..${LIST_MAX}`);
    limit = Number(limitIn);
  }
  return { ok: true, value: { month, envelope: envelope == null ? null : cleanText(envelope, 80), limit } };
}

function dryRunOf(body) {
  if (body.dry_run === undefined) return { ok: true, value: true };
  if (typeof body.dry_run !== 'boolean') return bad('dry_run must be true or false');
  return { ok: true, value: body.dry_run };
}
function noteOf(body) {
  if (body.note === undefined) return { ok: true, value: '' };
  if (typeof body.note !== 'string' || body.note.length > NOTE_MAX) return bad(`note must be a string (max ${NOTE_MAX})`);
  return { ok: true, value: cleanText(body.note, NOTE_MAX) };
}

/** {expected_amount, expected_date, dry_run?=true, note?} */
export function validateVoidBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = unknownKey(body, ['expected_amount', 'expected_date', 'dry_run', 'note']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const cents = toCents(body.expected_amount);
  if (cents == null || cents < 0 || cents > 1e8) return bad('expected_amount is required: number >= 0 (absolute amount) with at most 2 decimals');
  if (typeof body.expected_date !== 'string' || !DATE_RE.test(body.expected_date)) return bad('expected_date is required: YYYY-MM-DD');
  const dry = dryRunOf(body); if (!dry.ok) return dry;
  const note = noteOf(body); if (!note.ok) return note;
  return { ok: true, value: { expectedCents: cents, expectedDate: body.expected_date, dryRun: dry.value, note: note.value } };
}

/** {dry_run?=true, note?} */
export function validateVoidRestoreBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = unknownKey(body, ['dry_run', 'note']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const dry = dryRunOf(body); if (!dry.ok) return dry;
  const note = noteOf(body); if (!note.ok) return note;
  return { ok: true, value: { dryRun: dry.value, note: note.value } };
}

/** bank = came through import/bank sync (externalId, bankPending, or import's importCategory key); else manual. */
export function txSource(tx) {
  if (tx.externalId || tx.bankPending || Object.prototype.hasOwnProperty.call(tx, 'importCategory')) return 'bank';
  return 'manual';
}

function catMaps(state) {
  const cats = (state.categories || []).filter(c => c && c.id);
  return { byId: new Map(cats.map(c => [String(c.id), c])), cats };
}

/** Trimmed public row. */
export function publicTx(tx, byId) {
  const name = id => (id && byId.get(String(id)) ? cleanText(byId.get(String(id)).name, 80) : null);
  const out = {
    id: cleanText(tx.id, 128),
    date: typeof tx.date === 'string' ? tx.date.slice(0, 10) : null,
    amount: r2(Math.abs(Number(tx.amount) || 0)),
    type: ['expense', 'income', 'debt_payment', 'transfer'].includes(tx.type) ? tx.type : 'other',
    payee: cleanText(tx.description || '', 80),
    envelope: name(tx.categoryId),
    source: txSource(tx),
  };
  if (Array.isArray(tx.splits) && tx.splits.length) {
    out.envelope = null;
    out.splits = tx.splits.map(s => ({ envelope: name(s?.categoryId), amount: r2(s?.amount) }));
  }
  if (tx.clearingStatus === 'pending') out.pending = true;
  return out;
}

/** Filter by month (YYYY-MM prefix of date) and/or envelope (name, case-insensitive; matches subs' parent too via splits). */
export function listTransactions(state, { month, envelope, limit }) {
  const { byId, cats } = catMaps(state);
  let envId = null;
  if (envelope) {
    const key = envelope.trim().toLowerCase();
    const hit = cats.find(c => String(c.name || '').trim().toLowerCase() === key);
    if (!hit) return { ok: false, code: 'unknown_envelope', envelope, validEnvelopes: cats.filter(c => !c.parentId).map(c => cleanText(c.name, 80)) };
    envId = String(hit.id);
  }
  const rows = (state.transactions || []).filter(t => {
    if (!t || !t.id) return false;
    if (month && !(typeof t.date === 'string' && t.date.startsWith(`${month}-`))) return false;
    if (envId) {
      const inSplit = Array.isArray(t.splits) && t.splits.some(s => String(s?.categoryId) === envId);
      if (String(t.categoryId) !== envId && !inSplit) return false;
    }
    return true;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
  return {
    ok: true,
    total: rows.length,
    truncated: rows.length > limit,
    transactions: rows.slice(0, limit).map(t => publicTx(t, byId)),
  };
}

/** Check the void target against the caller's expectations. */
export function checkVoidTarget(raw, txId, input) {
  const tx = (raw.transactions || []).find(t => t && String(t.id) === txId);
  if (!tx) return { ok: false, code: 'not_found', status: 404 };
  const amt = Math.round(Math.abs(Number(tx.amount) || 0) * 100);
  const date = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
  if (amt !== input.expectedCents || date !== input.expectedDate) {
    return { ok: false, code: 'expected_mismatch', status: 409, actual: { amount: amt / 100, date } };
  }
  return { ok: true, tx };
}

/**
 * Remove tx from RAW state, mirroring store.deleteTransaction (helpers are the store's own,
 * passed in so this module stays store-free). Mutates `raw`. Returns effects summary.
 */
export function voidOnRaw(raw, txId, h) {
  const tx = raw.transactions.find(x => x && String(x.id) === txId);
  const snapshot = JSON.parse(JSON.stringify(tx));
  if (!raw.balances || typeof raw.balances !== 'object') raw.balances = { checking: 0 };
  const checkingBefore = Number(raw.balances.checking) || 0;
  const status = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
  h.applyCheckingDelta(raw, -h.getCheckingDelta(tx.type, tx.amount, status));
  let debt = false;
  if (tx.type === 'debt_payment' && tx.debtId) { h.adjustDebtForPayment(raw, tx.debtId, -Math.abs(Number(tx.amount) || 0)); debt = true; }
  const carry = !!(tx.type === 'income' && tx.earmarkedEnvelope && tx.categoryId);
  h.reverseEarmarkCarry(raw, tx, -1);
  if (tx.refundOfTxId) {
    const exp = raw.transactions.find(t => t && t.id === tx.refundOfTxId);
    if (exp) delete exp.refundedByTxId;
  }
  raw.transactions = raw.transactions.filter(x => !(x && String(x.id) === txId));
  return { snapshot, effects: { checking_before: r2(checkingBefore), checking_after: r2(raw.balances.checking), debt_adjusted: debt, carry_adjusted: carry } };
}

/** Re-insert, mirroring store.restoreDeletedTransaction (+ re-link a refund). Mutates `raw`. */
export function restoreOnRaw(raw, txSnap, h) {
  if (!raw.balances || typeof raw.balances !== 'object') raw.balances = { checking: 0 };
  const checkingBefore = Number(raw.balances.checking) || 0;
  const tx = JSON.parse(JSON.stringify(txSnap));
  raw.transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
  raw.transactions.unshift(tx);
  const status = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
  h.applyCheckingDelta(raw, h.getCheckingDelta(tx.type, tx.amount, status));
  if (tx.type === 'debt_payment' && tx.debtId) h.adjustDebtForPayment(raw, tx.debtId, Math.abs(Number(tx.amount) || 0));
  if (tx.earmarkedEnvelope && tx.type === 'income' && tx.categoryId) h.reverseEarmarkCarry(raw, tx, +1);
  if (tx.refundOfTxId) {
    const exp = raw.transactions.find(t => t && t.id === tx.refundOfTxId);
    if (exp && !exp.refundedByTxId) exp.refundedByTxId = tx.id;
  }
  return { checking_before: r2(checkingBefore), checking_after: r2(raw.balances.checking) };
}

/** Undo log in state.transactionVoids (newest last, capped; restored records are evicted first). */
export function addVoidRecord(raw, rec) {
  const list = Array.isArray(raw.transactionVoids) ? raw.transactionVoids : [];
  list.push(rec);
  while (list.length > VOID_LOG_MAX) {
    const i = list.findIndex(r => r && r.restored_at);
    list.splice(i >= 0 ? i : 0, 1);
  }
  raw.transactionVoids = list;
}

export function findVoid(raw, id) {
  return (Array.isArray(raw.transactionVoids) ? raw.transactionVoids : []).find(r => r && r.id === id) || null;
}
