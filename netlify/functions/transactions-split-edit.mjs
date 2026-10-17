import { timingSafeEqual, createHash } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import { validateEditBody, planSplitEdit, appendAudit, publicLines, TX_ID_RE } from '../../js/split-edit.js';
import { candidateSummary, fromCents } from '../../js/receipt-split.js';

/**
 * PATCH /api/transactions/:id/split — edit an APPLIED split on one transaction in place.
 *
 * Auth: Authorization: Bearer <FIGPIG_SPLIT_WRITE_TOKEN> (alt header x-figpig-split-write-token).
 * Own token (>= 24 chars); never reuses another FigPig token. 503 when unset/short or
 * Supabase env missing. 10 writes/min per client IP, counted BEFORE auth.
 *
 * Body: {expected:[{envelope, amount}], split:[{envelope, amount}], note?}
 *  - compare-and-swap: 409 stale_expected (+ current split) when expected != stored split
 *  - split must sum to the transaction amount to the cent, else 400 sum_mismatch
 *  - unknown envelope → 400 unknown_envelope + validEnvelopes. Never creates envelopes.
 * Writes splits only via store.updateTransaction (the UI's own edit path, persist:false):
 * amount, checking and snowball math are untouched; no new rows. Appends an audit entry
 * to state.splitEditAudit. Saves with the budget_states updated_at check; retries once.
 * Supabase failures (any non-2xx / bad body / network) → 502, never a conflict.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const MAX_BODY_BYTES = 16 * 1024;
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
  return String(req.headers.get('x-figpig-split-write-token') || '').trim();
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
  return Array.isArray(rows) ? rows[0] : null;
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

let storeLock = Promise.resolve();
function withStoreLock(fn) {
  const run = storeLock.then(fn, fn);
  storeLock = run.then(() => undefined, () => undefined);
  return run;
}

/** Plan + in-place write against freshly hydrated state. Pure w.r.t. the network. */
export function applyEditToState(remoteState, txId, input, nowIso = new Date().toISOString()) {
  store.hydrateFromObject(remoteState);
  const state = store.getState();
  const plan = planSplitEdit(state, txId, input);
  if (!plan.ok || plan.unchanged) return { plan, write: false };
  const res = store.updateTransaction(txId, {
    splits: plan.after.map(l => ({ categoryId: l.categoryId, amount: fromCents(l.cents) })),
  }, { persist: false });
  if (res && res.ok === false) return { plan: { ok: false, code: 'write_refused' } };
  const s = store.getState();
  const tx = s.transactions.find(t => t.id === txId);
  const stored = (tx?.splits || []).map(x => `${x.categoryId}=${Math.round(x.amount * 100)}`).sort().join(',');
  const want = plan.after.map(l => `${l.categoryId}=${l.cents}`).sort().join(',');
  if (stored !== want) return { plan: { ok: false, code: 'write_refused' } };
  appendAudit(s, {
    at: nowIso,
    actor: 'CoS',
    txId,
    before: plan.before.map(l => ({ categoryId: l.categoryId, amount: fromCents(l.cents) })),
    after: plan.after.map(l => ({ categoryId: l.categoryId, amount: fromCents(l.cents) })),
    ...(input.note ? { note: input.note } : {}),
  });
  return { plan, write: true };
}

const ERR = {
  not_found: [404, 'Transaction not found'],
  not_split: [409, 'Transaction has no applied split to edit'],
  stale_expected: [409, 'expected does not match the current split'],
  sum_mismatch: [400, 'split must add up to the transaction amount to the cent'],
  unknown_envelope: [400, 'Unknown envelope'],
  invalid_body: [400, 'Invalid body'],
  write_refused: [409, 'Split could not be written'],
};

function errorResponse(plan, categories) {
  const [status, message] = ERR[plan.code] || [400, plan.code];
  const out = { ok: false, error: plan.code, message: plan.message || message };
  if (plan.code === 'stale_expected' || plan.code === 'not_split') out.current = plan.current || [];
  if (plan.code === 'sum_mismatch') { out.transactionAmount = plan.transactionAmount; out.splitTotal = plan.splitTotal; }
  if (plan.code === 'unknown_envelope') { out.envelope = plan.envelope; out.validEnvelopes = plan.validEnvelopes || []; }
  return json(status, out);
}

function txIdFrom(req, context) {
  const fromCtx = context?.params?.id;
  if (fromCtx) return String(fromCtx);
  const m = new URL(req.url).pathname.match(/^\/api\/transactions\/([^/]+)\/split\/?$/);
  return m ? decodeURIComponent(m[1]) : '';
}

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'access-control-allow-methods': 'PATCH, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-figpig-split-write-token',
      'access-control-max-age': '86400',
    } });
  }
  if (req.method !== 'PATCH') return json(405, { ok: false, error: 'method_not_allowed' });
  if (!rateLimitOk(clientKey(req))) return json(429, { ok: false, error: 'rate_limited' });

  const expectedToken = env('FIGPIG_SPLIT_WRITE_TOKEN');
  const supabaseUrl = env('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');
  if (!expectedToken || expectedToken.length < 24 || !supabaseUrl || !serviceKey || !ownerId
    || !/^https:\/\//i.test(supabaseUrl)) {
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!secretsMatch(providedToken(req), expectedToken)) return json(401, { ok: false, error: 'unauthorized' });

  const txId = txIdFrom(req, context);
  if (!TX_ID_RE.test(txId)) return json(400, { ok: false, error: 'invalid_body', message: 'Bad transaction id' });

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
  const checked = validateEditBody(body);
  if (!checked.ok) return json(400, { ok: false, error: 'invalid_body', message: checked.message });
  const input = checked.value;

  const result = await withStoreLock(async () => {
    let remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
    if (!remote?.state) return { missing: true };
    let out = applyEditToState(remote.state, txId, input);
    if (!out.plan.ok || !out.write) return out;
    let saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
    if (!saved.ok) {
      remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
      if (!remote?.state) throw new Error('Budget disappeared during edit');
      out = applyEditToState(remote.state, txId, input); // re-checks expected (CAS) on fresh state
      if (!out.plan.ok || !out.write) return out;
      saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
    }
    return { ...out, saved: saved.ok };
  }).catch(err => ({ error: err?.message || 'Edit failed' }));

  if (result.missing) return json(409, { ok: false, error: 'no_budget', message: 'No FigPig budget in the cloud yet.' });
  if (result.error) {
    console.error('transactions-split-edit failed', result.error);
    return json(502, { ok: false, error: 'upstream_error' });
  }
  if (!result.plan.ok) return errorResponse(result.plan);
  if (result.write && !result.saved) {
    return json(409, { ok: false, error: 'conflict', message: 'Cloud budget changed twice while saving; retry.' });
  }
  const cats = store.getState().categories;
  return json(200, {
    ok: true,
    status: result.write ? 'updated' : 'unchanged',
    transaction: candidateSummary(result.plan.tx),
    before: publicLines(result.plan.before, cats),
    split: publicLines(result.plan.after, cats),
  });
};

export const config = {
  path: '/api/transactions/:id/split',
};
