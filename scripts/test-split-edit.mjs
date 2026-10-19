/**
 * Split edit (PATCH /api/transactions/:id/split) + GET /api/envelopes. FAKE DATA ONLY.
 * Mocks Supabase (budget_states) with a local fetch stub; any other URL fails the run.
 */
import assert from 'node:assert/strict';
import handler, { _resetRateLimit, secretsMatch } from '../netlify/functions/transactions-split-edit.mjs';
import envHandler, { _resetRateLimit as _resetEnvRL } from '../netlify/functions/envelopes.mjs';
import { createDefaultState } from '../js/defaults.js';
import { store } from '../js/store.js';
import { validateEditBody, listEnvelopes } from '../js/split-edit.js';

const TOKEN = 'fake-split-write-token-0123456789';
const READ = 'fake-read-token-0123456789abcdef';
const ENV = {
  FIGPIG_SPLIT_WRITE_TOKEN: TOKEN,
  FIGPIG_BILLS_READ_TOKEN: READ,
  SUPABASE_URL: 'https://fake-project.example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  FIGPIG_OWNER_USER_ID: 'fake-owner',
};
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
// Make sure a sibling token never unlocks this endpoint
process.env.FIGPIG_TX_SPLIT_TOKEN = 'fake-other-token-0123456789abcdef';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { _resetRateLimit(); _resetEnvRL(); await fn(); passed++; } catch (err) { failures.push(name); console.error(`FAIL ${name}\n`, err); }
}

let remote = { state: null, updated_at: null };
let patches = 0;
let stray = [];
let hooks = [];
let getHook = null;
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith(ENV.SUPABASE_URL) || !/budget_states/.test(u)) { stray.push(u); throw new Error(`stray fetch ${u}`); }
  const method = String(opts.method || 'GET').toUpperCase();
  if (method === 'GET') {
    if (getHook) { const r = getHook(); if (r) return r; }
    return jsonRes(200, remote.state ? [{ state: structuredClone(remote.state), updated_at: remote.updated_at }] : []);
  }
  if (method === 'PATCH') {
    patches++;
    const h = hooks.shift();
    const out = h ? h() : false;
    if (out instanceof Response) return out;
    if (out) return jsonRes(200, []);
    const m = u.match(/updated_at=eq\.([^&]+)/);
    if (m && decodeURIComponent(m[1]) !== remote.updated_at) return jsonRes(200, []);
    const payload = JSON.parse(opts.body);
    remote = { state: payload.state, updated_at: payload.updated_at };
    return jsonRes(200, [{ updated_at: remote.updated_at }]);
  }
  return new Response('nope', { status: 405 });
};

const base = createDefaultState();
const catId = n => base.categories.find(c => c.name === n).id;
const GROC = catId('Groceries');
const HOUSE = catId('Household / Misc');
const CLOTH = base.categories.find(c => /cloth/i.test(c.name))?.id || (() => {
  const c = { ...base.categories[0], id: 'fake-cloth', name: 'Clothing' }; base.categories.push(c); return c.id;
})();
const CLOTH_NAME = base.categories.find(c => c.id === CLOTH).name;

const SAMS = () => ({
  id: 'fake66a1', date: '2026-10-13', amount: 181.83, type: 'expense', description: 'SAMS CLUB #0000 FAKETOWN',
  categoryId: null, clearingStatus: 'cleared', receiptId: 'rcpt-fake', categorySource: 'receipt',
  splits: [{ categoryId: GROC, amount: 136.88 }, { categoryId: HOUSE, amount: 44.95 }],
});
const OTHER = () => ({ id: 'fake-other', date: '2026-10-12', amount: 20, type: 'expense', description: 'FAKE CAFE', categoryId: GROC, clearingStatus: 'cleared' });
function seed(txs = [SAMS(), OTHER()]) {
  const s = structuredClone(base);
  s.setupComplete = true;
  s.balances.checking = 1000;
  s.transactions = txs;
  remote = { state: s, updated_at: '2026-10-16T12:00:00.000Z' };
  patches = 0; hooks = []; getHook = null;
}
const rtx = id => remote.state.transactions.find(t => t.id === id);

const EXPECTED = [{ envelope: 'Groceries', amount: 136.88 }, { envelope: 'Household / Misc', amount: 44.95 }];
const NEW = () => [{ envelope: CLOTH_NAME, amount: 26.71 }, { envelope: 'Household / Misc', amount: 19.77 }, { envelope: 'Groceries', amount: 135.35 }];
const body = (o = {}) => ({ expected: EXPECTED, split: NEW(), note: 'Fake fix', ...o });

async function call(b, { token = TOKEN, id = 'fake66a1', method = 'PATCH', headers = {}, raw } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await handler(new Request(`http://localhost/api/transactions/${encodeURIComponent(id)}/split`, {
    method, headers: h, body: method === 'PATCH' ? (raw ?? JSON.stringify(b)) : undefined,
  }), { params: { id } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function getEnv(token = READ) {
  const h = token ? { authorization: `Bearer ${token}` } : {};
  const res = await envHandler(new Request('http://localhost/api/envelopes', { headers: h }));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// --- auth / config ---
await test('503 when FIGPIG_SPLIT_WRITE_TOKEN unset or < 24 chars', async () => {
  seed();
  delete process.env.FIGPIG_SPLIT_WRITE_TOKEN;
  assert.equal((await call(body())).status, 503);
  process.env.FIGPIG_SPLIT_WRITE_TOKEN = 'short-token-123';
  assert.equal((await call(body(), { token: 'short-token-123' })).status, 503);
  process.env.FIGPIG_SPLIT_WRITE_TOKEN = TOKEN;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal((await call(body())).status, 503);
  process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal(patches, 0);
});
await test('401 on missing / wrong / sibling token; alt header works', async () => {
  seed();
  for (const t of ['', 'wrong', TOKEN.slice(0, -1), TOKEN + 'x', process.env.FIGPIG_TX_SPLIT_TOKEN, READ]) {
    assert.equal((await call(body(), { token: t })).status, 401, `token ${t}`);
  }
  assert.equal(patches, 0);
  assert.equal(secretsMatch(TOKEN, TOKEN), true);
  const alt = await call(body(), { token: '', headers: { 'x-figpig-split-write-token': TOKEN } });
  assert.equal(alt.status, 200, alt.text);
});
await test('rate limit: 11th write in a minute → 429 (counted before auth)', async () => {
  seed();
  let last;
  for (let i = 0; i < 11; i++) last = await call(body(), { token: 'wrong' });
  assert.equal(last.status, 429);
});
await test('405 / 415 / 400 bad JSON / 413 / bad id', async () => {
  seed();
  assert.equal((await call(null, { method: 'POST', raw: '{}' })).status, 405);
  assert.equal((await call(body(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(null, { raw: '{nope' })).status, 400);
  assert.equal((await call(null, { raw: JSON.stringify({ note: 'x'.repeat(20000) }) })).status, 413);
  assert.equal((await call(body(), { id: 'bad id<script>' })).status, 400);
  assert.equal(patches, 0);
});
await test('strict validation: unknown keys, line counts, amounts, note', async () => {
  const L = (n, a = 1) => Array.from({ length: n }, (_, i) => ({ envelope: `E${i}`, amount: a }));
  const bad = [
    { ...body(), extra: 1 },
    body({ split: [] }),
    body({ split: L(11) }),
    body({ split: [{ envelope: 'Groceries', amount: 0 }] }),
    body({ split: [{ envelope: 'Groceries', amount: -5 }] }),
    body({ split: [{ envelope: 'Groceries', amount: 1e6 + 1 }] }),
    body({ split: [{ envelope: 'Groceries', amount: 1.005 }] }),
    body({ split: [{ envelope: 'Groceries', amount: '5' }] }),
    body({ split: [{ envelope: 'Groceries', amount: 5, categoryId: GROC }] }),
    body({ expected: undefined }),
    body({ note: 'x'.repeat(201) }),
    body({ note: 5 }),
    [],
  ];
  for (const b of bad) assert.equal(validateEditBody(b).ok, false, JSON.stringify(b).slice(0, 100));
  seed();
  const r = await call({ ...body(), amount: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_body');
  assert.equal(patches, 0);
});

// --- CAS / sums / envelopes ---
await test('409 stale expected returns the current split, no write', async () => {
  seed();
  const r = await call(body({ expected: [{ envelope: 'Groceries', amount: 100 }, { envelope: 'Household / Misc', amount: 81.83 }] }));
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'stale_expected');
  assert.deepEqual(r.json.current, EXPECTED);
  assert.equal(patches, 0);
});
await test('400 when split does not add up to the transaction total (to the cent)', async () => {
  seed();
  const r = await call(body({ split: [{ envelope: 'Groceries', amount: 136.87 }, { envelope: 'Household / Misc', amount: 44.95 }] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'sum_mismatch');
  assert.equal(r.json.transactionAmount, 181.83);
  assert.equal(r.json.splitTotal, 181.82);
  assert.equal(patches, 0);
});
await test('400 on unknown envelope, lists valid names, never creates one', async () => {
  seed();
  const nCats = remote.state.categories.length;
  const r = await call(body({ split: [{ envelope: 'Totally New Envelope', amount: 100 }, { envelope: 'Groceries', amount: 81.83 }] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'unknown_envelope');
  assert.equal(r.json.envelope, 'Totally New Envelope');
  assert.ok(r.json.validEnvelopes.includes('Groceries'));
  assert.equal(remote.state.categories.length, nCats);
  assert.equal(patches, 0);
});
await test('404 unknown tx; 409 not_split on an unsplit row; duplicate envelope 400', async () => {
  seed();
  assert.equal((await call(body(), { id: 'nope' })).status, 404);
  const ns = await call(body(), { id: 'fake-other' });
  assert.equal(ns.status, 409);
  assert.equal(ns.json.error, 'not_split');
  const dup = await call(body({ split: [{ envelope: 'Groceries', amount: 100 }, { envelope: 'groceries', amount: 81.83 }] }));
  assert.equal(dup.status, 400);
  assert.equal(patches, 0);
});

// --- happy path ---
await test('happy path: edits in place, amount/checking untouched, audit written, trimmed response', async () => {
  seed();
  const before = structuredClone(remote.state);
  const r = await call(body());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['before', 'ok', 'split', 'status', 'transaction']);
  assert.equal(r.json.status, 'updated');
  assert.deepEqual(r.json.transaction, { id: 'fake66a1', date: '2026-10-13', amount: 181.83, description: 'SAMS CLUB #0000 FAKETOWN' });
  assert.deepEqual(r.json.before, EXPECTED);
  assert.deepEqual(r.json.split, NEW());
  assert.ok(!/checking|balances|service|categoryId|splitEditAudit|receiptId/i.test(r.text), 'trimmed');
  const t = rtx('fake66a1');
  assert.deepEqual(t.splits, [{ categoryId: CLOTH, amount: 26.71 }, { categoryId: HOUSE, amount: 19.77 }, { categoryId: GROC, amount: 135.35 }]);
  assert.equal(t.amount, 181.83);
  assert.equal(t.categoryId, null);
  assert.equal(remote.state.transactions.length, before.transactions.length, 'no new rows');
  assert.equal(remote.state.balances.checking, 1000, 'checking unchanged');
  const catKey = cs => cs.map(c => [c.id, c.name, c.monthlyBudget, c.carryOver, c.parentId || null].join('|'));
  assert.deepEqual(catKey(remote.state.categories), catKey(before.categories), 'envelopes not created/changed');
  assert.deepEqual(remote.state.debts, before.debts, 'snowball untouched');
  assert.deepEqual(rtx('fake-other'), before.transactions[1]);
  const a = remote.state.splitEditAudit;
  assert.equal(a.length, 1);
  assert.equal(a[0].actor, 'CoS');
  assert.equal(a[0].txId, 'fake66a1');
  assert.equal(a[0].note, 'Fake fix');
  assert.match(a[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(a[0].before, [{ categoryId: GROC, amount: 136.88 }, { categoryId: HOUSE, amount: 44.95 }]);
  assert.equal(a[0].after.length, 3);
  assert.equal(patches, 1);
  // replay with the old expected is now stale
  const again = await call(body());
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'stale_expected');
  // audit survives a store hydrate (the UI load path)
  store.hydrateFromObject(structuredClone(remote.state));
  assert.equal(store.getState().splitEditAudit.length, 1);
});
await test('expected matches regardless of line order / name case; same split → unchanged, no write', async () => {
  seed();
  const r = await call(body({ expected: [{ envelope: 'household / misc', amount: 44.95 }, { envelope: 'GROCERIES', amount: 136.88 }], split: EXPECTED }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'unchanged');
  assert.equal(patches, 0);
});

// --- concurrency / upstream ---
await test('updated_at conflict → reload, re-check CAS, retry once', async () => {
  seed();
  hooks = [() => { remote.state.transactions.push({ ...OTHER(), id: 'fake-new' }); remote.updated_at = '2026-10-16T12:00:05.000Z'; return true; }];
  const r = await call(body());
  assert.equal(r.status, 200, r.text);
  assert.equal(patches, 2);
  assert.ok(rtx('fake-new'));
  assert.equal(rtx('fake66a1').splits.length, 3);
});
await test('conflict where the other writer changed the split → 409 stale_expected', async () => {
  seed();
  hooks = [() => { rtx('fake66a1').splits = [{ categoryId: GROC, amount: 100 }, { categoryId: HOUSE, amount: 81.83 }]; remote.updated_at = 'x2'; return true; }];
  const r = await call(body());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'stale_expected');
  assert.equal(patches, 1);
});
await test('two conflicts → 409 conflict', async () => {
  seed();
  hooks = [() => true, () => true];
  const r = await call(body());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'conflict');
});
await test('Supabase 5xx on save / load and 4xx → 502 upstream_error, not a conflict', async () => {
  seed();
  hooks = [() => jsonRes(503, { message: 'fake outage' })];
  let r = await call(body());
  assert.equal(r.status, 502); assert.equal(r.json.error, 'upstream_error');
  assert.equal(rtx('fake66a1').splits.length, 2);
  seed();
  hooks = [() => true, () => jsonRes(500, {})];
  r = await call(body());
  assert.equal(r.status, 502);
  seed();
  getHook = () => jsonRes(503, {});
  r = await call(body());
  assert.equal(r.status, 502);
  seed();
  hooks = [() => jsonRes(400, {})];
  assert.equal((await call(body())).status, 502);
  assert.ok(!/fake outage|service/i.test(r.text));
});
await test('409 no_budget when the cloud row is missing', async () => {
  remote = { state: null, updated_at: null }; getHook = null;
  const r = await call(body());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'no_budget');
});

// --- GET /api/envelopes ---
await test('envelopes: 503 unset, 401 bad token, 405 non-GET', async () => {
  seed();
  delete process.env.FIGPIG_BILLS_READ_TOKEN;
  assert.equal((await getEnv()).status, 503);
  process.env.FIGPIG_BILLS_READ_TOKEN = READ;
  assert.equal((await getEnv('wrong')).status, 401);
  assert.equal((await getEnv(TOKEN)).status, 401, 'write token is not a read token');
  const res = await envHandler(new Request('http://localhost/api/envelopes', { method: 'POST', headers: { authorization: `Bearer ${READ}` } }));
  assert.equal(res.status, 405);
});
await test('envelopes: trimmed list (id, name, group?, sinkingFund?, balances), no notes/plan internals', async () => {
  seed();
  remote.state.categories.push({ ...remote.state.categories[0], id: 'fake-sub', name: 'Fake Sub', parentId: GROC, monthlyBudget: 99, note: 'secret note' });
  const r = await getEnv();
  assert.equal(r.status, 200, r.text);
  // Balances added by the envelope reset API (see scripts/test-envelope-reset.mjs).
  assert.deepEqual(Object.keys(r.json).sort(), ['checking_balance', 'envelopes', 'month', 'newest_transaction_date', 'ok', 'state_hash', 'total_allocated', 'unallocated']);
  for (const e of r.json.envelopes) {
    for (const k of Object.keys(e)) assert.ok(['id', 'name', 'group', 'sinkingFund', 'allocated', 'spent', 'remaining', 'bill_id'].includes(k), k);
  }
  assert.ok(r.json.envelopes.some(e => e.name === 'Groceries' && e.id === GROC));
  const sub = r.json.envelopes.find(e => e.id === 'fake-sub');
  assert.deepEqual({ id: sub.id, name: sub.name, group: sub.group }, { id: 'fake-sub', name: 'Fake Sub', group: 'Groceries' });
  assert.ok(!/monthlyBudget|carryOver|secret note|SAMS CLUB|FAKE CAFE/i.test(r.text));
  assert.equal(patches, 0);
  assert.equal(listEnvelopes(null).length, 0);
});
await test('envelopes: Supabase 5xx → 502', async () => {
  seed();
  getHook = () => jsonRes(500, {});
  assert.equal((await getEnv()).status, 502);
});

assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`split-edit: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
