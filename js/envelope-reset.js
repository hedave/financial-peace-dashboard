/**
 * Pure helpers for the envelope balances / snapshot / restore / reset API
 * (netlify/functions/envelopes.mjs + envelopes-write.mjs). No network, no DOM.
 *
 * Everything reads through the live `store` getters (the same numbers the Budget page
 * shows) and writes allocations through `store.update(..., {persist:false})` with the
 * same mutation the Edit Envelope modal makes (`cat.monthlyBudget = amount`). Budget,
 * snowball and transaction math are not reimplemented or changed here.
 */
import { toCents, fromCents, cleanText } from './receipt-split.js';
import { getCurrentMonth } from './utils.js';

export const RESET_MAX_TARGETS = 100;
export const RESET_MAX_AMOUNT = 1e6;
export const NOTE_MAX = 200;
export const SNAPSHOT_MAX = 30;
export const AUDIT_MAX = 200;
export const SNAPSHOT_ID_RE = /^snap_[a-f0-9]{16}$/;
export const STATE_HASH_RE = /^[a-f0-9]{64}$/;
export const ACTOR = 'CoS';

const bad = message => ({ ok: false, code: 'invalid_body', message });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function unknownKey(obj, allowed) {
  const k = Object.keys(obj).find(x => !allowed.includes(x));
  return k === undefined ? null : cleanText(k, 40);
}

function noteOf(body) {
  if (body.note === undefined) return { ok: true, value: '' };
  if (typeof body.note !== 'string' || body.note.length > NOTE_MAX) return bad(`note must be a string (max ${NOTE_MAX})`);
  return { ok: true, value: cleanText(body.note, NOTE_MAX) };
}

function dryRunOf(body) {
  if (body.dry_run === undefined) return { ok: true, value: true };
  if (typeof body.dry_run !== 'boolean') return bad('dry_run must be true or false');
  return { ok: true, value: body.dry_run };
}

function hashOf(body) {
  if (typeof body.expected_state_hash !== 'string' || !STATE_HASH_RE.test(body.expected_state_hash)) {
    return bad('expected_state_hash is required (64 hex chars from GET /api/envelopes)');
  }
  return { ok: true, value: body.expected_state_hash };
}

function amountOf(v, label) {
  const cents = toCents(v);
  if (cents == null || cents < 0 || cents > RESET_MAX_AMOUNT * 100) {
    return bad(`${label} must be a number >= 0 and <= 1000000 with at most 2 decimals`);
  }
  return { ok: true, value: cents };
}

/** {dry_run?, expected_state_hash, targets?, default_amount?, note?}; unknown keys rejected. */
export function validateResetBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = unknownKey(body, ['dry_run', 'expected_state_hash', 'targets', 'default_amount', 'note']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const dry = dryRunOf(body); if (!dry.ok) return dry;
  const hash = hashOf(body); if (!hash.ok) return hash;
  const targetsIn = body.targets === undefined ? [] : body.targets;
  if (!Array.isArray(targetsIn)) return bad('targets must be an array');
  if (targetsIn.length > RESET_MAX_TARGETS) return bad(`targets: max ${RESET_MAX_TARGETS}`);
  const targets = [];
  for (let i = 0; i < targetsIn.length; i++) {
    const t = targetsIn[i];
    if (!isObj(t)) return bad(`targets[${i}] must be an object`);
    const ex = unknownKey(t, ['envelope', 'amount']);
    if (ex) return bad(`Unknown field: targets[${i}].${ex}`);
    if (typeof t.envelope !== 'string' || t.envelope.length > 80 || !cleanText(t.envelope, 80)) {
      return bad(`targets[${i}].envelope must be a short non-empty string`);
    }
    const a = amountOf(t.amount, `targets[${i}].amount`); if (!a.ok) return a;
    targets.push({ envelope: cleanText(t.envelope, 80), cents: a.value });
  }
  let defaultCents = null;
  if (body.default_amount !== undefined) {
    const d = amountOf(body.default_amount, 'default_amount'); if (!d.ok) return d;
    defaultCents = d.value;
  }
  if (!targets.length && defaultCents == null) return bad('Nothing to do: give targets and/or default_amount');
  const note = noteOf(body); if (!note.ok) return note;
  return { ok: true, value: { dryRun: dry.value, expectedHash: hash.value, targets, defaultCents, note: note.value } };
}

function envelopeName(v, label) {
  if (typeof v !== 'string' || v.length > 80 || !cleanText(v, 80)) return bad(`${label} must be a short non-empty string`);
  return { ok: true, value: cleanText(v, 80) };
}

/**
 * Start fresh: {dry_run?, expected_state_hash, envelopes: "all" | [names], note?}.
 * `envelopes` is required (no implicit "all") so a typo can never zero everything.
 */
export function validateStartFreshBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = unknownKey(body, ['dry_run', 'expected_state_hash', 'envelopes', 'note']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const dry = dryRunOf(body); if (!dry.ok) return dry;
  const hash = hashOf(body); if (!hash.ok) return hash;
  let envelopes;
  if (body.envelopes === 'all') envelopes = 'all';
  else if (Array.isArray(body.envelopes)) {
    if (!body.envelopes.length) return bad('envelopes must be "all" or a non-empty array of names');
    if (body.envelopes.length > RESET_MAX_TARGETS) return bad(`envelopes: max ${RESET_MAX_TARGETS}`);
    envelopes = [];
    for (let i = 0; i < body.envelopes.length; i++) {
      const n = envelopeName(body.envelopes[i], `envelopes[${i}]`); if (!n.ok) return n;
      envelopes.push(n.value);
    }
  } else return bad('envelopes must be "all" or a non-empty array of names');
  const note = noteOf(body); if (!note.ok) return note;
  return { ok: true, value: { dryRun: dry.value, expectedHash: hash.value, envelopes, note: note.value } };
}

/**
 * Carry-only reset: {dry_run?, expected_state_hash, targets:[{envelope, expected_carry}], note?}.
 * Sets carry-over to 0 for each named envelope; never touches allocation.
 */
export function validateCarryResetBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = unknownKey(body, ['dry_run', 'expected_state_hash', 'targets', 'note']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const dry = dryRunOf(body); if (!dry.ok) return dry;
  const hash = hashOf(body); if (!hash.ok) return hash;
  if (!Array.isArray(body.targets) || !body.targets.length) return bad('targets must be a non-empty array');
  if (body.targets.length > RESET_MAX_TARGETS) return bad(`targets: max ${RESET_MAX_TARGETS}`);
  const targets = [];
  for (let i = 0; i < body.targets.length; i++) {
    const t = body.targets[i];
    if (!isObj(t)) return bad(`targets[${i}] must be an object`);
    const ex = unknownKey(t, ['envelope', 'expected_carry']);
    if (ex) return bad(`Unknown field: targets[${i}].${ex}`);
    const n = envelopeName(t.envelope, `targets[${i}].envelope`); if (!n.ok) return n;
    const c = toCents(t.expected_carry);
    if (c == null || Math.abs(c) > RESET_MAX_AMOUNT * 100) return bad(`targets[${i}].expected_carry must be a number (may be negative) with at most 2 decimals`);
    targets.push({ envelope: n.value, expectedCents: c });
  }
  const note = noteOf(body); if (!note.ok) return note;
  return { ok: true, value: { dryRun: dry.value, expectedHash: hash.value, targets, note: note.value } };
}

/** {dry_run?, expected_state_hash, note?} */
export function validateRestoreBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = unknownKey(body, ['dry_run', 'expected_state_hash', 'note']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const dry = dryRunOf(body); if (!dry.ok) return dry;
  const hash = hashOf(body); if (!hash.ok) return hash;
  const note = noteOf(body); if (!note.ok) return note;
  return { ok: true, value: { dryRun: dry.value, expectedHash: hash.value, note: note.value } };
}

/** {note?} */
export function validateSnapshotBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const extra = unknownKey(body, ['note']);
  if (extra) return bad(`Unknown field: ${extra}`);
  const note = noteOf(body); if (!note.ok) return note;
  return { ok: true, value: { note: note.value } };
}

const topLevel = state => (state.categories || []).filter(c => c && c.id && !c.parentId);

/** Bill linked to an envelope: prefer an unpaid one, else any. */
function linkedBillId(state, catId) {
  const bills = (state.bills || []).filter(b => b && b.id && b.categoryId === catId);
  const pick = bills.find(b => b.status !== 'paid') || bills[0];
  return pick ? cleanText(pick.id, 128) : null;
}

/** Month expenses with no envelope and no split (money spent but unassigned). */
function uncategorizedFor(state, month) {
  let count = 0; let total = 0;
  for (const t of state.transactions || []) {
    if (!t || t.type !== 'expense' || typeof t.date !== 'string' || !t.date.startsWith(`${month}-`)) continue;
    if (t.categoryId || (Array.isArray(t.splits) && t.splits.length)) continue;
    count++; total += Math.abs(Number(t.amount) || 0);
  }
  return { count, total: r2(total) };
}

function newestTxDate(state) {
  let best = null;
  for (const t of state.transactions || []) {
    const d = typeof t?.date === 'string' ? t.date.slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!best || d > best)) best = d;
  }
  return best;
}

/**
 * Balances from the store's own getters (current month).
 * allocated = getCategoryBudgeted, spent = getCategorySpent, remaining = getCategoryRemaining.
 * total_allocated = getTotalBudgeted (top-level, what Budget "To Allocate" uses).
 * unallocated = checking − total_allocated (negative = over-allocated).
 * bonus_available = getBonusAvailable (free bonus pot the overage cover draws from first).
 * kind (top-level only) = getEnvelopeKind: bill | debt | sinking | spend.
 * `hashInput` is the canonical string the caller hashes into state_hash.
 */
export function computeBalances(store, month = getCurrentMonth()) {
  const state = store.getState();
  const cats = (state.categories || []).filter(c => c && c.id);
  const byId = new Map(cats.map(c => [c.id, c]));
  const envelopes = cats.map(c => {
    const out = { id: String(c.id), name: cleanText(c.name, 80) };
    if (c.parentId && byId.get(c.parentId)) out.group = cleanText(byId.get(c.parentId).name, 80);
    if (c.isSinkingFund) out.sinkingFund = true;
    if (!c.parentId) out.kind = store.getEnvelopeKind(c.id);
    out.allocated = r2(store.getCategoryBudgeted(c.id, month));
    out.spent = r2(store.getCategorySpent(c.id, month));
    out.carry = r2(store.getOpeningCarryForMonth(c.id, month));
    out.remaining = r2(store.getCategoryRemaining(c.id, month));
    out.bill_id = linkedBillId(state, c.id);
    return out;
  });
  const checking = r2(state.balances?.checking);
  const total = r2(store.getTotalBudgeted(month));
  const body = {
    month,
    checking_balance: checking,
    total_allocated: total,
    unallocated: r2(checking - total),
    bonus_available: r2(store.getBonusAvailable(month)),
    newest_transaction_date: newestTxDate(state),
    uncategorized: uncategorizedFor(state, month),
    envelopes,
  };
  // Hash covers what a caller acts on plus the raw plan/carry fields behind it.
  const hashInput = JSON.stringify({
    v: 2,
    ...body,
    raw: cats.map(c => [String(c.id), c.parentId || null, r2(c.monthlyBudget), r2(c.carryOver)]),
  });
  return { body, hashInput };
}

export function envelopeNames(state) {
  return topLevel(state).map(c => String(c.name));
}

/** Plan per top-level envelope: Map(categoryId → new monthlyBudget cents). Never creates. */
export function planReset(state, input) {
  const tops = topLevel(state);
  const idx = new Map(tops.map(c => [String(c.name || '').trim().toLowerCase(), c]));
  const set = new Map();
  for (const t of input.targets) {
    const c = idx.get(t.envelope.trim().toLowerCase());
    if (!c) return { ok: false, code: 'unknown_envelope', envelope: t.envelope, validEnvelopes: envelopeNames(state) };
    if (set.has(c.id)) return { ok: false, code: 'invalid_body', message: `Envelope listed twice: ${cleanText(c.name, 80)}` };
    set.set(c.id, t.cents);
  }
  if (input.defaultCents != null) for (const c of tops) if (!set.has(c.id)) set.set(c.id, input.defaultCents);
  return { ok: true, set };
}

function resolveTop(state, name) {
  const key = String(name).trim().toLowerCase();
  return topLevel(state).find(c => String(c.name || '').trim().toLowerCase() === key) || null;
}

/**
 * Start fresh plan: monthlyBudget = 0 and carryOver = 0 for the chosen top-level
 * envelopes AND their sub-envelopes ("all" = every envelope). Never creates.
 */
export function planStartFresh(state, input) {
  const all = (state.categories || []).filter(c => c && c.id);
  let tops;
  if (input.envelopes === 'all') tops = topLevel(state);
  else {
    tops = [];
    for (const n of input.envelopes) {
      const c = resolveTop(state, n);
      if (!c) return { ok: false, code: 'unknown_envelope', envelope: n, validEnvelopes: envelopeNames(state) };
      if (tops.includes(c)) return { ok: false, code: 'invalid_body', message: `Envelope listed twice: ${cleanText(c.name, 80)}` };
      tops.push(c);
    }
  }
  const topIds = new Set(tops.map(c => c.id));
  const budgets = new Map(); const carry = new Map();
  for (const c of all) {
    if (topIds.has(c.id) || (c.parentId && topIds.has(c.parentId))) { budgets.set(c.id, 0); carry.set(c.id, 0); }
  }
  return { ok: true, budgets, carry };
}

/** Carry-only plan: carryOver = 0 for named top-level envelopes; 409 when expected_carry differs. */
export function planCarryReset(state, input) {
  const carry = new Map(); const mismatches = [];
  for (const t of input.targets) {
    const c = resolveTop(state, t.envelope);
    if (!c) return { ok: false, code: 'unknown_envelope', envelope: t.envelope, validEnvelopes: envelopeNames(state) };
    if (carry.has(c.id)) return { ok: false, code: 'invalid_body', message: `Envelope listed twice: ${cleanText(c.name, 80)}` };
    const cur = Math.round((Number(c.carryOver) || 0) * 100);
    if (cur !== t.expectedCents) mismatches.push({ envelope: cleanText(c.name, 80), expected_carry: t.expectedCents / 100, actual_carry: cur / 100 });
    carry.set(c.id, 0);
  }
  if (mismatches.length) return { ok: false, code: 'carry_mismatch', mismatches };
  return { ok: true, budgets: new Map(), carry };
}

/** Raw envelope plan/carry for every envelope (sub-envelopes included). */
export function captureEnvelopeState(state) {
  return (state.categories || []).filter(c => c && c.id).map(c => ({
    id: String(c.id),
    name: cleanText(c.name, 80),
    monthlyBudget: r2(c.monthlyBudget),
    carryOver: r2(c.carryOver),
  }));
}

/**
 * Write allocations through the store's own update path — the same field the
 * Edit Envelope modal sets. `budgets` Map(categoryId → cents); `carry` optional
 * Map(categoryId → cents) (restore only; mirrors resetEnvelopeCarryOver's field).
 */
export function writeAllocations(store, budgets, carry = null) {
  store.update(s => {
    for (const c of s.categories || []) {
      if (!c || !c.id) continue;
      if (budgets.has(c.id)) c.monthlyBudget = fromCents(budgets.get(c.id));
      if (carry && carry.has(c.id)) c.carryOver = fromCents(carry.get(c.id));
    }
  }, { persist: false });
}

/** Before/after table (top-level only) + total deltas. */
export function diffTable(before, after) {
  const a = new Map(after.envelopes.map(e => [e.id, e]));
  const rows = [];
  for (const b of before.envelopes) {
    if (b.group !== undefined) continue;
    const x = a.get(b.id);
    if (!x) continue;
    rows.push({
      id: b.id,
      envelope: b.name,
      allocated_before: b.allocated,
      allocated_after: x.allocated,
      carry_before: b.carry,
      carry_after: x.carry,
      remaining_before: b.remaining,
      remaining_after: x.remaining,
      changed: Math.abs(b.allocated - x.allocated) > 0.004 || Math.abs(b.carry - x.carry) > 0.004 || Math.abs(b.remaining - x.remaining) > 0.004,
    });
  }
  return {
    changes: rows,
    totals: {
      total_allocated_before: before.total_allocated,
      total_allocated_after: after.total_allocated,
      total_allocated_change: r2(after.total_allocated - before.total_allocated),
      unallocated_before: before.unallocated,
      unallocated_after: after.unallocated,
      unallocated_change: r2(after.unallocated - before.unallocated),
    },
  };
}

/** Store a snapshot of the current envelope plan in state.envelopeSnapshots (newest last, capped). */
export function addSnapshot(state, { id, at, reason, note, stateHash, totalAllocated, keepId = null }) {
  const list = Array.isArray(state.envelopeSnapshots) ? state.envelopeSnapshots : [];
  const snap = {
    id, at, actor: ACTOR, reason, month: getCurrentMonth(),
    state_hash: stateHash, total_allocated: totalAllocated,
    categories: captureEnvelopeState(state),
    ...(note ? { note } : {}),
  };
  list.push(snap);
  // Cap, oldest first — but never evict `keepId` (the snapshot a restore is about to use).
  while (list.length > SNAPSHOT_MAX) {
    const i = list.findIndex(s => !s || s.id !== keepId);
    list.splice(i, 1);
  }
  state.envelopeSnapshots = list;
  return snap;
}

export function findSnapshot(state, id) {
  return (Array.isArray(state.envelopeSnapshots) ? state.envelopeSnapshots : []).find(s => s && s.id === id) || null;
}

/** Trimmed list, newest first. No per-envelope amounts. */
export function listSnapshots(state) {
  const list = Array.isArray(state.envelopeSnapshots) ? state.envelopeSnapshots : [];
  return list.filter(s => s && typeof s.id === 'string').slice().reverse().map(s => ({
    id: s.id,
    at: s.at,
    actor: s.actor,
    reason: s.reason,
    month: s.month,
    state_hash: s.state_hash,
    total_allocated: s.total_allocated,
    envelope_count: Array.isArray(s.categories) ? s.categories.length : 0,
    ...(s.note ? { note: cleanText(s.note, NOTE_MAX) } : {}),
  }));
}

/**
 * Restore plan: snapshot must be for the current month and cover exactly the
 * current envelope ids (never creates or deletes envelopes).
 */
export function planRestore(state, snap) {
  if (snap.month !== getCurrentMonth()) return { ok: false, code: 'snapshot_month_mismatch', snapshotMonth: snap.month };
  const cur = new Set((state.categories || []).filter(c => c && c.id).map(c => String(c.id)));
  const ids = new Set((snap.categories || []).map(c => String(c.id)));
  const same = cur.size === ids.size && [...cur].every(id => ids.has(id));
  if (!same) return { ok: false, code: 'envelopes_changed' };
  const budgets = new Map();
  const carry = new Map();
  for (const c of snap.categories) {
    const b = toCents(r2(c.monthlyBudget));
    const k = toCents(r2(c.carryOver));
    if (b == null || k == null) return { ok: false, code: 'snapshot_invalid' };
    budgets.set(c.id, b);
    carry.set(c.id, k);
  }
  return { ok: true, budgets, carry };
}

/** Audit entry (state.envelopeResetAudit, newest last, capped). before/after = changed envelopes only. */
export function appendEnvelopeAudit(state, { at, action, snapshotId, beforeRaw, afterRaw, note }) {
  const a = new Map(afterRaw.map(c => [c.id, c]));
  const before = [];
  const after = [];
  for (const b of beforeRaw) {
    const x = a.get(b.id);
    if (!x || (x.monthlyBudget === b.monthlyBudget && x.carryOver === b.carryOver)) continue;
    before.push({ categoryId: b.id, monthlyBudget: b.monthlyBudget, carryOver: b.carryOver });
    after.push({ categoryId: x.id, monthlyBudget: x.monthlyBudget, carryOver: x.carryOver });
  }
  const list = Array.isArray(state.envelopeResetAudit) ? state.envelopeResetAudit : [];
  list.push({ at, actor: ACTOR, action, snapshot_id: snapshotId, before, after, ...(note ? { note } : {}) });
  state.envelopeResetAudit = list.slice(-AUDIT_MAX);
}

/** Serialize store use (the store is a module singleton) across awaits. */
let storeLock = Promise.resolve();
export function withStoreLock(fn) {
  const run = storeLock.then(fn, fn);
  storeLock = run.then(() => undefined, () => undefined);
  return run;
}
