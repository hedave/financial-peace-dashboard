import assert from 'node:assert/strict';
import handler, {
  validateSyncBody,
  publicSyncResult,
} from '../netlify/functions/transactions.mjs';

const TOKEN = 'test-tx-write-token';
process.env.FIGPIG_TX_WRITE_TOKEN = TOKEN;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.FIGPIG_OWNER_USER_ID = 'owner-test-id';

let remote = { state: null, updated_at: null };

function seedRemote(state) {
  remote = {
    state: structuredClone(state),
    updated_at: '2026-09-29T12:00:00.000Z',
  };
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  assert.match(u, /budget_states/, `unexpected fetch ${u}`);
  if (method === 'GET') {
    if (!remote.state) return jsonRes(200, []);
    return jsonRes(200, [{ state: remote.state, updated_at: remote.updated_at }]);
  }
  if (method === 'PATCH') {
    const payload = JSON.parse(opts.body);
    remote.state = payload.state;
    remote.updated_at = payload.updated_at;
    return jsonRes(200, [{ state: remote.state, updated_at: remote.updated_at }]);
  }
  return new Response('nope', { status: 405 });
};

function budgetWithManual() {
  const manual = {
    id: 'manual-1',
    date: '2026-09-01',
    amount: 42,
    type: 'expense',
    categoryId: 'env-dining-sync-test',
    description: 'Manual coffee log',
    memo: 'typed by hand',
    clearingStatus: 'cleared',
  };
  return {
    transactions: [structuredClone(manual)],
    balances: { checking: 1000, emergencyFund: 0, savings: [] },
    bills: [{
      id: 'bill-duke',
      name: 'Duke Energy',
      amount: 87.43,
      status: 'unpaid',
      autoPay: true,
      dueDate: '2026-09-20',
      recurring: true,
      categoryId: 'env-util-sync-test',
    }],
    debts: [],
    categoryRules: [
      { pattern: 'ingles', categoryId: 'env-groc-sync-test', createdAt: '2026-01-01' },
    ],
    _manual: manual,
  };
}

function assertUncategorized(tx, label) {
  assert.ok(tx, `${label}: missing row`);
  assert.equal(tx.categoryId ?? null, null, `${label}: expected no category, got ${tx.categoryId}`);
  assert.equal(tx.billId ?? null, null, `${label}: expected no bill match, got ${tx.billId}`);
  assert.equal(tx.debtId ?? null, null, `${label}: expected no debt link, got ${tx.debtId}`);
  assert.ok(!Array.isArray(tx.splits) || tx.splits.length === 0, `${label}: expected no splits`);
}

function makeReq({ token = TOKEN, header, body, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (header) Object.assign(headers, header);
  return new Request('http://localhost/api/transactions', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(opts) {
  const res = await handler(makeReq(opts));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// --- validateSyncBody unit ---
const unknownBody = validateSyncBody({
  rows: [{ date: '2026-09-29', amount: -5, description: 'x' }],
  source: 'nope',
});
assert.equal(unknownBody.status, 400);
assert.match(unknownBody.error, /Unknown field: source/);

const unknownRow = validateSyncBody({
  rows: [{ date: '2026-09-29', amount: -5, description: 'x', envelope: 'Groceries' }],
});
assert.equal(unknownRow.status, 400);
assert.match(unknownRow.error, /Unknown field: envelope/);

const counts = publicSyncResult({ duplicates: 2, matchedPending: 1, skipped: 0 }, {
  added: 3,
  checkingAfter: 12.345,
});
assert.deepEqual(counts, {
  added: 3,
  duplicates: 2,
  settledPending: 1,
  skipped: 0,
  checkingAfter: 12.35,
});

// --- 401 on bad token ---
seedRemote(budgetWithManual());
{
  const res = await call({
    token: 'wrong-token',
    body: { rows: [{ date: '2026-09-29', amount: -5.66, description: 'Chick-fil-A', pending: false }] },
  });
  assert.equal(res.status, 401, `expected 401, got ${res.status} ${res.text}`);
  assert.equal(res.json.error, 'Unauthorized');
}
console.log('401 on bad token: ok');

// --- 400 on unknown field ---
{
  const res = await call({
    body: {
      rows: [{ date: '2026-09-29', amount: -5.66, description: 'Chick-fil-A', pending: false }],
      apply: true,
    },
  });
  assert.equal(res.status, 400, `expected 400, got ${res.status} ${res.text}`);
  assert.match(res.json.error, /Unknown field: apply/);
}
{
  const res = await call({
    body: {
      rows: [{
        date: '2026-09-29',
        amount: -5.66,
        description: 'Chick-fil-A',
        pending: false,
        category: 'dad',
      }],
    },
  });
  assert.equal(res.status, 400, `expected 400 on row key, got ${res.status} ${res.text}`);
  assert.match(res.json.error, /Unknown field: category/);
}
console.log('400 on unknown field: ok');

// --- duplicate row adds nothing ---
{
  const seed = budgetWithManual();
  seedRemote(seed);
  const row = {
    date: '2026-09-28',
    amount: -12.34,
    description: 'USAA ACH TEST',
    pending: false,
    externalId: 'plaid-dup-1',
  };
  const first = await call({ body: { rows: [row] } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.added, 1, first.json);
  assert.equal(first.json.duplicates, 0);
  const checkingAfterAdd = first.json.checkingAfter;
  assert.equal(checkingAfterAdd, 987.66);

  const second = await call({ body: { rows: [row] } });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.added, 0, second.json);
  assert.equal(second.json.duplicates, 1, 're-import should count as duplicate');
  assert.equal(second.json.checkingAfter, checkingAfterAdd, 'checking must not move on duplicate');
  const copies = (remote.state.transactions || []).filter(t => t.externalId === 'plaid-dup-1');
  assert.equal(copies.length, 1, 'duplicate must not insert a second row');
  assertUncategorized(copies[0], 'duplicate-path synced row');
}
console.log('duplicate row adds nothing: ok');

// --- pending then posted settles one row ---
{
  const seed = budgetWithManual();
  seedRemote(seed);
  const pendingRow = {
    date: '2026-09-27',
    amount: -12.90,
    description: 'USPS PO 36248007',
    pending: true,
    externalId: 'plaid-settle-1',
  };
  const postedRow = {
    date: '2026-09-28',
    amount: -12.90,
    description: 'US Postal Service',
    pending: false,
    externalId: 'plaid-settle-1',
  };
  const pendingRes = await call({ body: { rows: [pendingRow] } });
  assert.equal(pendingRes.status, 200, pendingRes.text);
  assert.equal(pendingRes.json.added, 1, pendingRes.json);
  const checkingAfterPending = pendingRes.json.checkingAfter;
  assert.equal(checkingAfterPending, 987.1);

  const postedRes = await call({ body: { rows: [postedRow] } });
  assert.equal(postedRes.status, 200, postedRes.text);
  assert.equal(postedRes.json.added, 0, postedRes.json);
  assert.ok(postedRes.json.settledPending >= 1, `expected settledPending, got ${JSON.stringify(postedRes.json)}`);
  assert.equal(postedRes.json.checkingAfter, checkingAfterPending, 'posted twin must not double-hit checking');
  const twins = (remote.state.transactions || []).filter(t => t.externalId === 'plaid-settle-1');
  assert.equal(twins.length, 1, 'pending then posted must stay one row');
  assert.equal(!!twins[0].bankPending, false, 'posted settle should clear bankPending');
  assertUncategorized(twins[0], 'settled pending synced row');
}
console.log('pending-then-posted settles one row: ok');

// --- manual transaction survives the import untouched ---
{
  const seed = budgetWithManual();
  const manualSnap = structuredClone(seed._manual);
  const checkingBefore = seed.balances.checking;
  seedRemote(seed);
  const res = await call({
    body: {
      rows: [{
        date: '2026-09-26',
        amount: -8.15,
        description: 'INGLES MARKETS',
        pending: false,
        externalId: 'plaid-ingles-1',
      }],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.added, 1);
  const still = (remote.state.transactions || []).find(t => t.id === 'manual-1');
  assert.ok(still, 'manual transaction missing after import');
  assert.equal(still.date, manualSnap.date);
  assert.equal(still.amount, manualSnap.amount);
  assert.equal(still.description, manualSnap.description);
  assert.equal(still.memo, manualSnap.memo);
  assert.equal(still.clearingStatus, manualSnap.clearingStatus);
  assert.equal(still.type, manualSnap.type);
  assert.equal(still.categoryId, manualSnap.categoryId, 'manual envelope must stay');
  assert.equal(res.json.checkingAfter, checkingBefore - 8.15);
  assert.notEqual(res.json.checkingAfter, 0);
  assert.notEqual(res.json.checkingAfter, checkingBefore);
  const synced = (remote.state.transactions || []).find(t => t.externalId === 'plaid-ingles-1');
  assert.ok(synced, 'ingles synced row missing');
  assert.equal(synced.categoryId, 'env-groc-sync-test', 'ingles should get seeded merchant rule');
  assert.equal(synced.billId ?? null, null, 'ingles must not auto-match a bill');
}
console.log('manual transaction survives import: ok');

// --- merchant rule categorizes; unmatched row stays uncategorized; auto-pay unpaid ---
{
  const seed = budgetWithManual();
  seedRemote(seed);
  const res = await call({
    body: {
      rows: [
        {
          date: '2026-09-26',
          amount: -8.15,
          description: 'INGLES MARKETS',
          pending: false,
          externalId: 'plaid-ingles-rule-1',
        },
        {
          date: '2026-09-20',
          amount: -87.43,
          description: 'DUKE ENERGY',
          pending: false,
          externalId: 'plaid-duke-1',
        },
      ],
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.added, 2, res.json);
  assert.equal(res.json.checkingAfter, 904.42);
  const ingles = (remote.state.transactions || []).find(t => t.externalId === 'plaid-ingles-rule-1');
  assert.ok(ingles, 'ingles synced row missing');
  assert.equal(ingles.categoryId, 'env-groc-sync-test', 'matching merchant rule should set category');
  assert.equal(ingles.billId ?? null, null);
  const duke = (remote.state.transactions || []).find(t => t.externalId === 'plaid-duke-1');
  assertUncategorized(duke, 'duke energy synced row with no rule');
  const bill = (remote.state.bills || []).find(b => b.id === 'bill-duke');
  assert.ok(bill, 'Duke Energy bill missing after sync');
  assert.equal(bill.status, 'unpaid', 'auto-pay bill must stay unpaid');
  assert.equal(bill.paidDate ?? null, null);
}
console.log('merchant rule categorizes; unmatched stays uncategorized; auto-pay unpaid: ok');

globalThis.fetch = origFetch;
console.log('test-transactions-api: ok');
