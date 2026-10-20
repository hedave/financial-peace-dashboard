import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import {
  validateResetBody, validateRestoreBody, validateSnapshotBody, validateStartFreshBody, validateCarryResetBody,
  computeBalances, planReset, planStartFresh, planCarryReset, planRestore, writeAllocations, diffTable,
  addSnapshot, findSnapshot, captureEnvelopeState, appendEnvelopeAudit,
  withStoreLock, SNAPSHOT_ID_RE, ACTOR, AUDIT_MAX,
} from '../../js/envelope-reset.js';
import {
  validateOverageBody, planOverage, applyOverageInMemory, verifyOverage, appendOverageRows, overageResponse,
} from '../../js/envelope-overage.js';

/**
 * Envelope writes (all POST, JSON):
 *   /api/envelopes/snapshot                 {note?}                → stores a snapshot
 *   /api/envelopes/snapshots/:id/restore    {expected_state_hash, dry_run?=true, note?}
 *   /api/envelopes/reset                    {expected_state_hash, dry_run?=true, targets?, default_amount?, note?}
 *   /api/envelopes/start-fresh             {expected_state_hash, envelopes:"all"|[names], dry_run?=true, note?}
 *                                            → monthlyBudget = 0 AND carryOver = 0 (named envelopes + their subs)
 *   /api/envelopes/reset-carry             {expected_state_hash, targets:[{envelope, expected_carry}], dry_run?=true, note?}
 *                                            → carryOver = 0 only (409 carry_mismatch if expected_carry differs)
 *   /api/envelopes/overage                  {expected_state_hash, targets:"all"|[names], dry_run?=true,
 *                                            envelopes?, include_sinking_funds?, negative_rule?, note?}
 *
 * Auth: Authorization: Bearer <FIGPIG_ENVELOPE_WRITE_TOKEN> (alt x-figpig-envelope-write-token).
 * Own token (>= 24 chars, must differ from every other FigPig token); 503 when unset/short/
 * reused or Supabase env missing. 10 writes/min per client IP, counted BEFORE auth.
 *
 * Reset/restore: compare-and-swap on state_hash from GET /api/envelopes (409 stale_state).
 * dry_run defaults to true and writes nothing. A real run first saves an automatic snapshot
 * (its own budget_states write), then applies allocations through the store's own update
 * path (monthlyBudget, like the Edit Envelope modal) and appends to state.envelopeResetAudit.
 * Only those envelope fields + envelopeSnapshots/envelopeResetAudit are written back.
 * Never creates/deletes envelopes; never touches transactions, checking, debts or snowball.
 * Overage: same auth / dry-run / hash CAS / pre-snapshot; covers overspent envelopes from the
 * free bonus pot first, then a forced equal split (js/envelope-overage.js). It appends
 * month-only rows (monthBonusAllocations, monthEnvelopeMoves, overspendCoverIous) — the same
 * records the Budget page writes — and never changes monthlyBudget or carryOver.
 * Supabase failures → 502.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const MAX_BODY_BYTES = 16 * 1024;
const OTHER_TOKENS = ['FIGPIG_BILLS_READ_TOKEN', 'FIGPIG_SPLIT_WRITE_TOKEN', 'FIGPIG_TX_SPLIT_TOKEN', 'FIGPIG_TX_WRITE_TOKEN', 'FIGPIG_INGEST_SECRET'];
const hits = new Map();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

function env(name) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env?.get) {
      const v = Netlify.env.get(name);
      if (v) return v;
    }
  } catch { /* node */ }
  return process.env[name] || '';
}

export function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b) && String(provided).length === String(expected).length;
}

function providedToken(req) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return String(req.headers.get('x-figpig-envelope-write-token') || '').trim();
}

function clientKey(req) {
  return req.headers.get('x-nf-client-connection-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

function rateLimitOk(key) {
  const now = Date.now();
  let b = hits.get(key);
  if (!b || now - b.start >= WINDOW_MS) { b = { start: now, count: 0 }; hits.set(key, b); }
  b.count += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start >= WINDOW_MS) hits.delete(k);
  return b.count <= MAX_PER_WINDOW;
}

/** Test hook only. */
export function _resetRateLimit() { hits.clear(); }

const sbHeaders = key => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

async function loadBudget(url, key, ownerId) {
  const res = await fetch(`${url}/rest/v1/budget_states?user_id=eq.${encodeURIComponent(ownerId)}&select=state,updated_at`, { headers: sbHeaders(key) });
  if (!res.ok) throw new Error(`Load budget failed (${res.status})`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Load budget returned an unexpected body');
  return rows[0] || null;
}

/** PATCH with the updated_at compare-and-swap. {ok:false} when the row moved underneath us. */
async function saveBudget(url, key, ownerId, state, prevUpdatedAt) {
  const stamp = new Date().toISOString();
  const payload = { ...state, _cloudUpdatedAt: Date.now() };
  const filter = prevUpdatedAt
    ? `user_id=eq.${encodeURIComponent(ownerId)}&updated_at=eq.${encodeURIComponent(prevUpdatedAt)}`
    : `user_id=eq.${encodeURIComponent(ownerId)}`;
  const res = await fetch(`${url}/rest/v1/budget_states?${filter}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(key), Prefer: 'return=representation' },
    body: JSON.stringify({ state: payload, updated_at: stamp }),
  });
  if (!res.ok) throw new Error(`Save budget failed (${res.status})`);
  const body = await res.json().catch(() => { throw new Error('Save budget returned a non-JSON body'); });
  if (!Array.isArray(body)) throw new Error('Save budget returned an unexpected body');
  return { ok: body.length > 0, updatedAt: body[0]?.updated_at || stamp };
}

const hashHex = s => createHash('sha256').update(s).digest('hex');
const newSnapshotId = () => `snap_${randomBytes(8).toString('hex')}`;

function balancesNow() {
  const { body, hashInput } = computeBalances(store);
  return { body, hash: hashHex(hashInput) };
}

/** Take a snapshot in memory on the hydrated store; returns the trimmed public record. */
function snapshotInMemory(reason, note, nowIso, keepId = null) {
  const { body, hash } = balancesNow();
  const snap = addSnapshot(store.getState(), {
    id: newSnapshotId(), at: nowIso, reason, note, stateHash: hash, totalAllocated: body.total_allocated, keepId,
  });
  return { id: snap.id, at: snap.at, reason: snap.reason, month: snap.month, state_hash: snap.state_hash };
}

/**
 * Plan + (optionally) apply against freshly hydrated state. Pure w.r.t. the network.
 * kind: 'reset' | 'restore'. Returns {error...} | {dry, table, ...} | {apply:{...}}.
 */
export function planOnState(remoteState, kind, input, snapshotId = null) {
  store.hydrateFromObject(remoteState);
  const state = store.getState();
  const before = balancesNow();
  if (before.hash !== input.expectedHash) {
    return { error: 'stale_state', status: 409, extra: { state_hash: before.hash } };
  }
  if (kind === 'overage') return planOverageOnState(before, input);
  let budgets; let carry = null; let snap = null;
  if (kind === 'reset' || kind === 'start_fresh' || kind === 'reset_carry') {
    const plan = kind === 'reset' ? planReset(state, input)
      : kind === 'start_fresh' ? planStartFresh(state, input) : planCarryReset(state, input);
    if (!plan.ok) {
      if (plan.code === 'unknown_envelope') return { error: 'unknown_envelope', status: 400, extra: { envelope: plan.envelope, validEnvelopes: plan.validEnvelopes } };
      if (plan.code === 'carry_mismatch') return { error: 'carry_mismatch', status: 409, extra: { mismatches: plan.mismatches } };
      return { error: 'invalid_body', status: 400, extra: { message: plan.message } };
    }
    if (kind === 'reset') budgets = plan.set;
    else { budgets = plan.budgets; carry = plan.carry; }
  } else {
    snap = findSnapshot(state, snapshotId);
    if (!snap) return { error: 'not_found', status: 404 };
    const plan = planRestore(state, snap);
    if (!plan.ok) return { error: plan.code, status: 409, extra: plan.snapshotMonth ? { snapshot_month: plan.snapshotMonth } : {} };
    budgets = plan.budgets; carry = plan.carry;
  }
  const beforeRaw = captureEnvelopeState(state);
  const nCats = state.categories.length;
  writeAllocations(store, budgets, carry);
  const cats = store.getState().categories;
  if (cats.length !== nCats) return { fatal: 'envelope count changed' };
  // Read back: every planned value must have landed exactly (fail closed otherwise).
  for (const c of cats) {
    if (budgets.has(c.id) && Math.round((Number(c.monthlyBudget) || 0) * 100) !== budgets.get(c.id)) return { fatal: 'allocation not applied' };
    if (carry && carry.has(c.id) && Math.round((Number(c.carryOver) || 0) * 100) !== carry.get(c.id)) return { fatal: 'carry not applied' };
  }
  const after = balancesNow();
  const table = diffTable(before.body, after.body);
  return { ok: true, before, after, table, beforeRaw, afterRaw: captureEnvelopeState(store.getState()), budgets, carry };
}

const newRowId = () => randomBytes(8).toString('hex');

function planOverageOnState(before, input) {
  const plan = planOverage(store, input);
  if (!plan.ok) {
    const { ok, code, status, ...extra } = plan;
    return { error: code, status: status || 400, extra };
  }
  const nCats = store.getState().categories.length;
  const batchId = `ovr_${randomBytes(8).toString('hex')}`;
  const rows = applyOverageInMemory(store, plan, { at: new Date().toISOString(), batchId, newId: newRowId, note: input.note });
  if (store.getState().categories.length !== nCats) return { fatal: 'envelope count changed' };
  if (!verifyOverage(store, plan)) return { fatal: 'overage not applied' };
  const after = balancesNow();
  const table = diffTable(before.body, after.body);
  const bonusAfter = Math.round(after.body.bonus_available * 100);
  return { ok: true, before, after, table, overage: plan, rows, batchId, bonusAfter };
}

/**
 * The row we write back is the RAW loaded state with only the planned envelope fields
 * (+ snapshots / audit) changed. Hydration side effects (normalization, auto-links) are
 * used for reading numbers but never persisted, so transactions, bills, debts, checking
 * and snowball data stay byte-for-byte as loaded.
 */
function patchedRaw(raw, { budgets = null, carry = null, snapshots, audit } = {}) {
  const out = structuredClone(raw);
  if (budgets || carry) {
    const ids = new Set((out.categories || []).filter(c => c && c.id).map(c => c.id));
    for (const k of [...(budgets?.keys() || []), ...(carry?.keys() || [])]) {
      if (!ids.has(k)) return null; // envelope only exists after normalization: fail closed
    }
    for (const c of out.categories) {
      if (!c || !c.id) continue;
      if (budgets?.has(c.id)) c.monthlyBudget = budgets.get(c.id) / 100;
      if (carry?.has(c.id)) c.carryOver = carry.get(c.id) / 100;
    }
  }
  if (snapshots !== undefined) out.envelopeSnapshots = snapshots;
  if (audit !== undefined) out.envelopeResetAudit = audit;
  return out;
}

const NOT_NORMALIZED = { error: 'state_not_normalized', status: 409, extra: { message: 'Open FigPig once so the budget is normalized, then retry.' } };

/** Snapshot of the loaded state, written on its own. Returns {snap, raw, updatedAt} or an error. */
async function writeSnapshot(cfg, remote, reason, note, keepId = null) {
  store.hydrateFromObject(structuredClone(remote.state));
  const snap = snapshotInMemory(reason, note, new Date().toISOString(), keepId);
  const raw = patchedRaw(remote.state, { snapshots: store.getState().envelopeSnapshots });
  const saved = await saveBudget(cfg.url, cfg.key, cfg.ownerId, raw, remote.updated_at);
  if (!saved.ok) return { error: 'conflict', status: 409, extra: { message: 'Cloud budget changed while saving the snapshot; re-read and retry.' } };
  return { snap, raw, updatedAt: saved.updatedAt };
}

/** Audit entry for an overage cover (state.envelopeResetAudit, shared list, capped). */
function appendOverageAudit(state, plan, snap, note) {
  const p = plan.overage;
  const list = Array.isArray(state.envelopeResetAudit) ? state.envelopeResetAudit : [];
  list.push({
    at: snap.at, actor: ACTOR, action: 'overage', snapshot_id: snap.id, batch_id: plan.batchId, month: p.month,
    total: p.total / 100, from_bonus: p.fromBonus / 100, split_total: p.rest / 100, negative_rule: p.negativeRule,
    bonus: plan.rows.bonus.map(b => ({ allocationId: b.id, categoryId: b.categoryId, amount: b.amount })),
    moves: plan.rows.moves.map(m => ({ moveId: m.id, fromId: m.fromId, toId: m.toId, amount: m.amount })),
    ...(note ? { note } : {}),
  });
  state.envelopeResetAudit = list.slice(-AUDIT_MAX);
}

async function runWrite(cfg, kind, input, snapshotId) {
  const { url, key, ownerId } = cfg;
  const remote = await loadBudget(url, key, ownerId);
  if (!remote?.state || typeof remote.state !== 'object') return { error: 'no_budget', status: 409 };
  let plan = planOnState(structuredClone(remote.state), kind, input, snapshotId);
  if (!plan.ok || input.dryRun) return { plan };
  if (kind === 'overage') {
    if (!appendOverageRows(structuredClone(remote.state), plan.overage.month, plan.rows)) return NOT_NORMALIZED;
  } else if (!patchedRaw(remote.state, { budgets: plan.budgets, carry: plan.carry })) return NOT_NORMALIZED;

  // 1) Automatic snapshot first, as its own write (state as loaded, before any change).
  const first = await writeSnapshot(cfg, remote, ({ reset: 'pre_reset', restore: 'pre_restore', overage: 'pre_overage', start_fresh: 'pre_start_fresh', reset_carry: 'pre_carry_reset' })[kind], input.note, snapshotId);
  if (first.error) return first;
  const snap = first.snap;

  // 2) Apply on the row that now holds the snapshot; same CAS on hash + updated_at.
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = attempt === 0 ? { state: first.raw, updated_at: first.updatedAt } : await loadBudget(url, key, ownerId);
    if (!base?.state || typeof base.state !== 'object') throw new Error('Budget disappeared during write');
    const snaps = Array.isArray(base.state.envelopeSnapshots) ? base.state.envelopeSnapshots : [];
    if (!snaps.some(x => x && x.id === snap.id)) {
      return { error: 'conflict', status: 409, snapshot: snap, extra: { message: 'Snapshot was overwritten by another save; nothing applied. Re-read and retry.' } };
    }
    plan = planOnState(structuredClone(base.state), kind, input, snapshotId);
    if (!plan.ok) return { plan, snapshot: snap };
    let raw;
    if (kind === 'overage') {
      appendOverageAudit(store.getState(), plan, snap, input.note);
      raw = patchedRaw(base.state, { audit: store.getState().envelopeResetAudit });
      if (raw) raw = appendOverageRows(raw, plan.overage.month, plan.rows);
    } else {
      appendEnvelopeAudit(store.getState(), {
        at: snap.at, action: kind, snapshotId: snap.id, beforeRaw: plan.beforeRaw, afterRaw: plan.afterRaw, note: input.note,
      });
      raw = patchedRaw(base.state, { budgets: plan.budgets, carry: plan.carry, audit: store.getState().envelopeResetAudit });
    }
    if (!raw) return { ...NOT_NORMALIZED, snapshot: snap };
    const s2 = await saveBudget(url, key, ownerId, raw, base.updated_at);
    if (s2.ok) return { plan, snapshot: snap, written: true };
  }
  return { error: 'conflict', status: 409, snapshot: snap, extra: { message: 'Cloud budget changed twice while saving; re-read and retry.' } };
}

function routeOf(req, context) {
  const p = new URL(req.url).pathname.replace(/\/+$/, '');
  if (p === '/api/envelopes/snapshot') return { kind: 'snapshot' };
  if (p === '/api/envelopes/reset') return { kind: 'reset' };
  if (p === '/api/envelopes/overage') return { kind: 'overage' };
  if (p === '/api/envelopes/start-fresh') return { kind: 'start_fresh' };
  if (p === '/api/envelopes/reset-carry') return { kind: 'reset_carry' };
  const m = p.match(/^\/api\/envelopes\/snapshots\/([^/]+)\/restore$/);
  if (m) {
    const id = String(context?.params?.id || decodeURIComponent(m[1]));
    return { kind: 'restore', id };
  }
  return { kind: null };
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-figpig-envelope-write-token',
      'access-control-max-age': '86400',
    } });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  if (!rateLimitOk(clientKey(req))) return json(429, { ok: false, error: 'rate_limited' });

  const expectedToken = env('FIGPIG_ENVELOPE_WRITE_TOKEN');
  const url = env('SUPABASE_URL')?.replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');
  const reused = OTHER_TOKENS.some(n => { const v = env(n); return v && v === expectedToken; });
  if (!expectedToken || expectedToken.length < 24 || reused || !url || !key || !ownerId || !/^https:\/\//i.test(url)) {
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!secretsMatch(providedToken(req), expectedToken)) return json(401, { ok: false, error: 'unauthorized' });

  const route = routeOf(req, context);
  if (!route.kind) return json(404, { ok: false, error: 'not_found' });
  if (route.kind === 'restore' && !SNAPSHOT_ID_RE.test(route.id)) {
    return json(400, { ok: false, error: 'invalid_body', message: 'Bad snapshot id' });
  }

  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) {
    return json(415, { ok: false, error: 'invalid_body', message: 'Content-Type must be application/json' });
  }
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: 'invalid_body', message: 'Body too large' });
  }
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'invalid_body', message: 'Body too large' });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'invalid_body', message: 'JSON body required' });
  }
  const checked = route.kind === 'reset' ? validateResetBody(body)
    : route.kind === 'overage' ? validateOverageBody(body)
    : route.kind === 'start_fresh' ? validateStartFreshBody(body)
    : route.kind === 'reset_carry' ? validateCarryResetBody(body)
    : route.kind === 'restore' ? validateRestoreBody(body)
      : validateSnapshotBody(body);
  if (!checked.ok) return json(400, { ok: false, error: 'invalid_body', message: checked.message });
  const input = checked.value;
  const cfg = { url, key, ownerId };

  const result = await withStoreLock(async () => {
    if (route.kind === 'snapshot') {
      const remote = await loadBudget(url, key, ownerId);
      if (!remote?.state || typeof remote.state !== 'object') return { error: 'no_budget', status: 409 };
      const w = await writeSnapshot(cfg, remote, 'manual', input.note);
      return w.error ? w : { snapshotOnly: w.snap };
    }
    return runWrite(cfg, route.kind, input, route.id);
  }).catch(err => ({ upstream: err?.message || 'write failed' }));

  if (result.upstream) {
    console.error('envelopes-write failed', result.upstream);
    return json(502, { ok: false, error: 'upstream_error' });
  }
  if (result.snapshotOnly) return json(200, { ok: true, status: 'snapshot_saved', snapshot: result.snapshotOnly });
  const fail = result.error ? result : (result.plan && !result.plan.ok ? result.plan : null);
  if (fail) {
    if (fail.fatal) {
      console.error('envelopes-write refused', fail.fatal);
      return json(500, { ok: false, error: 'write_refused' });
    }
    const out = { ok: false, error: fail.error, ...(fail.extra || {}) };
    if (result.snapshot) out.snapshot = result.snapshot;
    if (fail.error === 'no_budget') out.message = 'No FigPig budget in the cloud yet.';
    return json(fail.status || 400, out);
  }
  const p = result.plan;
  if (route.kind === 'overage') {
    return json(200, {
      ok: true,
      status: input.dryRun ? 'dry_run' : 'applied',
      dry_run: !!input.dryRun,
      ...(result.snapshot ? { snapshot: result.snapshot, batch_id: p.batchId } : {}),
      state_hash_before: p.before.hash,
      state_hash_after: p.after.hash,
      ...overageResponse(p.overage, p.bonusAfter),
      totals: p.table.totals,
    });
  }
  const out = {
    ok: true,
    status: input.dryRun ? 'dry_run' : 'applied',
    dry_run: !!input.dryRun,
    ...(route.kind === 'restore' ? { restored_from: route.id } : {}),
    ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    state_hash_before: p.before.hash,
    state_hash_after: p.after.hash,
    totals: p.table.totals,
    changes: p.table.changes,
  };
  return json(200, out);
};

export const config = {
  path: ['/api/envelopes/snapshot', '/api/envelopes/snapshots/:id/restore', '/api/envelopes/reset', '/api/envelopes/overage', '/api/envelopes/start-fresh', '/api/envelopes/reset-carry'],
};
