import { timingSafeEqual } from 'node:crypto';

/**
 * Read-only GET /api/bills for CoS bill-watch.
 * Auth: Authorization: Bearer <FIGPIG_BILLS_READ_TOKEN>
 * (alternate header: x-figpig-bills-token)
 * Never reuses FIGPIG_INGEST_SECRET.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map(); // best-effort per instance

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
    req.headers.get('x-figpig-bills-token') ||
    req.headers.get('X-Figpig-Bills-Token') ||
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

/** Trim one bill for CoS — no categoryId, notes, or other budget fields. */
export function trimBill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    name: String(raw.name || '').slice(0, 200),
    amount: Number(raw.amount) || 0,
    dueDate: raw.dueDate ? String(raw.dueDate).slice(0, 32) : null,
    status: raw.status === 'paid' ? 'paid' : 'unpaid',
    paidDate: raw.paidDate ? String(raw.paidDate).slice(0, 32) : null,
    recurring: raw.recurring !== false,
  };
  if (raw.id != null && String(raw.id).length) {
    out.id = String(raw.id).slice(0, 80);
  }
  return out;
}

export function trimBills(list) {
  if (!Array.isArray(list)) return [];
  return list.map(trimBill).filter(Boolean);
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

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-figpig-bills-token',
        'access-control-max-age': '86400',
      },
    });
  }
  if (req.method !== 'GET') return json(405, { error: 'GET only' });

  const expected = env('FIGPIG_BILLS_READ_TOKEN');
  const supabaseUrl = env('SUPABASE_URL')?.replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const ownerId = env('FIGPIG_OWNER_USER_ID');

  if (!expected || !supabaseUrl || !serviceKey || !ownerId) {
    return json(503, { error: 'Bills read API is not configured on this deploy' });
  }

  if (!secretsMatch(providedToken(req), expected)) {
    return json(401, { error: 'Unauthorized' });
  }

  if (!rateLimitOk(clientKey(req))) {
    return json(429, { error: 'Too many requests' });
  }

  let remote;
  try {
    remote = await loadBudget(supabaseUrl, serviceKey, ownerId);
  } catch (err) {
    console.error('bills load failed', err?.message || err);
    return json(502, { error: 'Could not load bills' });
  }

  if (!remote?.state) {
    return json(409, {
      error: 'No FigPig budget in the cloud yet. Open FigPig once, sign in, and Sync Now.',
    });
  }

  const bills = trimBills(remote.state.bills);
  return json(200, {
    bills,
    count: bills.length,
    updated_at: remote.updated_at || null,
  });
};

export const config = {
  path: '/api/bills',
};
