import { timingSafeEqual, createHash } from 'node:crypto';
import './polyfill-storage.mjs';
import { listEnvelopes } from '../../js/split-edit.js';

/**
 * GET /api/envelopes — read-only list of envelopes: [{id, name, group?, sinkingFund?}].
 * No balances, budgets or notes. Auth: the existing read token FIGPIG_BILLS_READ_TOKEN
 * (Bearer, or x-figpig-bills-token). 503 when unset/short or Supabase env missing.
 * 30 req/min per client IP, counted before auth. Supabase failure → 502.
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
    if (!state) return json(409, { ok: false, error: 'no_budget' });
    return json(200, { ok: true, envelopes: listEnvelopes(state.categories) });
  } catch (err) {
    console.error('envelopes failed', err?.message);
    return json(502, { ok: false, error: 'upstream_error' });
  }
};

export const config = {
  path: '/api/envelopes',
};
