import { timingSafeEqual, createHash } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import { withStoreLock } from '../../js/envelope-reset.js';
import { validateListQuery, listTransactions } from '../../js/tx-fix.js';

/**
 * GET /api/transactions?month=YYYY-MM&envelope=<name>&limit=<1..500>
 *   → {ok, month, envelope, total, truncated, transactions:[{id, date, amount, type, payee,
 *      envelope, splits?, pending?, source: "bank"|"manual"}]}
 * At least one of month / envelope is required. Newest first. No notes, rule data or raw fields.
 *
 * Auth: Authorization: Bearer <FIGPIG_TX_READ_TOKEN> (alt x-figpig-tx-read-token). Own token
 * (>= 24 chars, must differ from every other FigPig token) — 503 when unset/short/reused or
 * Supabase env missing (fails closed). 30 req/min per client IP, counted before auth.
 * POST /api/transactions (bank import, FIGPIG_TX_WRITE_TOKEN) is a different function;
 * the two are split by method in each function's config.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const OTHER_TOKENS = ['FIGPIG_BILLS_READ_TOKEN', 'FIGPIG_SPLIT_WRITE_TOKEN', 'FIGPIG_TX_SPLIT_TOKEN', 'FIGPIG_TX_WRITE_TOKEN',
  'FIGPIG_INGEST_SECRET', 'FIGPIG_ENVELOPE_WRITE_TOKEN', 'FIGPIG_TX_VOID_TOKEN'];
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
  return String(req.headers.get('x-figpig-tx-read-token') || '').trim();
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
  const expected = env('FIGPIG_TX_READ_TOKEN');
  const url = env('SUPABASE_URL')?.replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');
  const reused = OTHER_TOKENS.some(n => { const v = env(n); return v && v === expected; });
  if (!expected || expected.length < 24 || reused || !url || !key || !ownerId || !/^https:\/\//i.test(url)) {
    return json(503, { ok: false, error: 'not_configured' });
  }
  if (!secretsMatch(providedToken(req), expected)) return json(401, { ok: false, error: 'unauthorized' });
  const q = validateListQuery(new URL(req.url).searchParams);
  if (!q.ok) return json(400, { ok: false, error: 'invalid_query', message: q.message });
  try {
    const res = await fetch(
      `${url}/rest/v1/budget_states?user_id=eq.${encodeURIComponent(ownerId)}&select=state`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) throw new Error(`Load failed (${res.status})`);
    const rows = await res.json();
    const state = Array.isArray(rows) ? rows[0]?.state : null;
    if (!state || typeof state !== 'object') return json(409, { ok: false, error: 'no_budget' });
    const out = await withStoreLock(() => {
      store.hydrateFromObject(structuredClone(state));
      return listTransactions(store.getState(), q.value);
    });
    if (!out.ok) return json(400, { ok: false, error: out.code, envelope: out.envelope, validEnvelopes: out.validEnvelopes });
    return json(200, { ok: true, month: q.value.month, envelope: q.value.envelope, total: out.total, truncated: out.truncated, transactions: out.transactions });
  } catch (err) {
    console.error('transactions-read failed', err?.message);
    return json(502, { ok: false, error: 'upstream_error' });
  }
};

export const config = {
  path: '/api/transactions',
  method: 'GET',
};
