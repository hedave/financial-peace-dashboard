/**
 * Forgive overspend (POST /api/envelopes/forgive-overspend). Pure helpers, no network/DOM.
 *
 * Representation: a month-only envelope move in state.monthEnvelopeMoves[month] with NO source
 * envelope — {id, fromId: null, toId, amount, source: 'forgiven', forgiveBatchId, note, at}.
 * store.getEnvelopeMoveDelta credits toId and debits nothing (fromId null never matches an
 * envelope), so getCategoryRemaining / getCategoryPool / the Budget page / month rollover all
 * honor it, while monthlyBudget, carryOver, checking, bonus pot and total_allocated (so
 * unallocated) are untouched. Never deletes transactions, never touches bills.
 */
import { toCents, fromCents, cleanText } from './receipt-split.js';
import { getCurrentMonth } from './utils.js';
const NOTE_MAX = 200;
const RESET_MAX_TARGETS = 100;
const STATE_HASH_RE = /^[a-f0-9]{64}$/;

export const FORGIVEN_SOURCE = 'forgiven';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const bad = message => ({ ok: false, code: 'invalid_body', message });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cents = n => Math.round((Number(n) || 0) * 100);

export const isForgivenMove = m => !!m && typeof m === 'object' && m.source === FORGIVEN_SOURCE && !m.fromId;

/** {expected_state_hash, month?, targets:"all_negative"|[{envelope, expected_remaining}], dry_run?, note?} */
export function validateForgiveBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = Object.keys(body).find(k => !['expected_state_hash', 'month', 'targets', 'dry_run', 'note'].includes(k));
  if (extra !== undefined) return bad(`Unknown field: ${cleanText(extra, 40)}`);
  if (typeof body.expected_state_hash !== 'string' || !STATE_HASH_RE.test(body.expected_state_hash)) {
    return bad('expected_state_hash is required (64 hex chars from GET /api/envelopes)');
  }
  const current = getCurrentMonth();
  let month = current;
  if (body.month !== undefined) {
    if (typeof body.month !== 'string' || !MONTH_RE.test(body.month)) return bad('month must be YYYY-MM');
    if (body.month > current) return bad('month cannot be in the future');
    month = body.month;
  }
  let targets;
  if (body.targets === 'all_negative') targets = 'all_negative';
  else if (Array.isArray(body.targets) && body.targets.length) {
    if (body.targets.length > RESET_MAX_TARGETS) return bad(`targets: max ${RESET_MAX_TARGETS}`);
    targets = [];
    for (let i = 0; i < body.targets.length; i++) {
      const t = body.targets[i];
      if (!isObj(t)) return bad(`targets[${i}] must be an object`);
      const ex = Object.keys(t).find(k => !['envelope', 'expected_remaining'].includes(k));
      if (ex !== undefined) return bad(`Unknown field: targets[${i}].${cleanText(ex, 40)}`);
      if (typeof t.envelope !== 'string' || t.envelope.length > 80 || !cleanText(t.envelope, 80)) return bad(`targets[${i}].envelope must be a short non-empty string`);
      const c = toCents(t.expected_remaining);
      if (c == null || Math.abs(c) > 1e8) return bad(`targets[${i}].expected_remaining must be a number with at most 2 decimals`);
      targets.push({ envelope: cleanText(t.envelope, 80), expectedCents: c });
    }
  } else return bad('targets must be "all_negative" or a non-empty array of {envelope, expected_remaining}');
  let dryRun = true;
  if (body.dry_run !== undefined) {
    if (typeof body.dry_run !== 'boolean') return bad('dry_run must be true or false');
    dryRun = body.dry_run;
  }
  let note = '';
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > NOTE_MAX) return bad(`note must be a string (max ${NOTE_MAX})`);
    note = cleanText(body.note, NOTE_MAX);
  }
  return { ok: true, value: { expectedHash: body.expected_state_hash, month, targets, dryRun, note } };
}

const tops = state => (state.categories || []).filter(c => c && c.id && !c.parentId);

/** Plan against the hydrated store. Errors: unknown_envelope / invalid_body (400), not_overspent (400), remaining_mismatch (409), nothing_to_forgive (400). */
export function planForgive(store, input) {
  const state = store.getState();
  const month = input.month;
  const list = tops(state);
  const rem = c => cents(store.getCategoryRemaining(c.id, month));
  let picked = [];
  if (input.targets === 'all_negative') {
    picked = list.filter(c => rem(c) < 0);
    if (!picked.length) return { ok: false, code: 'nothing_to_forgive', status: 400, month };
  } else {
    const mismatches = []; const notOver = []; const seen = new Set();
    for (const t of input.targets) {
      const key = t.envelope.trim().toLowerCase();
      const c = list.find(x => String(x.name || '').trim().toLowerCase() === key);
      if (!c) return { ok: false, code: 'unknown_envelope', status: 400, envelope: t.envelope, validEnvelopes: list.map(x => cleanText(x.name, 80)) };
      if (seen.has(c.id)) return { ok: false, code: 'invalid_body', status: 400, message: `Envelope listed twice: ${cleanText(c.name, 80)}` };
      seen.add(c.id);
      const actual = rem(c);
      if (actual !== t.expectedCents) mismatches.push({ envelope: cleanText(c.name, 80), expected_remaining: t.expectedCents / 100, actual_remaining: actual / 100 });
      else if (actual >= 0) notOver.push({ envelope: cleanText(c.name, 80), remaining: actual / 100 });
      picked.push(c);
    }
    if (mismatches.length) return { ok: false, code: 'remaining_mismatch', status: 409, mismatches };
    if (notOver.length) return { ok: false, code: 'not_overspent', status: 400, envelopes: notOver };
  }
  const rows = picked.map(c => ({ id: String(c.id), name: cleanText(c.name, 80), cents: -rem(c) }));
  const others = list.filter(c => !picked.includes(c)).map(c => ({ id: c.id, cents: rem(c) }));
  return { ok: true, month, rows, others, totalCents: rows.reduce((s, r) => s + r.cents, 0) };
}

/** Write the offset moves into the hydrated store (persist:false). Returns the rows. */
export function applyForgiveInMemory(store, plan, { at, batchId, newId, note = '' }) {
  const label = note ? ` — ${note}` : '';
  const moves = plan.rows.map(r => ({
    id: newId(), fromId: null, toId: r.id, amount: fromCents(r.cents), source: FORGIVEN_SOURCE,
    forgiveBatchId: batchId, note: `Forgiven overspend${label}`, at,
  }));
  store.update(s => {
    if (!isObj(s.monthEnvelopeMoves)) s.monthEnvelopeMoves = {};
    if (!Array.isArray(s.monthEnvelopeMoves[plan.month])) s.monthEnvelopeMoves[plan.month] = [];
    for (const m of moves) s.monthEnvelopeMoves[plan.month].push({ ...m });
  }, { persist: false });
  return moves;
}

/** Read back: every target at exactly 0, every other top-level envelope unchanged. */
export function verifyForgive(store, plan) {
  for (const r of plan.rows) if (cents(store.getCategoryRemaining(r.id, plan.month)) !== 0) return false;
  for (const o of plan.others) if (cents(store.getCategoryRemaining(o.id, plan.month)) !== o.cents) return false;
  return true;
}

/** Append the same rows to the raw cloud row. null if an envelope id is missing there. */
export function appendForgiveRows(raw, month, moves) {
  const ids = new Set((raw.categories || []).filter(c => c && c.id).map(c => String(c.id)));
  if (moves.some(m => !ids.has(String(m.toId)))) return null;
  if (!isObj(raw.monthEnvelopeMoves)) raw.monthEnvelopeMoves = {};
  raw.monthEnvelopeMoves[month] = [...(Array.isArray(raw.monthEnvelopeMoves[month]) ? raw.monthEnvelopeMoves[month] : []), ...moves];
  return raw;
}

/** Every forgiven move, by month (deep copies). Stored in each snapshot so restore can undo forgives. */
export function collectForgiven(state) {
  const out = {};
  const all = isObj(state.monthEnvelopeMoves) ? state.monthEnvelopeMoves : {};
  for (const [m, list] of Object.entries(all)) {
    if (!Array.isArray(list)) continue;
    const f = list.filter(isForgivenMove);
    if (f.length) out[m] = JSON.parse(JSON.stringify(f));
  }
  return out;
}

/**
 * Make the forgiven moves exactly `wanted` ({month:[rows]}); non-forgiven moves untouched.
 * A month list emptied by this is removed. Mutates `state`. Returns true if anything changed.
 */
export function setForgiven(state, wanted) {
  const want = isObj(wanted) ? wanted : {};
  if (!isObj(state.monthEnvelopeMoves)) state.monthEnvelopeMoves = {};
  const all = state.monthEnvelopeMoves;
  let changed = false;
  for (const m of new Set([...Object.keys(all), ...Object.keys(want)])) {
    const cur = Array.isArray(all[m]) ? all[m] : [];
    const keep = cur.filter(x => !isForgivenMove(x));
    const add = Array.isArray(want[m]) ? JSON.parse(JSON.stringify(want[m])) : [];
    const curF = JSON.stringify(cur.filter(isForgivenMove));
    if (curF === JSON.stringify(add)) continue;
    changed = true;
    const next = [...keep, ...add];
    if (next.length) all[m] = next; else delete all[m];
  }
  return changed;
}
