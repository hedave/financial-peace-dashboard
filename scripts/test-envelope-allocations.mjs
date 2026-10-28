/**
 * POST /api/envelopes/allocations (replace mode). FAKE DATA ONLY.
 * Mocks Supabase (budget_states) with a local fetch stub; any other URL fails the run.
 */
import assert from 'node:assert/strict';
import writeHandler, { _resetRateLimit, secretsMatch } from '../netlify/functions/envelopes-write.mjs';
import readHandler, { _resetRateLimit as _resetReadRL } from '../netlify/functions/envelopes.mjs';
import { createDefaultState } from '../js/defaults.js';
import { getCurrentMonth, getPreviousMonth } from '../js/utils.js';
import { validateStartFreshBody, validateCarryResetBody } from '../js/envelope-reset.js';

const TOKEN = 'fake-envelope-write-token-0123456789';
const READ = 'fake-read-token-0123456789abcdef';
const SPLIT = 'fake-split-write-token-0123456789';
const ENV = {
  FIGPIG_ENVELOPE_WRITE_TOKEN: TOKEN,
  FIGPIG_BILLS_READ_TOKEN: READ,
  FIGPIG_SPLIT_WRITE_TOKEN: SPLIT,
  SUPABASE_URL: 'https://fake-project.example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  FIGPIG_OWNER_USER_ID: 'fake-owner',
};
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { _resetRateLimit(); _resetReadRL(); await fn(); passed++; console.log(`ok   ${name}`); } catch (err) { failures.push(name); console.error(`FAIL ${name}\n`, err); }
}

let remote = { state: null, updated_at: null };
let patches = 0;
let patchBodies = [];
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
    const out = h ? h() : null;
    if (out instanceof Response) return out;
    const m = u.match(/updated_at=eq\.([^&]+)/);
    if (m && decodeURIComponent(m[1]) !== remote.updated_at) return jsonRes(200, []);
    const payload = JSON.parse(opts.body);
    patchBodies.push(structuredClone(payload.state));
    remote = { state: payload.state, updated_at: payload.updated_at };
    return jsonRes(200, [{ updated_at: remote.updated_at }]);
  }
  return new Response('nope', { status: 405 });
};

const YM = getCurrentMonth();
const base = createDefaultState();
const id = n => base.categories.find(c => c.name === n).id;
const MORT = id('Mortgage');
const GROC = id('Groceries');
const EAT = id('Eating Out / Fast Food');
const UTIL = id('Utilities');
const XMAS = id('Christmas');

function seed() {
  const s = structuredClone(base);
  s.setupComplete = true;
  s.lastMonthProcessed = YM;
  s.balances.checking = 4000;
  const budgets = { [MORT]: 3219.49, [GROC]: 1400, [EAT]: 600, [UTIL]: 260, [XMAS]: 500 };
  s.categories.forEach(c => { c.monthlyBudget = budgets[c.id] || 0; });
  s.categories.find(c => c.id === EAT).carryOver = -45.5;
  s.categories.find(c => c.id === GROC).note = 'secret fake envelope note';
  s.categories.push({ ...s.categories.find(c => c.id === GROC), id: 'fake-sub', name: 'Fake Sub', parentId: GROC, monthlyBudget: 99, carryOver: 0, note: '' });
  s.bills = [
    { id: 'fake-bill-mort', name: 'Fake Mortgage Co', amount: 3219.49, dueDate: `${YM}-28`, status: 'pending', recurring: true, categoryId: MORT },
    { id: 'fake-bill-power', name: 'Fake Power', amount: 140, dueDate: `${YM}-25`, status: 'pending', recurring: true, categoryId: UTIL },
  ];
  s.debts = [{ id: 'fake-debt', name: 'Fake Card', balance: 1200, interestRate: 19.9, minPayment: 45, archived: false }];
  s.transactions = [
    { id: 'fake-t1', date: `${YM}-02`, amount: 212.44, type: 'expense', description: 'FAKE GROCER', categoryId: GROC, clearingStatus: 'cleared' },
    { id: 'fake-t2', date: `${YM}-04`, amount: 80, type: 'expense', description: 'FAKE PIZZA', categoryId: EAT, clearingStatus: 'cleared' },
    { id: 'fake-t3', date: `${getPreviousMonth(YM)}-27`, amount: 30, type: 'expense', description: 'FAKE OLD', categoryId: GROC, clearingStatus: 'cleared' },
    { id: 'fake-t4', date: `${YM}-03`, amount: 2600, type: 'income', description: 'FAKE PAY', categoryId: null, clearingStatus: 'cleared' },
  ];
  remote = { state: s, updated_at: '2026-10-18T12:00:00.000Z' };
  patches = 0; patchBodies = []; hooks = []; getHook = null;
}
const rcat = cid => remote.state.categories.find(c => c.id === cid);

async function req(handler, path, { method = 'GET', token, headers = {}, body, raw, params } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (method === 'POST' && !('content-type' in h)) h['content-type'] = 'application/json';
  const res = await handler(new Request(`http://localhost${path}`, {
    method, headers: h, body: method === 'POST' ? (raw ?? JSON.stringify(body ?? {})) : undefined,
  }), { params: params || {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const getBal = (token = READ) => req(readHandler, '/api/envelopes', { token });
const getSnaps = (token = READ) => req(readHandler, '/api/envelopes/snapshots', { token });
const reset = (body, o = {}) => req(writeHandler, '/api/envelopes/reset', { method: 'POST', token: TOKEN, body, ...o });
const snapshot = (body = {}, o = {}) => req(writeHandler, '/api/envelopes/snapshot', { method: 'POST', token: TOKEN, body, ...o });
const restore = (sid, body, o = {}) => req(writeHandler, `/api/envelopes/snapshots/${sid}/restore`, { method: 'POST', token: TOKEN, body, params: { id: sid }, ...o });
async function hashNow() { const r = await getBal(); assert.equal(r.status, 200, r.text); return r.json.state_hash; }
const alloc = (body, o = {}) => req(writeHandler, '/api/envelopes/allocations', { method: 'POST', token: TOKEN, body, ...o });
const good = (h, extra = {}) => ({ month: YM, expected_state_hash: h, mode: 'replace', allocations: [{ envelope: 'Mortgage', amount: 3219.49 }, { envelope: 'groceries', amount: 600 }], ...extra });

await test('auth: 503 unset, 401 missing/wrong/read token, 405 GET', async () => {
  seed();
  delete process.env.FIGPIG_ENVELOPE_WRITE_TOKEN;
  assert.equal((await alloc({})).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = TOKEN;
  for (const t of [undefined, 'wrong-token-wrong-token-wrong', READ, SPLIT]) assert.equal((await alloc({}, { token: t })).status, 401);
  assert.equal((await req(writeHandler, '/api/envelopes/allocations', { token: TOKEN })).status, 405);
  assert.equal(patches, 0);
});

await test('validation: bad bodies → 400, nothing written', async () => {
  seed();
  const h = await hashNow();
  const bads = [
    [], 'x', { ...good(h), extra: 1 }, { ...good(h), month: '2026-13' }, { ...good(h), month: 202611 },
    { ...good(h), mode: 'merge' }, { ...good(h), mode: undefined }, { ...good(h), expected_state_hash: 'abc' },
    { ...good(h), dry_run: 'false' }, { ...good(h), allocations: 'all' },
    { ...good(h), allocations: [{ envelope: '', amount: 1 }] },
    { ...good(h), allocations: [{ envelope: 'Mortgage', amount: 1, x: 1 }] },
    { ...good(h), allocations: [{ envelope: 'Mortgage', amount: 1 }, { envelope: 'MORTGAGE', amount: 2 }] },
    { ...good(h), allocations: Array.from({ length: 101 }, (_, i) => ({ envelope: `e${i}`, amount: 1 })) },
  ];
  for (const b of bads) { _resetRateLimit(); const r = await alloc(b); assert.equal(r.status, 400, JSON.stringify(b) + r.text); }
  for (const amt of [-1, 1.234, '10', null, 1e7, NaN]) {
    _resetRateLimit();
    const r = await alloc({ ...good(h), allocations: [{ envelope: 'Mortgage', amount: amt }] });
    assert.equal(r.status, 422, String(amt) + r.text); assert.equal(r.json.error, 'bad_amount');
  }
  _resetRateLimit();
  assert.equal((await alloc({ ...good(h), mode: 'set', allocations: [] })).status, 400, 'set needs a list');
  assert.equal((await alloc(good(h), { raw: '{not json' })).status, 400);
  assert.equal((await alloc(good(h), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(patches, 0);
});

await test('409 stale hash; 409 month mismatch; 422 unknown envelope; 422 over checking; nothing written', async () => {
  seed();
  const h = await hashNow();
  let r = await alloc(good('0'.repeat(64), { dry_run: false }));
  assert.equal(r.status, 409); assert.equal(r.json.error, 'stale_state');
  r = await alloc(good(h, { month: getPreviousMonth(YM), dry_run: false }));
  assert.equal(r.status, 409); assert.equal(r.json.error, 'month_mismatch');
  r = await alloc(good(h, { allocations: [{ envelope: 'Nope Fake', amount: 1 }], dry_run: false }));
  assert.equal(r.status, 422); assert.equal(r.json.error, 'unknown_envelope'); assert.deepEqual(r.json.envelopes, ['Nope Fake']);
  r = await alloc(good(h, { allocations: [{ envelope: 'Mortgage', amount: 4000.01 }], dry_run: false }));
  assert.equal(r.status, 422); assert.equal(r.json.error, 'over_checking'); assert.equal(r.json.checking_balance, 4000);
  r = await alloc(good(h, { allocations: [{ envelope: 'Mortgage', amount: 4000.01 }] }));
  assert.equal(r.status, 422, 'dry run also rejects over checking');
  r = await alloc(good(h, { allocations: [{ envelope: 'Mortgage', amount: 4000 }] }));
  assert.equal(r.status, 200, 'exactly checking is allowed'); assert.equal(r.json.totals.unallocated_after, 0);
  remote.state.lastMonthProcessed = getPreviousMonth(YM);
  r = await alloc(good(await hashNow(), { dry_run: false }));
  assert.equal(r.status, 409); assert.equal(r.json.error, 'month_not_rolled_over');
  assert.equal(patches, 0);
});

await test('dry run (default) persists nothing and returns the diff', async () => {
  seed();
  const h = await hashNow();
  const before = JSON.stringify(remote.state);
  const r = await alloc(good(h));
  assert.equal(r.status, 200, r.text); assert.equal(r.json.dry_run, true);
  assert.equal(r.json.totals.total_allocated_after, 3819.49);
  assert.equal(r.json.totals.unallocated_after, 180.51);
  assert.equal(patches, 0); assert.equal(JSON.stringify(remote.state), before);
});

await test('real run: snapshot first, replace sets listed + zeroes unlisted top-level, subs/carry untouched; idempotent; restore undoes', async () => {
  seed();
  const h0 = await hashNow();
  const r = await alloc(good(h0, { dry_run: false, note: 'fake nov plan' }));
  assert.equal(r.status, 200, r.text);
  assert.equal(patchBodies[0].envelopeSnapshots.at(-1).reason, 'pre_allocations');
  assert.equal(rcat(MORT).monthlyBudget, 3219.49); assert.equal(rcat(GROC).monthlyBudget, 600);
  assert.equal(rcat(EAT).monthlyBudget, 0); assert.equal(rcat(XMAS).monthlyBudget, 0);
  assert.equal(rcat(EAT).carryOver, -45.5, 'carry untouched');
  assert.equal(rcat('fake-sub').monthlyBudget, 99, 'sub-envelope untouched');
  assert.equal(remote.state.balances.checking, 4000);
  assert.equal(remote.state.transactions.length, 4);
  assert.equal(remote.state.envelopeResetAudit.at(-1).action, 'allocations');
  const h1 = await hashNow();
  const n = patches;
  const again = await alloc(good(h1, { dry_run: true }));
  assert.ok(again.json.changes.every(c => !c.changed), 'second run is a no-op');
  assert.equal(patches, n);
  assert.equal((await restore(r.json.snapshot.id, { expected_state_hash: h1, dry_run: false })).status, 200);
  assert.equal(await hashNow(), h0);
});

await test('mode set: only listed envelopes change (by id or name); dry run before/after per envelope; undo via snapshot restore', async () => {
  seed();
  remote.state.balances.checking = 6000;
  const h0 = await hashNow();
  const body = { month: YM, expected_state_hash: h0, mode: 'set', allocations: [{ envelope: GROC, amount: 700 }, { envelope: 'Utilities', amount: 300 }] };
  const d = await alloc(body);
  assert.equal(d.status, 200, d.text); assert.equal(patches, 0);
  const g = d.json.changes.find(c => c.id === GROC);
  assert.equal(g.allocated_before, 1400); assert.equal(g.allocated_after, 700); assert.ok(g.changed);
  assert.ok(!d.json.changes.find(c => c.id === EAT).changed, 'unlisted untouched in set mode');
  const r = await alloc({ ...body, dry_run: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(rcat(GROC).monthlyBudget, 700); assert.equal(rcat(UTIL).monthlyBudget, 300);
  assert.equal(rcat(EAT).monthlyBudget, 600); assert.equal(rcat(MORT).monthlyBudget, 3219.49); assert.equal(rcat(XMAS).monthlyBudget, 500);
  assert.equal(rcat(EAT).carryOver, -45.5);
  assert.equal(remote.state.balances.checking, 6000);
  const h1 = await hashNow();
  assert.equal((await restore(r.json.snapshot.id, { expected_state_hash: h1, dry_run: false })).status, 200);
  assert.equal(await hashNow(), h0);
});

await test('same envelope by id and by name → 400', async () => {
  seed();
  const r = await alloc({ month: YM, expected_state_hash: await hashNow(), mode: 'set', allocations: [{ envelope: GROC, amount: 1 }, { envelope: 'Groceries', amount: 2 }] });
  assert.equal(r.status, 400, r.text);
});

assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`envelope-allocations: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
