/**
 * Start fresh + carry-only reset (+ restore undo). FAKE DATA ONLY.
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
const PLAN = () => ({ targets: [{ envelope: 'Groceries', amount: 1000 }, { envelope: 'mortgage', amount: 3219.49 }, { envelope: 'Utilities', amount: 140 }], default_amount: 0, note: 'Fake reset' });

const startFresh = (body, o = {}) => req(writeHandler, '/api/envelopes/start-fresh', { method: 'POST', token: TOKEN, body, ...o });
const resetCarry = (body, o = {}) => req(writeHandler, '/api/envelopes/reset-carry', { method: 'POST', token: TOKEN, body, ...o });
const SUB = 'fake-sub';
function seedCarry() {
  seed();
  rcat(GROC).carryOver = 123.45;
  rcat(UTIL).carryOver = 20;
  rcat(SUB).carryOver = 7;
}

await test('start-fresh / reset-carry: 503 unset, 401 wrong/read/split token, 429 after 10', async () => {
  seedCarry();
  delete process.env.FIGPIG_ENVELOPE_WRITE_TOKEN;
  assert.equal((await startFresh({})).status, 503);
  assert.equal((await resetCarry({})).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = TOKEN;
  for (const t of ['', 'wrong', READ, SPLIT]) {
    _resetRateLimit();
    assert.equal((await startFresh({}, { token: t })).status, 401);
    assert.equal((await resetCarry({}, { token: t })).status, 401);
  }
  _resetRateLimit();
  for (let i = 0; i < 10; i++) await startFresh({});
  assert.equal((await startFresh({})).status, 429);
  assert.equal(patches, 0);
});

await test('validation: envelopes required ("all" or names), unknown keys, bad expected_carry', async () => {
  const h = 'a'.repeat(64);
  for (const b of [{ expected_state_hash: h }, { expected_state_hash: h, envelopes: [] }, { expected_state_hash: h, envelopes: 'ALL' },
    { expected_state_hash: h, envelopes: 'all', zap: 1 }, { envelopes: 'all' }, { expected_state_hash: h, envelopes: 'all', dry_run: 'no' }]) {
    assert.equal(validateStartFreshBody(b).ok, false, JSON.stringify(b));
  }
  assert.equal(validateStartFreshBody({ expected_state_hash: h, envelopes: 'all' }).value.dryRun, true, 'dry run default');
  for (const b of [{ expected_state_hash: h }, { expected_state_hash: h, targets: [] }, { expected_state_hash: h, targets: [{ envelope: 'Groceries' }] },
    { expected_state_hash: h, targets: [{ envelope: 'Groceries', expected_carry: 1.234 }] }, { expected_state_hash: h, targets: [{ envelope: 'Groceries', expected_carry: 1, amount: 2 }] }]) {
    assert.equal(validateCarryResetBody(b).ok, false, JSON.stringify(b));
  }
  assert.equal(validateCarryResetBody({ expected_state_hash: h, targets: [{ envelope: 'Eating Out / Fast Food', expected_carry: -45.5 }] }).ok, true);
});

await test('start-fresh dry run (default): zero budget AND carry in the table, writes nothing', async () => {
  seedCarry();
  const h = await hashNow();
  const r = await startFresh({ expected_state_hash: h, envelopes: 'all' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'dry_run');
  assert.equal(patches, 0);
  const g = r.json.changes.find(c => c.id === GROC);
  assert.equal(g.allocated_before, 1400); assert.equal(g.allocated_after, 0);
  assert.equal(g.carry_before, 123.45); assert.equal(g.carry_after, 0);
  const e = r.json.changes.find(c => c.id === EAT);
  assert.equal(e.carry_before, -45.5); assert.equal(e.carry_after, 0);
  assert.equal(r.json.totals.total_allocated_after, 0);
  assert.equal(rcat(GROC).carryOver, 123.45);
  globalThis.__sample_start_fresh = r.json;
});

await test('start-fresh real run: snapshot first, every envelope (+subs) budget+carry = 0, nothing else touched; restore undoes all', async () => {
  seedCarry();
  const before = structuredClone(remote.state);
  const h0 = await hashNow();
  const r = await startFresh({ expected_state_hash: h0, envelopes: 'all', dry_run: false, note: 'fake fresh' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'applied');
  assert.equal(patches, 2, 'snapshot write then apply write');
  assert.equal(patchBodies[0].envelopeSnapshots.at(-1).reason, 'pre_start_fresh');
  assert.equal(patchBodies[0].categories.find(c => c.id === GROC).carryOver, 123.45, 'snapshot write does not apply');
  for (const c of remote.state.categories) { assert.equal(c.monthlyBudget, 0, c.name); assert.equal(c.carryOver, 0, c.name); }
  assert.deepEqual(remote.state.transactions, before.transactions);
  assert.deepEqual(remote.state.bills, before.bills);
  assert.deepEqual(remote.state.debts, before.debts);
  assert.deepEqual(remote.state.balances, before.balances);
  assert.equal(remote.state.envelopeResetAudit.at(-1).action, 'start_fresh');
  const bal = await getBal();
  assert.ok(bal.json.envelopes.every(e => e.allocated === 0 && e.carry === 0));
  // Undo
  const sid = r.json.snapshot.id;
  const h1 = await hashNow();
  const u = await restore(sid, { expected_state_hash: h1, dry_run: false });
  assert.equal(u.status, 200, u.text);
  for (const c of before.categories) {
    const x = rcat(c.id);
    assert.equal(x.monthlyBudget, c.monthlyBudget, c.name); assert.equal(x.carryOver || 0, c.carryOver || 0, c.name);
  }
  assert.equal(await hashNow(), h0, 'restore returns to the exact pre-start-fresh state hash');
});

await test('start-fresh named envelopes: only those (+ their subs); unknown name 400; stale hash 409', async () => {
  seedCarry();
  const h = await hashNow();
  assert.equal((await startFresh({ expected_state_hash: 'b'.repeat(64), envelopes: ['Groceries'], dry_run: false })).status, 409);
  const u = await startFresh({ expected_state_hash: h, envelopes: ['Nope'], dry_run: false });
  assert.equal(u.status, 400); assert.equal(u.json.error, 'unknown_envelope');
  assert.equal(patches, 0);
  const r = await startFresh({ expected_state_hash: h, envelopes: ['groceries'], dry_run: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(rcat(GROC).monthlyBudget, 0); assert.equal(rcat(GROC).carryOver, 0);
  assert.equal(rcat(SUB).monthlyBudget, 0); assert.equal(rcat(SUB).carryOver, 0);
  assert.equal(rcat(UTIL).monthlyBudget, 260); assert.equal(rcat(UTIL).carryOver, 20);
  assert.equal(rcat(EAT).carryOver, -45.5);
});

await test('reset-carry: dry run default; 409 carry_mismatch writes nothing; real run zeroes carry only; restore undoes', async () => {
  seedCarry();
  const h = await hashNow();
  const dry = await resetCarry({ expected_state_hash: h, targets: [{ envelope: 'Groceries', expected_carry: 123.45 }] });
  assert.equal(dry.status, 200, dry.text); assert.equal(dry.json.status, 'dry_run'); assert.equal(patches, 0);
  const mm = await resetCarry({ expected_state_hash: h, dry_run: false, targets: [{ envelope: 'Groceries', expected_carry: 100 }, { envelope: 'Utilities', expected_carry: 20 }] });
  assert.equal(mm.status, 409); assert.equal(mm.json.error, 'carry_mismatch');
  assert.deepEqual(mm.json.mismatches, [{ envelope: 'Groceries', expected_carry: 100, actual_carry: 123.45 }]);
  assert.equal(patches, 0);
  const r = await resetCarry({ expected_state_hash: h, dry_run: false, targets: [{ envelope: 'Groceries', expected_carry: 123.45 }, { envelope: 'Eating Out / Fast Food', expected_carry: -45.5 }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(patchBodies[0].envelopeSnapshots.at(-1).reason, 'pre_carry_reset');
  assert.equal(rcat(GROC).carryOver, 0); assert.equal(rcat(GROC).monthlyBudget, 1400, 'allocation untouched');
  assert.equal(rcat(EAT).carryOver, 0); assert.equal(rcat(EAT).monthlyBudget, 600);
  assert.equal(rcat(SUB).carryOver, 7, 'sub-envelope not targeted');
  assert.equal(rcat(UTIL).carryOver, 20);
  const h1 = await hashNow();
  assert.equal((await restore(r.json.snapshot.id, { expected_state_hash: h1, dry_run: false })).status, 200);
  assert.equal(rcat(GROC).carryOver, 123.45); assert.equal(rcat(EAT).carryOver, -45.5);
  assert.equal(await hashNow(), h);
});

await test('start-fresh / reset-carry / reset: 409 month_not_rolled_over on a pre-rollover row, writes nothing', async () => {
  seedCarry();
  remote.state.lastMonthProcessed = getPreviousMonth(YM);
  const h = await hashNow();
  for (const [fn, body] of [
    [startFresh, { expected_state_hash: h, envelopes: 'all', dry_run: false }],
    [startFresh, { expected_state_hash: h, envelopes: 'all' }],
    [resetCarry, { expected_state_hash: h, targets: [{ envelope: 'Groceries', expected_carry: 0 }], dry_run: false }],
    [reset, { expected_state_hash: h, default_amount: 0, dry_run: false }],
  ]) {
    const r = await fn(body);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, 'month_not_rolled_over');
    assert.equal(r.json.server_month, YM);
  }
  assert.equal(patches, 0, 'nothing written');
  delete remote.state.lastMonthProcessed;
  assert.equal((await startFresh({ expected_state_hash: h, envelopes: 'all' })).json.error, 'month_not_rolled_over', 'missing marker fails closed');
});

if (process.env.FP_SAMPLE) console.log(JSON.stringify(globalThis.__sample_start_fresh, null, 1));
assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`envelope-start-fresh: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
