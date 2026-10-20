/**
 * Forgive overspend (offset moves, source "forgiven") + restore + GET with write token. FAKE DATA ONLY.
 * Mocks Supabase (budget_states) with a local fetch stub; any other URL fails the run.
 */
import assert from 'node:assert/strict';
import writeHandler, { _resetRateLimit, secretsMatch } from '../netlify/functions/envelopes-write.mjs';
import readHandler, { _resetRateLimit as _resetReadRL } from '../netlify/functions/envelopes.mjs';
import { createDefaultState } from '../js/defaults.js';
import { getCurrentMonth, getPreviousMonth } from '../js/utils.js';
import { validateForgiveBody } from "../js/envelope-forgive.js";

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

const forgive = (body, o = {}) => req(writeHandler, '/api/envelopes/forgive-overspend', { method: 'POST', token: TOKEN, body, ...o });
function seedOver() {
  seed();
  rcat(GROC).monthlyBudget = 100;   // spent 212.44 → -112.44
  rcat(EAT).monthlyBudget = 0;      // carry -45.5, spent 80 → -125.5
  remote.state.monthEnvelopeMoves = { [YM]: [{ id: 'fake-move', fromId: UTIL, toId: XMAS, amount: 10, note: 'fake', at: '2026-10-01T00:00:00.000Z' }] };
}
const pick = s => ({ tx: JSON.stringify(s.transactions), bills: JSON.stringify(s.bills), budgets: JSON.stringify(s.categories.map(c => [c.id, c.monthlyBudget])), checking: s.balances.checking, debts: JSON.stringify(s.debts) });
const remOf = async n => (await getBal()).json.envelopes.find(e => e.name === n).remaining;

await test('auth: 503 unset/short/reused, 401 wrong/read/split; 429 after 10', async () => {
  seedOver();
  delete process.env.FIGPIG_ENVELOPE_WRITE_TOKEN;
  assert.equal((await forgive({})).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = 'short-123';
  assert.equal((await forgive({}, { token: 'short-123' })).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = SPLIT;
  assert.equal((await forgive({}, { token: SPLIT })).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = TOKEN;
  for (const t of ['', 'wrong', READ, SPLIT]) { _resetRateLimit(); assert.equal((await forgive({}, { token: t })).status, 401, t); }
  _resetRateLimit();
  for (let i = 0; i < 10; i++) await forgive({});
  assert.equal((await forgive({})).status, 429);
  assert.equal(patches, 0);
});

await test('GET /api/envelopes works with the envelope write token', async () => {
  seedOver();
  const r = await getBal(TOKEN);
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.state_hash, /^[a-f0-9]{64}$/);
});

await test('validation', async () => {
  const h = 'a'.repeat(64);
  for (const b of [{ expected_state_hash: h }, { expected_state_hash: h, targets: 'all' }, { expected_state_hash: h, targets: [] },
    { expected_state_hash: h, targets: [{ envelope: 'Groceries' }] }, { expected_state_hash: h, targets: 'all_negative', month: '2026-13' },
    { expected_state_hash: h, targets: 'all_negative', month: '2999-01' }, { expected_state_hash: h, targets: 'all_negative', x: 1 },
    { targets: 'all_negative' }, { expected_state_hash: h, targets: [{ envelope: 'Groceries', expected_remaining: -1.234 }] }]) {
    assert.equal(validateForgiveBody(b).ok, false, JSON.stringify(b));
  }
  const ok = validateForgiveBody({ expected_state_hash: h, targets: 'all_negative' });
  assert.equal(ok.value.dryRun, true); assert.equal(ok.value.month, YM);
});

await test('dry run (default): preview, no write', async () => {
  seedOver();
  const before = structuredClone(remote.state);
  const h = await hashNow();
  const r = await forgive({ expected_state_hash: h, targets: 'all_negative' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'dry_run');
  assert.deepEqual(r.json.forgiven, [
    { envelope: 'Groceries', amount: 112.44, remaining_before: -112.44, remaining_after: 0 },
    { envelope: 'Eating Out / Fast Food', amount: 125.5, remaining_before: -125.5, remaining_after: 0 },
  ]);
  assert.equal(r.json.total_forgiven, 237.94);
  assert.equal(r.json.totals.total_allocated_change, 0); assert.equal(r.json.totals.unallocated_change, 0);
  assert.equal(patches, 0); assert.deepEqual(remote.state, before);
  globalThis.__sample = r.json;
});

await test('409 remaining_mismatch (per-envelope list), 409 stale hash, 400 unknown, positive → 400 not_overspent; nothing written', async () => {
  seedOver();
  const h = await hashNow();
  const mm = await forgive({ expected_state_hash: h, dry_run: false, targets: [{ envelope: 'Groceries', expected_remaining: -100 }, { envelope: 'Eating Out / Fast Food', expected_remaining: -125.5 }] });
  assert.equal(mm.status, 409); assert.equal(mm.json.error, 'remaining_mismatch');
  assert.deepEqual(mm.json.mismatches, [{ envelope: 'Groceries', expected_remaining: -100, actual_remaining: -112.44 }]);
  assert.equal((await forgive({ expected_state_hash: 'b'.repeat(64), dry_run: false, targets: 'all_negative' })).status, 409);
  const u = await forgive({ expected_state_hash: h, dry_run: false, targets: [{ envelope: 'Nope', expected_remaining: -1 }] });
  assert.equal(u.status, 400); assert.equal(u.json.error, 'unknown_envelope');
  const pos = await forgive({ expected_state_hash: h, dry_run: false, targets: [{ envelope: 'Utilities', expected_remaining: await remOf('Utilities') }] });
  assert.equal(pos.status, 400); assert.equal(pos.json.error, 'not_overspent');
  assert.equal(patches, 0);
});

await test('named targets real run: offsets only, target at exactly 0, tx/allocations/bills untouched; restore → exact hash', async () => {
  seedOver();
  const before = structuredClone(remote.state);
  const h0 = await hashNow();
  const r = await forgive({ expected_state_hash: h0, dry_run: false, note: 'fake', targets: [{ envelope: 'groceries', expected_remaining: -112.44 }] });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'applied'); assert.match(r.json.batch_id, /^fgv_[a-f0-9]{16}$/);
  assert.equal(patches, 2);
  assert.equal(patchBodies[0].envelopeSnapshots.at(-1).reason, 'pre_forgive');
  assert.equal(await remOf('Groceries'), 0);
  assert.equal(await remOf('Eating Out / Fast Food'), -125.5, 'untargeted untouched');
  assert.deepEqual(pick(remote.state), pick(before));
  const rows = remote.state.monthEnvelopeMoves[YM];
  assert.equal(rows.length, 2); assert.deepEqual(rows[0], before.monthEnvelopeMoves[YM][0]);
  assert.equal(rows[1].fromId, null); assert.equal(rows[1].toId, GROC); assert.equal(rows[1].amount, 112.44); assert.equal(rows[1].source, 'forgiven');
  const a = remote.state.envelopeResetAudit.at(-1);
  assert.equal(a.action, 'forgive_overspend'); assert.equal(a.batch_id, r.json.batch_id);
  const h1 = await hashNow();
  const u = await restore(r.json.snapshot.id, { expected_state_hash: h1, dry_run: false });
  assert.equal(u.status, 200, u.text);
  assert.equal(await hashNow(), h0, 'exact original hash');
  assert.deepEqual(remote.state.monthEnvelopeMoves, before.monthEnvelopeMoves, 'offset rows removed, other moves kept');
  assert.deepEqual(pick(remote.state), pick(before));
});

await test('all_negative real run + restore; second forgive then restore of first snapshot removes both', async () => {
  seedOver();
  const before = structuredClone(remote.state);
  const h0 = await hashNow();
  const r = await forgive({ expected_state_hash: h0, dry_run: false, targets: 'all_negative' });
  assert.equal(r.status, 200, r.text);
  const bal = (await getBal()).json;
  assert.ok(bal.envelopes.filter(e => e.group === undefined).every(e => e.remaining >= 0));
  assert.equal(bal.total_allocated, (await (async () => { return before.categories.filter(c => !c.parentId).reduce((s, c) => s + c.monthlyBudget, 0); })()));
  assert.deepEqual(pick(remote.state), pick(before));
  const n = await forgive({ expected_state_hash: await hashNow(), dry_run: false, targets: 'all_negative' });
  assert.equal(n.status, 400); assert.equal(n.json.error, 'nothing_to_forgive');
  const u = await restore(r.json.snapshot.id, { expected_state_hash: await hashNow(), dry_run: false });
  assert.equal(u.status, 200, u.text);
  assert.equal(await hashNow(), h0);
  assert.deepEqual(remote.state.monthEnvelopeMoves, before.monthEnvelopeMoves);
});

await test('UI: envelope card labels forgiven offset separately from moves', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../js/pages/budget.js', import.meta.url), 'utf8');
  assert.match(src, /overspend forgiven/); assert.match(src, /Forgiven overspend →/);
});

if (process.env.FP_SAMPLE) console.log(JSON.stringify(globalThis.__sample, null, 1));
assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`envelope-forgive: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
