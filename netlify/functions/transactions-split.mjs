import { timingSafeEqual, createHash } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import {
  validateSplitBody,
  planReceiptSplit,
  buildReviewItem,
  upsertReviewItem,
  candidateSummary,
  publicSplits,
  describeAdjustment,
  ERROR_STATUS,
  ERROR_MESSAGE,
} from '../../js/receipt-split.js';

/**
 * POST /api/transactions/split — put a receipt split on an EXISTING bank row.
 *
 * Auth: Authorization: Bearer <FIGPIG_TX_SPLIT_TOKEN>
 * (alternate header: x-figpig-tx-split-token). Its own token: never reuses
 * FIGPIG_TX_WRITE_TOKEN, FIGPIG_INGEST_SECRET or FIGPIG_BILLS_READ_TOKEN.
 * Fails closed (503) when the token or Supabase env is missing.
 *
 * Apply:  {match:{externalId? | date, amount, merchant}, splits:[{envelope, amount}], receiptId, memo?, dryRun?}
 * Review: {review:true, receipt:{receiptId, store, date, total, proposedSplits, items?, reason?}, dryRun?}
 *
 * Writes splits / memo / receiptId only (store.updateTransaction, persist:false).
 * Never changes amount, so checking is untouched. Saves with the budget_states
 * updated_at optimistic-concurrency check and retries once on conflict.
 * Responses carry only the matched row summary and the proposed split.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20; // per client IP, counted BEFORE auth so bad tokens are throttled too
const MAX_BODY_BYTES = 64 * 1024;
const hits = new Map(); // best-effort per function instance

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
  } catch {
    /* netlify dev / node */
  }
  return process.env[name] || '';
}

/** Constant-time compare (hash first so length differences don't leak timing). */
export function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b) && String(provided).length === String(expected).length;
}

function providedToken(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return String(req.headers.get('x-figpig-tx-split-token') || '').trim();
}

function clientKey(req) {
  return (
    req.headers.get('x-nf-client-connection-ip')
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'
  );
}

function rateLimitOk(key) {
  const now = Date.now();
  let bucket = hits.get(key);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    bucket = { start: now, count: 0 };
    hits.set(key, bucket);
  }
  bucket.count += 1;
  if (hits.size > 5000) {
    for (const [k, b] of hits) if (now - b.start >= WINDOW_MS) hits.delete(k);
  }
  return bucket.count <= MAX_PER_WINDOW;
}

/** Test hook only. */
export function _resetRateLimit() {
  hits.clear();
}

function sbHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

async function loadBudget(url, key, ownerId) {
  const res = await fetch(
    `${url}/rest/v1/budget_states?user_id=eq.${encodeURIComponent(ownerId)}&select=state,updated_at`,
    { headers: sbHeaders(key) },
  );
  if (!res.ok) throw new Error(`Load budget failed (${res.status})`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

/**
 * PATCH only if updated_at is still what we loaded (optimistic concurrency).
 * Returns {ok:false} ONLY for a real updated_at mismatch (2xx with zero rows).
 * Any other failure (4xx/5xx, bad body, network) throws → 502 upstream_error.
 */
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
  const body = await res.json().catch(() => {
    throw new Error('Save budget returned a non-JSON body');
  });
  if (!Array.isArray(body)) throw new Error('Save budget returned an unexpected body');
  return { ok: body.length > 0 };
}

let storeLock = Promise.resolve();
function withStoreLock(fn) {
  const run = storeLock.then(fn, fn);
  storeLock = run.then(() => undefined, () => undefined);
  return run;
}

function errorResponse(plan) {
  const status = ERROR_STATUS[plan.code] || 400;
  const out = { ok: false, error: plan.code, message: plan.message || ERROR_MESSAGE[plan.code] || plan.code };
  if (plan.code === 'multiple_matches' && Number.isFinite(plan.count)) out.count = plan.count;
  if (plan.code === 'sum_mismatch') {
    out.bankAmount = plan.bankAmount;
    out.splitsTotal = plan.splitsTotal;
  }
  if (plan.code === 'unknown_envelope' && plan.envelope) out.envelope = plan.envelope;
  return json(status, out);
}

/** Run one plan+write against freshly hydrated state. Pure w.r.t. the network. */
export function applyToState(remoteState, input) {
  store.hydrateFromObject(remoteState);
  const state = store.getState();
  if (input.mode === 'review') {
    const built = buildReviewItem(state, input.receipt);
    if (!built.ok) return { plan: built };
    if (input.dryRun) {
      return {
        plan: { ok: true, status: 'dry_run' },
        review: { receiptId: built.value.receiptId, candidates: built.value.candidates.length },
        write: false,
      };
    }
    const up = upsertReviewItem(state, built.value);
    if (!up.ok) return { plan: up };
    const pending = state.receiptReview.filter(r => r.status === 'pending').length;
    return {
      plan: { ok: true, status: up.status },
      review: { receiptId: built.value.receiptId, candidates: built.value.candidates.length, pending },
      write: up.status !== 'unchanged',
    };
  }
  const plan = planReceiptSplit(state, input);
  if (!plan.ok) return { plan };
  const summary = {
    candidate: candidateSummary(plan.tx),
    splits: publicSplits(plan.splits, state.categories),
  };
  if (plan.adjustedCents) {
    const env = state.categories.find(c => c.id === plan.adjustedCategoryId)?.name || null;
    summary.adjustment = {
      envelope: env,
      amount: plan.adjustedCents / 100,
      note: describeAdjustment(plan.adjustedCents, env),
    };
  }
  if (plan.status !== 'ready') {
    // unchanged / removed_by_user / changed_by_user: receiptId already used, never re-applied
    return { plan, summary, write: false };
  }
  if (input.dryRun) return { plan: { ...plan, status: 'dry_run' }, summary, write: false };
  const res = store.applyReceiptSplit(plan, { receiptId: input.receiptId, memo: input.memo }, { persist: false });
  if (!res.ok) return { plan: res };
  return { plan: { ok: true, status: 'applied' }, summary: { ...summary, memoSet: res.memoSet }, write: true };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-figpig-tx-split-token',
        'access-control-max-age': '86400',
      },
    });
  }
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  if (!rateLimitOk(clientKey(req))) return json(429, { ok: false, error: 'rate_limited' });

  const expected = env('FIGPIG_TX_SPLIT_TOKEN');
  const supabaseUrl = env('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');
  if (!expected || expected.length < 24 || !supabaseUrl || !serviceKey || !ownerId) {
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!/^https:\/\//i.test(supabaseUrl)) return json(503, { ok: false, error: 'not_configured' });

  if (!secretsMatch(providedToken(req), expected)) return json(401, { ok: false, error: 'unauthorized' });

  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) {
    return json(415, { ok: false, error: 'invalid_body', message: 'Content-Type must be application/json' });
  }
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: 'invalid_body', message: 'Body too large' });
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'invalid_body', message: 'Body too large' });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'invalid_body', message: 'JSON body required' });
  }

  const checked = validateSplitBody(body);
  if (!checked.ok) return json(400, { ok: false, error: 'invalid_body', message: checked.message });
  const input = checked.value;

  const result = await withStoreLock(async () => {
    let remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
    if (!remote?.state) return { missing: true };
    let out = applyToState(remote.state, input);
    if (!out.plan.ok || !out.write) return out;
    let saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
    if (!saved.ok) {
      // Conflict: someone saved in between. Reload, re-plan, retry once.
      remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
      if (!remote?.state) throw new Error('Budget disappeared during apply');
      out = applyToState(remote.state, input);
      if (!out.plan.ok || !out.write) return { ...out, retried: true };
      saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
    }
    return { ...out, saved: saved.ok };
  }).catch((err) => ({ error: err?.message || 'Apply failed' }));

  if (result.missing) return json(409, { ok: false, error: 'no_budget', message: 'No FigPig budget in the cloud yet.' });
  if (result.error) {
    console.error('transactions-split failed', result.error);
    return json(502, { ok: false, error: 'upstream_error' });
  }
  if (!result.plan.ok) return errorResponse(result.plan);
  if (result.write && !result.saved) {
    return json(409, { ok: false, error: 'conflict', message: 'Cloud budget changed twice while saving; retry the same payload.' });
  }

  const status = result.plan.status;
  if (input.mode === 'review') {
    return json(status === 'queued' ? 201 : 200, { ok: true, status, ...result.review });
  }
  return json(200, {
    ok: true,
    status,
    receiptId: input.receiptId,
    candidate: result.summary.candidate,
    splits: result.summary.splits,
    ...(result.summary.adjustment ? { adjustment: result.summary.adjustment } : {}),
    ...(status === 'applied' ? { memoSet: !!result.summary.memoSet } : {}),
  });
};

export const config = {
  path: '/api/transactions/split',
};
