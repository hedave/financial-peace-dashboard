/**
 * Pure helpers for editing an applied split in place (PATCH /api/transactions/:id/split)
 * and listing envelopes (GET /api/envelopes). No network, no DOM.
 */
import { toCents, fromCents, cleanText, txCents, isSplitTx } from './receipt-split.js';

export const EDIT_MAX_LINES = 10;
export const EDIT_MAX_AMOUNT = 1e6;
export const EDIT_NOTE_MAX = 200;
export const AUDIT_MAX = 200;
export const TX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const bad = message => ({ ok: false, code: 'invalid_body', message });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function validateLines(list, label) {
  if (!Array.isArray(list) || list.length < 1) return bad(`${label} must be a non-empty array`);
  if (list.length > EDIT_MAX_LINES) return bad(`${label}: max ${EDIT_MAX_LINES} lines`);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!isObj(s)) return bad(`${label}[${i}] must be an object`);
    const extra = Object.keys(s).find(k => k !== 'envelope' && k !== 'amount');
    if (extra) return bad(`Unknown field: ${label}[${i}].${cleanText(extra, 40)}`);
    if (typeof s.envelope !== 'string' || s.envelope.length > 80 || !cleanText(s.envelope, 80)) {
      return bad(`${label}[${i}].envelope must be a short non-empty string`);
    }
    const cents = toCents(s.amount);
    if (cents == null || cents <= 0 || cents > EDIT_MAX_AMOUNT * 100) {
      return bad(`${label}[${i}].amount must be > 0 and <= 1000000 with at most 2 decimals`);
    }
    out.push({ envelope: cleanText(s.envelope, 80), cents });
  }
  return { ok: true, value: out };
}

/** Strict body check: {expected, split, note?}; unknown keys rejected. */
export function validateEditBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = Object.keys(body).find(k => !['expected', 'split', 'note'].includes(k));
  if (extra) return bad(`Unknown field: ${cleanText(extra, 40)}`);
  const expected = validateLines(body.expected, 'expected');
  if (!expected.ok) return expected;
  const split = validateLines(body.split, 'split');
  if (!split.ok) return split;
  let note = '';
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > EDIT_NOTE_MAX) return bad(`note must be a string (max ${EDIT_NOTE_MAX})`);
    note = cleanText(body.note, EDIT_NOTE_MAX);
  }
  return { ok: true, value: { expected: expected.value, split: split.value, note } };
}

/** Top-level envelopes only (sub-categories are not split targets). Exact name, case-insensitive. */
function envelopeIndex(categories) {
  const map = new Map();
  for (const c of categories || []) {
    if (!c || !c.id || c.parentId) continue;
    map.set(String(c.name || '').trim().toLowerCase(), c);
  }
  return map;
}

export function envelopeNames(categories) {
  return [...envelopeIndex(categories).values()].map(c => String(c.name));
}

/** names → [{categoryId, cents}]. Never creates envelopes; repeats are refused. */
export function resolveLines(lines, categories) {
  const idx = envelopeIndex(categories);
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const c = idx.get(l.envelope.trim().toLowerCase());
    if (!c) return { ok: false, code: 'unknown_envelope', envelope: l.envelope };
    if (seen.has(c.id)) return { ok: false, code: 'invalid_body', message: `Envelope listed twice: ${c.name}` };
    seen.add(c.id);
    out.push({ categoryId: c.id, cents: l.cents });
  }
  return { ok: true, value: out };
}

const canon = lines => lines.map(l => `${l.categoryId}=${l.cents}`).sort().join(',');
export const currentLines = tx => (tx.splits || []).map(s => ({ categoryId: s.categoryId, cents: Math.round((Math.abs(Number(s.amount)) || 0) * 100) }));
export const publicLines = (lines, categories) => lines.map(l => ({
  envelope: (categories || []).find(c => c && c.id === l.categoryId)?.name || null,
  amount: fromCents(l.cents),
}));

/**
 * Plan a compare-and-swap edit against state. Returns
 *  {ok:true, tx, before, after, unchanged} or {ok:false, code, ...}.
 */
export function planSplitEdit(state, txId, input) {
  const tx = (state.transactions || []).find(t => t && t.id === txId);
  if (!tx) return { ok: false, code: 'not_found' };
  const cats = state.categories || [];
  if (!isSplitTx(tx)) return { ok: false, code: 'not_split', current: [] };
  const before = currentLines(tx);
  const exp = resolveLines(input.expected, cats);
  if (!exp.ok) return { ...exp, validEnvelopes: envelopeNames(cats) };
  if (canon(exp.value) !== canon(before)) return { ok: false, code: 'stale_expected', current: publicLines(before, cats) };
  const next = resolveLines(input.split, cats);
  if (!next.ok) return { ...next, validEnvelopes: envelopeNames(cats) };
  const total = txCents(tx);
  const sum = next.value.reduce((s, l) => s + l.cents, 0);
  if (sum !== total) return { ok: false, code: 'sum_mismatch', transactionAmount: fromCents(total), splitTotal: fromCents(sum) };
  return { ok: true, tx, before, after: next.value, unchanged: canon(next.value) === canon(before) };
}

/** Audit entry (stored in state.splitEditAudit, newest last, capped). */
export function appendAudit(state, entry) {
  const list = Array.isArray(state.splitEditAudit) ? state.splitEditAudit : [];
  list.push(entry);
  state.splitEditAudit = list.slice(-AUDIT_MAX);
}

/** Trimmed envelope list: id, name, group (parent name when nested). */
export function listEnvelopes(categories) {
  const cats = (categories || []).filter(c => c && c.id);
  const byId = new Map(cats.map(c => [c.id, c]));
  return cats.map(c => {
    const out = { id: String(c.id), name: cleanText(c.name, 80) };
    if (c.parentId && byId.get(c.parentId)) out.group = cleanText(byId.get(c.parentId).name, 80);
    if (c.isSinkingFund) out.sinkingFund = true;
    return out;
  });
}
