import { timingSafeEqual } from 'node:crypto';
import './polyfill-storage.mjs';
import { store } from '../../js/store.js';
import {
  normalizeIngestTransactions,
  redactSensitive,
  inboxRowsToImportObjects,
} from '../../js/ingest-normalize.js';

const MAX_ROWS = 200;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
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

function sbHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

function publicStats(stats) {
  if (!stats) return null;
  return {
    parsed: stats.parsed || 0,
    imported: stats.count || 0,
    duplicates: stats.duplicates || 0,
    skipped: stats.skipped || 0,
    matchedPending: stats.matchedPending || 0,
    expense: stats.expense || 0,
    income: stats.income || 0,
    categorized: stats.categorized || 0,
    ruleApplied: stats.ruleApplied || 0,
    autoPayBills: stats.autoPayBills || 0,
  };
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

async function insertInbox(url, key, row) {
  const res = await fetch(`${url}/rest/v1/import_inbox`, {
    method: 'POST',
    headers: { ...sbHeaders(key), Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('import_inbox insert failed', res.status, detail.slice(0, 200));
    return null;
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

let storeLock = Promise.resolve();

function withStoreLock(fn) {
  const run = storeLock.then(fn, fn);
  storeLock = run.then(() => undefined, () => undefined);
  return run;
}

function applyRows(remoteState, importRows, includePending) {
  store.hydrateFromObject(remoteState);
  return store.importTransactions(importRows, { includePending, persist: false });
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const expected = env('FIGPIG_INGEST_SECRET');
  const supabaseUrl = env('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');

  if (!expected || !supabaseUrl || !serviceKey || !ownerId) {
    return json(503, { error: 'Ingest is not configured on this deploy' });
  }
  if (!secretsMatch(bearer(req), expected)) {
    return json(401, { error: 'Unauthorized' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'JSON body required' });
  }

  const txs = normalizeIngestTransactions(body.transactions || body.rows || []);
  if (!txs.length) return json(400, { error: 'No valid transactions' });
  if (txs.length > MAX_ROWS) return json(400, { error: `Max ${MAX_ROWS} transactions per drop` });

  const source = redactSensitive(body.source || 'unknown').slice(0, 80) || 'unknown';
  const account = redactSensitive(body.account || '').slice(0, 80) || null;
  const note = redactSensitive(body.note || '').slice(0, 280) || null;
  const apply = body.apply !== false;
  const includePending = body.includePending !== false;
  const importRows = inboxRowsToImportObjects(txs);

  let applied = false;
  let stats = null;
  let applyError = null;

  if (apply) {
    const result = await withStoreLock(async () => {
      let remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
      if (!remote?.state) {
        return { missing: true };
      }
      let nextStats = applyRows(remote.state, importRows, includePending);
      let saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
      if (!saved.ok) {
        remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
        if (!remote?.state) throw new Error('Budget disappeared during apply');
        nextStats = applyRows(remote.state, importRows, includePending);
        saved = await saveBudget(supabaseUrl, serviceKey, ownerId, store.getState(), remote.updated_at);
      }
      return { missing: false, saved: saved.ok, stats: nextStats };
    }).catch((err) => ({ error: err?.message || 'Apply failed' }));

    if (result.missing) {
      return json(409, {
        error: 'No FigPig budget in the cloud yet. Open FigPig once, sign in, and Sync Now. After that CoS can import via API only.',
        count: txs.length,
      });
    }
    if (result.error) {
      applyError = result.error;
      console.error('ingest-bank apply failed', applyError);
    } else if (!result.saved) {
      applyError = 'Cloud budget changed while importing; left as a pending drop';
    } else {
      applied = true;
      stats = result.stats;
    }
  }

  const inboxRow = await insertInbox(supabaseUrl, serviceKey, {
    user_id: ownerId,
    source,
    account,
    note,
    payload: { transactions: txs },
    status: applied ? 'applied' : 'pending',
    applied_at: applied ? new Date().toISOString() : null,
    apply_stats: applied ? publicStats(stats) : null,
  });

  if (!inboxRow) {
    return json(applied ? 200 : 500, {
      applied,
      count: txs.length,
      stats: publicStats(stats),
      error: applied ? undefined : 'Could not store drop',
      applyError,
    });
  }

  return json(200, {
    id: inboxRow.id,
    count: txs.length,
    source,
    applied,
    stats: publicStats(stats),
    applyError: applied ? undefined : applyError || undefined,
    created_at: inboxRow.created_at,
    next: applied
      ? 'FigPig cloud is updated. Do not open a browser. Next app launch / Sync picks it up.'
      : 'Drop stored. User must tap Import on FigPig Home, or retry after Sync Now.',
  });
};

export const config = {
  path: '/api/ingest-bank',
};
