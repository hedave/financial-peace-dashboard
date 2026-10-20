import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import { withStoreLock } from '../../js/envelope-reset.js';
import {
  validateVoidBody, validateVoidRestoreBody, checkVoidTarget, voidOnRaw, restoreOnRaw,
  addVoidRecord, findVoid, publicTx, TX_ID_RE, VOID_ID_RE, ACTOR,
} from '../../js/tx-fix.js';

/**
 * POST /api/transactions/:id/void            {expected_amount, expected_date, dry_run?=true, note?}
 * POST /api/transactions/voids/:voidId/restore {dry_run?=true, note?}
 *
 * Void removes one transaction exactly like the app's Delete (store.deleteTransaction: checking,
 * debt payment, earmark carry and refund link are reversed) and writes an undo record to
 * state.transactionVoids (full transaction copy). expected_amount (absolute) + expected_date must
 * match the stored row, else 409 expected_mismatch. Restore re-inserts it (store.restoreDeletedTransaction
 * math) and marks the record restored. dry_run defaults to true and writes nothing.
 * Applied to the RAW loaded row (hydration side effects never persisted); saved with the
 * budget_states updated_at compare-and-swap, re-checked and retried once.
 *
 * Auth: Bearer <FIGPIG_TX_VOID_TOKEN> (alt x-figpig-tx-void-token). Own token (>= 24 chars, must
 * differ from every other FigPig token) — 503 when unset/short/reused or Supabase env missing.
 * 10 writes/min per client IP, counted before auth. Supabase failures → 502.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const MAX_BODY_BYTES = 4 * 1024;
const OTHER_TOKENS = ['FIGPIG_BILLS_READ_TOKEN', 'FIGPIG_SPLIT_WRITE_TOKEN', 'FIGPIG_TX_SPLIT_TOKEN', 'FIGPIG_TX_WRITE_TOKEN',
  'FIGPIG_INGEST_SECRET', 'FIGPIG_ENVELOPE_WRITE_TOKEN', 'FIGPIG_TX_READ_TOKEN'];
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

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b) && String(provided).length === String(expected).length;
}

function providedToken(req) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return String(req.headers.get('x-figpig-tx-void-token') || '').trim();
}

function rateLimitOk(req) {
  const key = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
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
  return { ok: body.length > 0 };
}

/** The store's own deleteTransaction / restore helpers, applied to a raw state object. */
const helpers = {
  getCheckingDelta: (...a) => store.getCheckingDelta(...a),
  applyCheckingDelta: (...a) => store.applyCheckingDelta(...a),
  adjustDebtForPayment: (...a) => store.adjustDebtForPayment(...a),
  reverseEarmarkCarry: (...a) => store.reverseEarmarkCarry(...a),
};

/** Category names for the public row come from the raw row's envelopes. */
const byIdOf = raw => new Map((raw.categories || []).filter(c => c && c.id).map(c => [String(c.id), c]));

/** Plan (and apply in memory) on a fresh clone. Returns {error} or {raw, out}. */
function planVoid(remoteState, txId, input) {
  const raw = structuredClone(remoteState);
  if (!Array.isArray(raw.transactions)) return { error: 'not_found', status: 404 };
  const chk = checkVoidTarget(raw, txId, input);
  if (!chk.ok) return { error: chk.code, status: chk.status, extra: chk.actual ? { actual: chk.actual } : {} };
  const transaction = publicTx(chk.tx, byIdOf(raw));
  const { snapshot, effects } = voidOnRaw(raw, txId, helpers);
  return { raw, snapshot, transaction, effects };
}

function planRestore(remoteState, voidId) {
  const raw = structuredClone(remoteState);
  const rec = findVoid(raw, voidId);
  if (!rec || !rec.tx || !rec.tx.id) return { error: 'not_found', status: 404 };
  if (rec.restored_at) return { error: 'already_restored', status: 409 };
  raw.transactions = Array.isArray(raw.transactions) ? raw.transactions : [];
  if (raw.transactions.some(t => t && String(t.id) === String(rec.tx.id))) return { error: 'transaction_exists', status: 409 };
  const transaction = publicTx(rec.tx, byIdOf(raw));
  const effects = restoreOnRaw(raw, rec.tx, helpers);
  return { raw, rec: findVoid(raw, voidId), transaction, effects };
}

function routeOf(req, context) {
  const p = new URL(req.url).pathname.replace(/\/+$/, '');
  let m = p.match(/^\/api\/transactions\/voids\/([^/]+)\/restore$/);
  if (m) return { kind: 'restore', id: String(context?.params?.voidId || decodeURIComponent(m[1])) };
  m = p.match(/^\/api\/transactions\/([^/]+)\/void$/);
  if (m) return { kind: 'void', id: String(context?.params?.id || decodeURIComponent(m[1])) };
  return { kind: null };
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-figpig-tx-void-token',
      'access-control-max-age': '86400',
    } });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  if (!rateLimitOk(req)) return json(429, { ok: false, error: 'rate_limited' });

  const expected = env('FIGPIG_TX_VOID_TOKEN');
  const url = env('SUPABASE_URL')?.replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');
  const reused = OTHER_TOKENS.some(n => { const v = env(n); return v && v === expected; });
  if (!expected || expected.length < 24 || reused || !url || !key || !ownerId || !/^https:\/\//i.test(url)) {
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!secretsMatch(providedToken(req), expected)) return json(401, { ok: false, error: 'unauthorized' });

  const route = routeOf(req, context);
  if (!route.kind) return json(404, { ok: false, error: 'not_found' });
  if (route.kind === 'void' && !TX_ID_RE.test(route.id)) return json(400, { ok: false, error: 'invalid_body', message: 'Bad transaction id' });
  if (route.kind === 'restore' && !VOID_ID_RE.test(route.id)) return json(400, { ok: false, error: 'invalid_body', message: 'Bad void id' });
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) {
    return json(415, { ok: false, error: 'invalid_body', message: 'Content-Type must be application/json' });
  }
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) return json(413, { ok: false, error: 'invalid_body', message: 'Body too large' });
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'invalid_body', message: 'Body too large' });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'invalid_body', message: 'JSON body required' });
  }
  const checked = route.kind === 'void' ? validateVoidBody(body) : validateVoidRestoreBody(body);
  if (!checked.ok) return json(400, { ok: false, error: 'invalid_body', message: checked.message });
  const input = checked.value;

  const result = await withStoreLock(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remote = await loadBudget(url, key, ownerId);
      if (!remote?.state || typeof remote.state !== 'object') return { error: 'no_budget', status: 409 };
      const plan = route.kind === 'void' ? planVoid(remote.state, route.id, input) : planRestore(remote.state, route.id);
      if (plan.error || input.dryRun) return plan;
      const at = new Date().toISOString();
      if (route.kind === 'void') {
        plan.voidId = `void_${randomBytes(8).toString('hex')}`;
        addVoidRecord(plan.raw, { id: plan.voidId, at, actor: ACTOR, tx: plan.snapshot, ...(input.note ? { note: input.note } : {}) });
      } else {
        plan.rec.restored_at = at;
        if (input.note) plan.rec.restore_note = input.note;
      }
      const saved = await saveBudget(url, key, ownerId, plan.raw, remote.updated_at);
      if (saved.ok) return { ...plan, written: true };
    }
    return { error: 'conflict', status: 409, extra: { message: 'Cloud budget changed twice while saving; re-read and retry.' } };
  }).catch(err => ({ upstream: err?.message || 'write failed' }));

  if (result.upstream) {
    console.error('transactions-void failed', result.upstream);
    return json(502, { ok: false, error: 'upstream_error' });
  }
  if (result.error) return json(result.status || 400, { ok: false, error: result.error, ...(result.extra || {}) });
  return json(200, {
    ok: true,
    status: input.dryRun ? 'dry_run' : (route.kind === 'void' ? 'voided' : 'restored'),
    dry_run: !!input.dryRun,
    ...(route.kind === 'void' && result.voidId ? { void_id: result.voidId } : {}),
    ...(route.kind === 'restore' ? { restored_from: route.id } : {}),
    transaction: result.transaction,
    effects: result.effects,
  });
};

export const config = {
  path: ['/api/transactions/:id/void', '/api/transactions/voids/:voidId/restore'],
};
