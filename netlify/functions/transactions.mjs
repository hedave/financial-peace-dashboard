import { timingSafeEqual } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import {
  normalizeIngestTransactions,
  inboxRowsToImportObjects,
} from '../../js/ingest-normalize.js';

/**
 * Add-only POST /api/transactions for CoS / finance-connector sync.
 * Auth: Authorization: Bearer <FIGPIG_TX_WRITE_TOKEN>
 * (alternate header: x-figpig-tx-write-token)
 * Never reuses FIGPIG_INGEST_SECRET or FIGPIG_BILLS_READ_TOKEN.
 * Applies rows through store.importTransactions (dedupe, pending settle, checking,
 * merchant category rules). Bill auto-match, auto-pay, and envelope assignment stay off.
 */

const MAX_ROWS = 200;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const hits = new Map(); // best-effort per instance

const BODY_KEYS = new Set(['rows']);
const ROW_KEYS = new Set(['date', 'amount', 'description', 'pending', 'externalId']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
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

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(req) {
  const h = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function providedToken(req) {
  const fromBearer = bearer(req);
  if (fromBearer) return fromBearer;
  const alt =
    req.headers.get('x-figpig-tx-write-token') ||
    req.headers.get('X-Figpig-Tx-Write-Token') ||
    '';
  return String(alt).trim();
}

function clientKey(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
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
  return bucket.count <= MAX_PER_WINDOW;
}

function sbHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

function money2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function publicSyncResult(stats, { added, checkingAfter }) {
  return {
    added: Number(added) || 0,
    duplicates: Number(stats?.duplicates) || 0,
    settledPending: Number(stats?.matchedPending) || 0,
    skipped: Number(stats?.skipped) || 0,
    checkingAfter: money2(checkingAfter),
  };
}

/**
 * Strict body check. Rejects unknown keys on the object and on each row.
 * @returns {{ status: number, error: string } | { rows: object[] }}
 */
export function validateSyncBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: 'JSON object required' };
  }
  const extra = unknownKeys(body, BODY_KEYS);
  if (extra.length) {
    return { status: 400, error: `Unknown field: ${extra[0]}` };
  }
  if (!Array.isArray(body.rows)) {
    return { status: 400, error: 'rows must be an array' };
  }
  if (!body.rows.length) {
    return { status: 400, error: 'rows must not be empty' };
  }
  if (body.rows.length > MAX_ROWS) {
    return { status: 400, error: `Max ${MAX_ROWS} rows per call` };
  }

  for (let i = 0; i < body.rows.length; i++) {
    const row = body.rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { status: 400, error: `rows[${i}] must be an object` };
    }
    const unknown = unknownKeys(row, ROW_KEYS);
    if (unknown.length) {
      return { status: 400, error: `Unknown field: ${unknown[0]}` };
    }

    if (typeof row.date !== 'string' || !ISO_DATE.test(row.date.trim())) {
      return { status: 400, error: `rows[${i}].date must be YYYY-MM-DD` };
    }
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount === 0) {
      return { status: 400, error: `rows[${i}].amount must be a non-zero number` };
    }
    if (typeof row.description !== 'string' || !row.description.trim()) {
      return { status: 400, error: `rows[${i}].description must be a non-empty string` };
    }
    if ('pending' in row && typeof row.pending !== 'boolean') {
      return { status: 400, error: `rows[${i}].pending must be a boolean` };
    }
    if ('externalId' in row) {
      if (typeof row.externalId !== 'string' || !row.externalId.trim()) {
        return { status: 400, error: `rows[${i}].externalId must be a non-empty string` };
      }
      if (row.externalId.length > 128) {
        return { status: 400, error: `rows[${i}].externalId is too long` };
      }
    }
  }

  return { rows: body.rows };
}

async function loadBudget(url, key, ownerId) {
  const res = await fetch(
    `${url}/rest/v1/budget_states?user_id=eq.${encodeURIComponent(ownerId)}&select=state,updated_at`,
    { headers: sbHeaders(key) },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Load budget failed (${res.status}): ${detail.slice(0, 180)}`);
  }
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
  const body = await res.json().catch(() => []);
  const rows = Array.isArray(body) ? body : [];
  return { ok: res.ok && rows.length > 0, stamp, rows };
}

let storeLock = Promise.resolve();

function withStoreLock(fn) {
  const run = storeLock.then(fn, fn);
  storeLock = run.then(() => undefined, () => undefined);
  return run;
}

function applyRows(remoteState, importRows) {
  store.hydrateFromObject(remoteState);
  const beforeCount = Array.isArray(store.getState().transactions)
    ? store.getState().transactions.length
    : 0;
  const stats = store.importTransactions(importRows, {
    includePending: true,
    persist: false,
    bankSync: true,
  });
  const after = store.getState();
  const afterCount = Array.isArray(after.transactions) ? after.transactions.length : 0;
  return {
    stats,
    added: Math.max(0, afterCount - beforeCount),
    checkingAfter: after.balances?.checking,
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-figpig-tx-write-token',
        'access-control-max-age': '86400',
      },
    });
  }
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const expected = env('FIGPIG_TX_WRITE_TOKEN');
  const supabaseUrl = env('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');

  if (!expected || !supabaseUrl || !serviceKey || !ownerId) {
    return json(503, { error: 'Transaction write API is not configured on this deploy' });
  }

  if (!secretsMatch(providedToken(req), expected)) {
    return json(401, { error: 'Unauthorized' });
  }

  if (!rateLimitOk(clientKey(req))) {
    return json(429, { error: 'Too many requests' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'JSON body required' });
  }

  const checked = validateSyncBody(body);
  if (checked.error) return json(checked.status, { error: checked.error });

  const txs = normalizeIngestTransactions(checked.rows);
  if (!txs.length) return json(400, { error: 'No valid transactions' });
  const importRows = inboxRowsToImportObjects(txs);

  const result = await withStoreLock(async () => {
    let remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
    if (!remote?.state) {
      return { missing: true };
    }
    let applied = applyRows(remote.state, importRows);
    let saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
    if (!saved.ok) {
      remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
      if (!remote?.state) throw new Error('Budget disappeared during apply');
      applied = applyRows(remote.state, importRows);
      saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
    }
    return { missing: false, saved: saved.ok, ...applied };
  }).catch((err) => ({ error: err?.message || 'Apply failed' }));

  if (result.missing) {
    return json(409, {
      error: 'No FigPig budget in the cloud yet. Open FigPig once, sign in, and Sync Now.',
    });
  }
  if (result.error) {
    console.error('transactions apply failed', result.error);
    return json(502, { error: 'Could not apply transactions' });
  }
  if (!result.saved) {
    return json(409, { error: 'Cloud budget changed while importing; retry' });
  }

  return json(200, publicSyncResult(result.stats, {
    added: result.added,
    checkingAfter: result.checkingAfter,
  }));
};

export const config = {
  path: '/api/transactions',
};
