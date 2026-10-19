/**
 * Overage cover for POST /api/envelopes/overage (netlify/functions/envelopes-write.mjs).
 * Pure helpers: no network, no DOM. Integer-cent math throughout.
 *
 * David's rule: "if I go over, I want the overage to affect either a selected or all
 * envelopes equally (minus bills) with a forced split, unless there is unused bonus funds,
 * then it will draw from there first."
 *
 *  1. Overage = a top-level, non-bill, non-debt, non-pass-through envelope whose
 *     store.getCategoryRemaining (allocated + carry + moves + bonus − spent) is < 0.
 *  2. Draw from the free bonus pot first (store.getBonusAvailable — the same pot the
 *     Budget page's "Assign bonus" uses), up to what is free.
 *  3. Split what is left EQUALLY across the target set (selected names, or "all"):
 *     forced — no opt-out per envelope. Bill and debt envelopes are never debited; the
 *     overspent envelopes (and any other envelope already below 0) are never targets.
 *  4. Remainder pennies go one each to targets in sorted order (name, then id).
 *  5. negative_rule:
 *       "cascade" (default) — a target is never pushed below $0 while another target still
 *         has room: its share is capped at its remaining and the excess is re-split equally
 *         across the others (water-fill). Only if every target is drained is the residue
 *         forced equally across all targets (they go negative and are flagged).
 *       "allow" — strict equal shares; a target may go negative (flagged).
 *     Either way every covered envelope ends at exactly $0.
 *
 * Writes use the app's existing month-only records, the same shapes the Budget page writes:
 *   bonus draw  → state.monthBonusAllocations[month] rows (like allocateBonusToEnvelope)
 *   split       → state.monthEnvelopeMoves[month] rows + state.overspendCoverIous
 *                 (like applyCoverOverspend, so "Repay cover from bonus" can later refill
 *                 the targets). monthlyBudget / carryOver / next month's plan are untouched.
 * No schema change. Budget/snowball math is read through store getters, never reimplemented.
 */
import { toCents, fromCents, cleanText } from './receipt-split.js';
import { getCurrentMonth } from './utils.js';

export const OVERAGE_MAX_NAMES = 100;
export const NEGATIVE_RULES = ['cascade', 'allow'];
export const OVERAGE_NOTE_MAX = 200;
const STATE_HASH_RE = /^[a-f0-9]{64}$/;
const WORK_TRAVEL = 'work travel';

const bad = message => ({ ok: false, code: 'invalid_body', message });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cents = n => Math.round((Number(n) || 0) * 100);
const keyOf = s => String(s || '').trim().toLowerCase();

function namesOf(v, label) {
  if (!Array.isArray(v)) return bad(`${label} must be an array of envelope names`);
  if (!v.length) return bad(`${label} must not be empty`);
  if (v.length > OVERAGE_MAX_NAMES) return bad(`${label}: max ${OVERAGE_MAX_NAMES}`);
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const n = v[i];
    if (typeof n !== 'string' || n.length > 80 || !cleanText(n, 80)) return bad(`${label}[${i}] must be a short non-empty string`);
    out.push(cleanText(n, 80));
  }
  return { ok: true, value: out };
}

/**
 * {expected_state_hash, targets:"all"|[names], dry_run?=true, envelopes?:[names],
 *  include_sinking_funds?=true, negative_rule?="cascade", note?}; unknown keys rejected.
 */
export function validateOverageBody(body) {
  if (!isObj(body)) return bad('JSON object body required');
  const allowed = ['dry_run', 'expected_state_hash', 'targets', 'envelopes', 'include_sinking_funds', 'negative_rule', 'note'];
  const extra = Object.keys(body).find(k => !allowed.includes(k));
  if (extra !== undefined) return bad(`Unknown field: ${cleanText(extra, 40)}`);
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') return bad('dry_run must be true or false');
  if (typeof body.expected_state_hash !== 'string' || !STATE_HASH_RE.test(body.expected_state_hash)) {
    return bad('expected_state_hash is required (64 hex chars from GET /api/envelopes)');
  }
  let targets;
  if (body.targets === 'all') targets = 'all';
  else if (Array.isArray(body.targets)) {
    const t = namesOf(body.targets, 'targets'); if (!t.ok) return t;
    targets = t.value;
  } else return bad('targets is required: "all" or an array of envelope names');
  let envelopes = null;
  if (body.envelopes !== undefined) {
    const e = namesOf(body.envelopes, 'envelopes'); if (!e.ok) return e;
    envelopes = e.value;
  }
  if (body.include_sinking_funds !== undefined && typeof body.include_sinking_funds !== 'boolean') {
    return bad('include_sinking_funds must be true or false');
  }
  if (body.negative_rule !== undefined && !NEGATIVE_RULES.includes(body.negative_rule)) {
    return bad(`negative_rule must be one of: ${NEGATIVE_RULES.join(', ')}`);
  }
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > OVERAGE_NOTE_MAX)) {
    return bad(`note must be a string (max ${OVERAGE_NOTE_MAX})`);
  }
  return {
    ok: true,
    value: {
      dryRun: body.dry_run === undefined ? true : body.dry_run,
      expectedHash: body.expected_state_hash,
      targets,
      envelopes,
      includeSinking: body.include_sinking_funds === undefined ? true : body.include_sinking_funds,
      negativeRule: body.negative_rule || 'cascade',
      note: body.note === undefined ? '' : cleanText(body.note, OVERAGE_NOTE_MAX),
    },
  };
}

/** `total` cents split into n equal shares; the first (total % n) get one extra penny. */
export function equalSplit(total, n) {
  if (!(n > 0) || !(total > 0)) return Array.from({ length: Math.max(0, n) }, () => 0);
  const base = Math.floor(total / n);
  const r = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < r ? 1 : 0));
}

/**
 * Water-fill `total` cents across caps (cents ≥ 0), equal shares, never above a cap.
 * Pennies go in index order among the still-open slots. Returns {takes, residue}.
 */
export function cascadeSplit(total, caps) {
  const takes = caps.map(() => 0);
  let open = caps.map((c, i) => i).filter(i => caps[i] > 0);
  let left = total;
  while (left > 0 && open.length) {
    const shares = equalSplit(left, open.length);
    const over = open.filter((i, k) => shares[k] > caps[i]);
    if (!over.length) {
      open.forEach((i, k) => { takes[i] += shares[k]; });
      left = 0;
      break;
    }
    for (const i of over) { takes[i] = caps[i]; left -= caps[i]; }
    const closed = new Set(over);
    open = open.filter(i => !closed.has(i));
  }
  return { takes, residue: left };
}

function envelopeInfo(store, c, month) {
  const kind = store.getEnvelopeKind(c.id);
  return {
    id: String(c.id),
    cat: c,
    name: cleanText(c.name, 80),
    kind,
    isSinking: !!c.isSinkingFund,
    passThrough: !!c.passThrough || keyOf(c.name) === WORK_TRAVEL,
    remaining: cents(store.getCategoryRemaining(c.id, month)),
  };
}

const protectedReason = e => (e.kind === 'bill' || e.kind === 'debt' ? e.kind : e.passThrough ? 'pass_through' : null);
const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);

function resolve(names, idx) {
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const e = idx.get(keyOf(n));
    if (!e) {
      return { ok: false, code: 'unknown_envelope', envelope: n, validEnvelopes: [...idx.values()].map(x => x.name) };
    }
    if (seen.has(e.id)) return { ok: false, code: 'invalid_body', message: `Envelope listed twice: ${e.name}` };
    seen.add(e.id);
    out.push(e);
  }
  return { ok: true, list: out };
}

/**
 * Plan the overage cover on the hydrated store (current month). Nothing is written.
 * Returns {ok:false, code, ...} or {ok:true, ...plan} with all amounts in cents.
 */
export function planOverage(store, input) {
  const state = store.getState();
  const month = getCurrentMonth();
  const tops = (state.categories || []).filter(c => c && c.id && !c.parentId).map(c => envelopeInfo(store, c, month));
  const idx = new Map(tops.map(e => [keyOf(e.name), e]));

  // 1) Which overspent envelopes to cover.
  let overs;
  if (input.envelopes) {
    const r = resolve(input.envelopes, idx); if (!r.ok) return r;
    for (const e of r.list) {
      const why = protectedReason(e);
      if (why) return { ok: false, code: 'protected_envelope', status: 400, envelope: e.name, reason: why, message: `${e.name} is a ${why.replace('_', '-')} envelope; its overage is not split` };
      if (e.remaining >= 0) return { ok: false, code: 'not_overspent', status: 409, envelope: e.name };
    }
    overs = r.list;
  } else {
    overs = tops.filter(e => e.remaining < 0 && !protectedReason(e));
  }
  if (!overs.length) return { ok: false, code: 'no_overage', status: 409 };
  overs = overs.map(e => ({ ...e, over: -e.remaining })).sort((a, b) => b.over - a.over || byName(a, b));
  const overIds = new Set(overs.map(o => o.id));
  const total = overs.reduce((s, o) => s + o.over, 0);

  // 2) Bonus pot first.
  const bonusBefore = cents(store.getBonusAvailable(month));
  const fromBonus = Math.min(bonusBefore, total);
  let bonusLeft = fromBonus;
  const need = new Map();
  const bonusRows = [];
  for (const o of overs) {
    const take = Math.min(bonusLeft, o.over);
    if (take > 0) bonusRows.push({ categoryId: o.id, cents: take });
    bonusLeft -= take;
    need.set(o.id, o.over - take);
    o.fromBonus = take;
  }
  const rest = total - fromBonus;

  // 3) Target set.
  const excluded = [];
  let targets = [];
  const mode = input.targets === 'all' ? 'all' : 'selected';
  if (mode === 'all') {
    for (const e of tops) {
      const why = protectedReason(e)
        || (overIds.has(e.id) || e.remaining < 0 ? 'overspent' : null)
        || (e.isSinking && !input.includeSinking ? 'sinking_fund' : null);
      if (why) excluded.push({ id: e.id, envelope: e.name, reason: why });
      else targets.push(e);
    }
  } else {
    const r = resolve(input.targets, idx); if (!r.ok) return r;
    for (const e of r.list) {
      const why = protectedReason(e);
      if (why) return { ok: false, code: 'protected_envelope', status: 400, envelope: e.name, reason: why, message: `${e.name} is a ${why.replace('_', '-')} envelope and is never debited` };
      if (overIds.has(e.id) || e.remaining < 0) excluded.push({ id: e.id, envelope: e.name, reason: 'overspent' });
      else targets.push(e);
    }
  }
  targets.sort(byName);
  if (rest > 0 && !targets.length) return { ok: false, code: 'no_targets', status: 409, overage: fromCents(total), from_bonus: fromCents(fromBonus), message: 'Bonus does not cover the overage and no target envelope is eligible' };

  // 4) Forced equal split.
  let debits;
  let forced = 0;
  if (rest === 0) debits = targets.map(() => 0);
  else if (input.negativeRule === 'allow') debits = equalSplit(rest, targets.length);
  else {
    const { takes, residue } = cascadeSplit(rest, targets.map(t => Math.max(0, t.remaining)));
    const extra = equalSplit(residue, targets.length);
    debits = takes.map((t, i) => t + extra[i]);
    forced = residue;
  }

  // 5) Moves: each target's debit fills the overspent envelopes in order.
  const moves = [];
  let oi = 0;
  targets.forEach((t, i) => {
    let give = debits[i];
    while (give > 0 && oi < overs.length) {
      const o = overs[oi];
      const n = need.get(o.id);
      if (n <= 0) { oi++; continue; }
      const amt = Math.min(give, n);
      moves.push({ fromId: t.id, fromName: t.name, toId: o.id, toName: o.name, cents: amt, isSinking: t.isSinking });
      need.set(o.id, n - amt);
      give -= amt;
    }
  });
  for (const o of overs) o.fromSplit = o.over - o.fromBonus;

  const debitRows = targets.map((t, i) => ({
    id: t.id, envelope: t.name, kind: t.kind,
    remaining_before: t.remaining, debit: debits[i], remaining_after: t.remaining - debits[i],
    went_negative: t.remaining - debits[i] < 0,
  }));
  const warnings = [];
  const neg = debitRows.filter(d => d.went_negative);
  if (neg.length) {
    warnings.push(input.negativeRule === 'allow'
      ? `Equal share pushes ${neg.length} envelope(s) below $0: ${neg.map(d => d.envelope).join(', ')}`
      : `Targets ran out of leftover; $${fromCents(forced).toFixed(2)} was forced across all targets, ${neg.length} now below $0`);
  }
  return {
    ok: true,
    month,
    mode,
    negativeRule: input.negativeRule,
    includeSinking: input.includeSinking,
    total, fromBonus, rest, forced,
    bonusBefore,
    overs, targets, debitRows, excluded, bonusRows, moves, warnings,
  };
}

/**
 * Apply a plan to the hydrated store in memory (persist:false), using the same row shapes
 * as the app's allocateBonusToEnvelope / applyCoverOverspend. Returns the rows written so the
 * caller can append the identical rows to the raw cloud row.
 */
export function applyOverageInMemory(store, plan, { at, batchId, newId, note = '', persist = false }) {
  const label = note ? ` — ${note}` : '';
  const bonus = plan.bonusRows.map(b => ({
    id: newId(), categoryId: b.categoryId, amount: fromCents(b.cents),
    note: `Overage cover from bonus${label}`, at, overageBatchId: batchId,
  }));
  const moveNote = `Overage split (forced, equal)${label}`;
  const moves = [];
  const ious = [];
  for (const m of plan.moves) {
    moves.push({ id: newId(), fromId: m.fromId, toId: m.toId, amount: fromCents(m.cents), note: moveNote, at, coverBatchId: batchId, overageBatchId: batchId });
    ious.push({
      id: newId(), batchId, fromId: m.fromId, fromName: m.fromName, toId: m.toId, toName: m.toName,
      amount: fromCents(m.cents), repaid: 0, isSinking: !!m.isSinking, month: plan.month, at, note: moveNote,
    });
  }
  store.update(s => {
    if (!isObj(s.monthBonusAllocations)) s.monthBonusAllocations = {};
    if (!Array.isArray(s.monthBonusAllocations[plan.month])) s.monthBonusAllocations[plan.month] = [];
    if (!isObj(s.monthEnvelopeMoves)) s.monthEnvelopeMoves = {};
    if (!Array.isArray(s.monthEnvelopeMoves[plan.month])) s.monthEnvelopeMoves[plan.month] = [];
    if (!Array.isArray(s.overspendCoverIous)) s.overspendCoverIous = [];
    for (const b of bonus) s.monthBonusAllocations[plan.month].push({ ...b });
    for (const m of moves) s.monthEnvelopeMoves[plan.month].push({ ...m });
    for (const i of ious) s.overspendCoverIous.push({ ...i });
  }, { persist });
  return { bonus, moves, ious };
}

/** Read back through the store getters: every planned number must have landed exactly. */
export function verifyOverage(store, plan) {
  const month = plan.month;
  for (const o of plan.overs) if (cents(store.getCategoryRemaining(o.id, month)) !== 0) return false;
  for (const d of plan.debitRows) if (cents(store.getCategoryRemaining(d.id, month)) !== d.remaining_after) return false;
  return cents(store.getBonusAvailable(month)) === plan.bonusBefore - plan.fromBonus;
}

/** Append the same rows to a raw (un-normalized) budget row. null if an id is missing there. */
export function appendOverageRows(raw, month, rows) {
  const ids = new Set((raw.categories || []).filter(c => c && c.id).map(c => String(c.id)));
  for (const r of [...rows.bonus, ...rows.moves]) {
    for (const k of ['categoryId', 'fromId', 'toId']) if (r[k] !== undefined && !ids.has(String(r[k]))) return null;
  }
  if (!isObj(raw.monthBonusAllocations)) raw.monthBonusAllocations = {};
  if (!isObj(raw.monthEnvelopeMoves)) raw.monthEnvelopeMoves = {};
  raw.monthBonusAllocations[month] = [...(Array.isArray(raw.monthBonusAllocations[month]) ? raw.monthBonusAllocations[month] : []), ...rows.bonus];
  raw.monthEnvelopeMoves[month] = [...(Array.isArray(raw.monthEnvelopeMoves[month]) ? raw.monthEnvelopeMoves[month] : []), ...rows.moves];
  raw.overspendCoverIous = [...(Array.isArray(raw.overspendCoverIous) ? raw.overspendCoverIous : []), ...rows.ious];
  return raw;
}

/** Public (dollars) view of a plan for the API response. */
export function overageResponse(plan, bonusAfterCents) {
  const d = fromCents;
  return {
    overage: {
      month: plan.month,
      total: d(plan.total),
      from_bonus: d(plan.fromBonus),
      split_total: d(plan.rest),
      forced_below_zero: d(plan.forced),
      bonus_available_before: d(plan.bonusBefore),
      bonus_available_after: d(bonusAfterCents),
      target_mode: plan.mode,
      negative_rule: plan.negativeRule,
      include_sinking_funds: plan.includeSinking,
      target_count: plan.targets.length,
    },
    overspent: plan.overs.map(o => ({
      id: o.id, envelope: o.name, remaining_before: d(-o.over),
      from_bonus: d(o.fromBonus), from_split: d(o.fromSplit), remaining_after: 0,
    })),
    debits: plan.debitRows.map(r => ({
      ...r, remaining_before: d(r.remaining_before), debit: d(r.debit), remaining_after: d(r.remaining_after),
    })),
    excluded: plan.excluded,
    moves: plan.moves.map(m => ({ from: m.fromName, to: m.toName, amount: d(m.cents) })),
    warnings: plan.warnings,
  };
}

/**
 * What the Budget-page "Cover overage" panel needs (current month): the overspent envelopes,
 * the free bonus pot, and every top-level envelope with whether it can be a target and why not.
 * Same eligibility rules as planOverage.
 */
export function overageOptions(store) {
  const state = store.getState();
  const month = getCurrentMonth();
  const tops = (state.categories || []).filter(c => c && c.id && !c.parentId).map(c => envelopeInfo(store, c, month));
  const overspent = tops.filter(e => e.remaining < 0 && !protectedReason(e))
    .map(e => ({ id: e.id, name: e.name, over: -e.remaining }))
    .sort((a, b) => b.over - a.over || byName(a, b));
  const candidates = tops.map(e => {
    const reason = protectedReason(e) || (e.remaining < 0 ? 'overspent' : null);
    return { id: e.id, name: e.name, kind: e.kind, isSinking: e.isSinking, remaining: e.remaining, eligible: !reason, reason };
  }).sort(byName);
  return {
    month,
    bonusAvailable: cents(store.getBonusAvailable(month)),
    total: overspent.reduce((s, o) => s + o.over, 0),
    overspent,
    candidates,
  };
}

/** Stable fingerprint of what a plan will do; the panel re-checks it at Confirm (client-side CAS). */
export function planSignature(plan) {
  return JSON.stringify({
    m: plan.month, t: plan.total, b: plan.fromBonus, bb: plan.bonusBefore,
    o: plan.overs.map(o => [o.id, o.over, o.fromBonus]),
    d: plan.debitRows.map(r => [r.id, r.remaining_before, r.debit]),
  });
}

/**
 * Browser path (Budget page): re-plan on the live store, refuse if the plan no longer matches
 * the previewed `signature` (something changed since the preview), apply in memory, read back
 * through the store getters, then persist through the store's normal save (localStorage +
 * the app's own cloud sync). No server call, no token. Fails closed: on a read-back mismatch
 * the rows are removed again and nothing is saved.
 */
export function coverOverageInStore(store, input, { signature, newId, batchId, at = new Date().toISOString() }) {
  if (typeof store.canWriteBudget === 'function' && !store.canWriteBudget()) return { ok: false, code: 'read_only' };
  const plan = planOverage(store, input);
  if (!plan.ok) return plan;
  if (signature && planSignature(plan) !== signature) return { ok: false, code: 'stale_state' };
  const rows = applyOverageInMemory(store, plan, { at, batchId, newId, note: input.note || '' });
  if (!verifyOverage(store, plan)) {
    store.update(s => {
      const m = plan.month;
      if (Array.isArray(s.monthBonusAllocations?.[m])) s.monthBonusAllocations[m] = s.monthBonusAllocations[m].filter(r => r.overageBatchId !== batchId);
      if (Array.isArray(s.monthEnvelopeMoves?.[m])) s.monthEnvelopeMoves[m] = s.monthEnvelopeMoves[m].filter(r => r.overageBatchId !== batchId);
      if (Array.isArray(s.overspendCoverIous)) s.overspendCoverIous = s.overspendCoverIous.filter(r => r.batchId !== batchId);
    }, { persist: false });
    return { ok: false, code: 'write_refused' };
  }
  store.save();
  return { ok: true, plan, rows };
}
