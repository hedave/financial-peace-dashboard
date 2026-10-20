import { timingSafeEqual, createHash } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import { computeBalances, listSnapshots, withStoreLock } from '../../js/envelope-reset.js';

/**
 * GET /api/envelopes — envelopes with current-month balances:
 *   {ok, month, checking_balance, total_allocated, unallocated, bonus_available,
 *    newest_transaction_date, state_hash,
 *    uncategorized:{count,total},
 *    envelopes:[{id, name, group?, sinkingFund?, kind?, allocated, spent, carry, remaining, bill_id}]}
 * Optional ?month=YYYY-MM: per-month figures (carry = that month's opening carry, from the
 * store's getOpeningCarryForMonth). unallocated = checking − total_allocated (the "unassigned" total).
 * state_hash always describes the current month.
 * kind (top-level only): bill | debt | sinking | spend (store.getEnvelopeKind).
 * Numbers come from the store's own getters (same as the Budget page). No notes, plan
 * internals, transactions or bill details. `state_hash` feeds the CAS on reset/restore/overage.
 * GET /api/envelopes/snapshots — trimmed snapshot list (no per-envelope amounts).
 *
 * Auth: the existing read token FIGPIG_BILLS_READ_TOKEN (Bearer, or x-figpig-bills-token).
 * 503 when unset/short or Supabase env missing. 30 req/min per client IP, counted before
 * auth. Supabase failure → 502. Writes live in envelopes-write.mjs (own token).
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
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
  return String(req.headers.get('x-figpig-bills-token') || '').trim();
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

export default async (req) => {
  if (req.method !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
  if (!rateLimitOk(req)) return json(429, { ok: false, error: 'rate_limited' });
  const expected = env('FIGPIG_BILLS_READ_TOKEN');
  const supabaseUrl = env('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');
  if (!expected || expected.length < 24 || !supabaseUrl || !serviceKey || !ownerId || !/^https:\/\//i.test(supabaseUrl)) {
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!secretsMatch(providedToken(req), expected)) return json(401, { ok: false, error: 'unauthorized' });
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/budget_states?user_id=eq.${encodeURIComponent(ownerId)}&select=state`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!res.ok) throw new Error(`Load failed (${res.status})`);
    const rows = await res.json();
    const state = Array.isArray(rows) ? rows[0]?.state : null;
    if (!state || typeof state !== 'object') return json(409, { ok: false, error: 'no_budget' });
    const u = new URL(req.url);
    const isList = /^\/api\/envelopes\/snapshots\/?$/.test(u.pathname);
    const qKeys = [...u.searchParams.keys()];
    const month = u.searchParams.get('month');
    if (qKeys.some(k => k !== 'month') || qKeys.length > 1 || (month != null && (isList || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)))) {
      return json(400, { ok: false, error: 'invalid_query', message: 'Only ?month=YYYY-MM is accepted (balances only)' });
    }
    const out = await withStoreLock(() => {
      store.hydrateFromObject(state);
      if (isList) return { ok: true, snapshots: listSnapshots(store.getState()) };
      // state_hash always covers the CURRENT month (what reset/restore/overage CAS on).
      const { body: cur, hashInput } = computeBalances(store);
      const body = month && month !== cur.month ? computeBalances(store, month).body : cur;
      return { ok: true, ...body, state_hash: createHash('sha256').update(hashInput).digest('hex') };
    });
    return json(200, out);
  } catch (err) {
    console.error('envelopes failed', err?.message);
    return json(502, { ok: false, error: 'upstream_error' });
  }
};

export const config = {
  path: ['/api/envelopes', '/api/envelopes/snapshots'],
};
