/**
 * Envelope balances (GET /api/envelopes), snapshots, restore and reset. FAKE DATA ONLY.
 * Mocks Supabase (budget_states) with a local fetch stub; any other URL fails the run.
 */
import assert from 'node:assert/strict';
import writeHandler, { _resetRateLimit, secretsMatch } from '../netlify/functions/envelopes-write.mjs';
import readHandler, { _resetRateLimit as _resetReadRL } from '../netlify/functions/envelopes.mjs';
import { createDefaultState } from '../js/defaults.js';
import { getCurrentMonth, getPreviousMonth } from '../js/utils.js';
import { validateResetBody, validateRestoreBody, validateSnapshotBody, SNAPSHOT_MAX } from '../js/envelope-reset.js';

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

// --- auth / config ---
await test('503 when FIGPIG_ENVELOPE_WRITE_TOKEN unset, short, reused, or Supabase env missing', async () => {
  seed();
  delete process.env.FIGPIG_ENVELOPE_WRITE_TOKEN;
  assert.equal((await reset({})).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = 'short-token-123';
  assert.equal((await reset({}, { token: 'short-token-123' })).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = READ;
  assert.equal((await reset({}, { token: READ })).status, 503, 'write token equal to the read token fails closed');
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = TOKEN;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal((await reset({})).status, 503);
  process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'http://insecure.example.test';
  assert.equal((await snapshot()).status, 503);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL;
  assert.equal(patches, 0);
});
await test('401 on missing / wrong / read / split token for every write route; alt header works', async () => {
  seed();
  for (const t of ['', 'wrong', TOKEN.slice(0, -1), TOKEN + 'x', READ, SPLIT]) {
    assert.equal((await reset({}, { token: t })).status, 401, `reset token ${t}`);
    assert.equal((await snapshot({}, { token: t })).status, 401, `snapshot token ${t}`);
    assert.equal((await restore('snap_0123456789abcdef', {}, { token: t })).status, 401, `restore token ${t}`);
    _resetRateLimit();
  }
  assert.equal(patches, 0);
  assert.equal(secretsMatch(TOKEN, TOKEN), true);
  const alt = await snapshot({}, { token: '', headers: { 'x-figpig-envelope-write-token': TOKEN } });
  assert.equal(alt.status, 200, alt.text);
});
await test('GET: read token only (write token → 401), 503 unset, 405 non-GET', async () => {
  seed();
  assert.equal((await getBal(TOKEN)).status, 401);
  assert.equal((await getSnaps(TOKEN)).status, 401);
  assert.equal((await getBal('')).status, 401);
  delete process.env.FIGPIG_BILLS_READ_TOKEN;
  assert.equal((await getBal()).status, 503);
  process.env.FIGPIG_BILLS_READ_TOKEN = READ;
  assert.equal((await req(readHandler, '/api/envelopes', { method: 'POST', token: READ })).status, 405);
});
await test('rate limit: 11th write in a minute → 429 (counted before auth)', async () => {
  seed();
  let last;
  for (let i = 0; i < 11; i++) last = await reset({}, { token: 'wrong' });
  assert.equal(last.status, 429);
});
await test('405 / 415 / 400 bad JSON / 413 / bad snapshot id / unknown route', async () => {
  seed();
  assert.equal((await req(writeHandler, '/api/envelopes/reset', { method: 'GET', token: TOKEN })).status, 405);
  assert.equal((await reset({}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await reset(null, { raw: '{nope' })).status, 400);
  assert.equal((await reset(null, { raw: JSON.stringify({ note: 'x'.repeat(20000) }) })).status, 413);
  assert.equal((await restore('../../etc', { expected_state_hash: 'a'.repeat(64) })).status, 404, 'traversal never matches a route');
  assert.equal((await restore('snap_XYZ', { expected_state_hash: 'a'.repeat(64) })).status, 400);
  assert.equal((await req(writeHandler, '/api/envelopes/delete', { method: 'POST', token: TOKEN, body: {} })).status, 404);
  assert.equal(patches, 0);
});
await test('strict validation: unknown keys, amounts, hash, dry_run, note, empty plan', async () => {
  const H = 'a'.repeat(64);
  const ok = { expected_state_hash: H, targets: [{ envelope: 'Groceries', amount: 1000 }] };
  assert.equal(validateResetBody(ok).ok, true);
  assert.equal(validateResetBody(ok).value.dryRun, true, 'dry_run defaults to true');
  assert.equal(validateResetBody({ ...ok, targets: [{ envelope: 'Groceries', amount: 0 }] }).ok, true, '0 allowed');
  assert.equal(validateResetBody({ expected_state_hash: H, default_amount: 0 }).ok, true);
  const bad = [
    { ...ok, extra: 1 },
    { ...ok, actor: 'Someone else' },
    { ...ok, expected_state_hash: undefined },
    { ...ok, expected_state_hash: 'abc' },
    { ...ok, expected_state_hash: 'G'.repeat(64) },
    { ...ok, dry_run: 'false' },
    { ...ok, dry_run: 0 },
    { ...ok, targets: {} },
    { ...ok, targets: Array.from({ length: 101 }, (_, i) => ({ envelope: `E${i}`, amount: 1 })) },
    { ...ok, targets: [{ envelope: 'Groceries', amount: -1 }] },
    { ...ok, targets: [{ envelope: 'Groceries', amount: 1e6 + 0.01 }] },
    { ...ok, targets: [{ envelope: 'Groceries', amount: 1.005 }] },
    { ...ok, targets: [{ envelope: 'Groceries', amount: '1000' }] },
    { ...ok, targets: [{ envelope: 'Groceries', amount: NaN }] },
    { ...ok, targets: [{ envelope: 'Groceries', amount: 5, categoryId: GROC }] },
    { ...ok, targets: [{ envelope: '', amount: 5 }] },
    { ...ok, targets: [{ envelope: 'x'.repeat(81), amount: 5 }] },
    { ...ok, targets: ['Groceries'] },
    { ...ok, default_amount: -1 },
    { ...ok, default_amount: '0' },
    { ...ok, note: 'x'.repeat(201) },
    { ...ok, note: 5 },
    { expected_state_hash: H },
    { expected_state_hash: H, targets: [] },
    [],
    null,
  ];
  for (const b of bad) assert.equal(validateResetBody(b).ok, false, JSON.stringify(b)?.slice(0, 120));
  assert.equal(validateRestoreBody({ expected_state_hash: H }).ok, true);
  assert.equal(validateRestoreBody({ expected_state_hash: H, targets: [] }).ok, false);
  assert.equal(validateRestoreBody({}).ok, false);
  assert.equal(validateSnapshotBody({}).ok, true);
  assert.equal(validateSnapshotBody({ categories: [] }).ok, false, 'cannot inject snapshot content');
  assert.equal(validateSnapshotBody({ note: 'x'.repeat(201) }).ok, false);
  seed();
  const r = await reset({ ...ok, extra: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_body');
  assert.equal(patches, 0);
});

// --- GET balances ---
await test('GET balances: store numbers, bill link, checking, unallocated, newest tx, hash', async () => {
  seed();
  const r = await getBal();
  assert.equal(r.status, 200, r.text);
  const j = r.json;
  assert.deepEqual(Object.keys(j).sort(), ['bonus_available', 'checking_balance', 'envelopes', 'month', 'newest_transaction_date', 'ok', 'state_hash', 'total_allocated', 'unallocated']);
  assert.equal(j.month, YM);
  assert.equal(j.checking_balance, 4000);
  assert.equal(j.total_allocated, 5979.49, 'top-level budgets only (sub excluded)');
  assert.equal(j.unallocated, -1979.49, 'negative = over-allocated');
  assert.equal(j.newest_transaction_date, `${YM}-04`);
  assert.match(j.state_hash, /^[a-f0-9]{64}$/);
  const e = n => j.envelopes.find(x => x.name === n);
  assert.equal(j.bonus_available, 2600, 'unmatched income lands in the free bonus pot (app rule), same as Budget "Bonus available"');
  assert.deepEqual(e('Groceries'), { id: GROC, name: 'Groceries', kind: 'spend', allocated: 1400, spent: 212.44, remaining: 1187.56, bill_id: null });
  assert.deepEqual(e('Mortgage'), { id: MORT, name: 'Mortgage', kind: 'bill', allocated: 3219.49, spent: 0, remaining: 3219.49, bill_id: 'fake-bill-mort' });
  assert.equal(e('Christmas').kind, 'sinking');
  assert.equal(e('Fake Sub').kind, undefined, 'kind on top-level envelopes only');
  assert.equal(e('Eating Out / Fast Food').remaining, 474.5, 'carry-over included in remaining');
  assert.equal(e('Utilities').bill_id, 'fake-bill-power');
  assert.equal(e('Christmas').sinkingFund, true);
  assert.equal(e('Fake Sub').group, 'Groceries');
  for (const x of j.envelopes) {
    for (const k of Object.keys(x)) assert.ok(['id', 'name', 'group', 'sinkingFund', 'kind', 'allocated', 'spent', 'remaining', 'bill_id'].includes(k), k);
  }
  assert.ok(!/secret fake envelope note|monthlyBudget|carryOver|FAKE GROCER|Fake Mortgage Co|fake-debt|envelopeSnapshots/i.test(r.text), 'trimmed');
  assert.equal(await hashNow(), j.state_hash, 'hash is stable');
  remote.state.categories.find(c => c.id === XMAS).monthlyBudget = 501;
  assert.notEqual(await hashNow(), j.state_hash, 'hash changes with allocations');
  seed();
  remote.state.transactions.push({ id: 'fake-t5', date: `${YM}-05`, amount: 1, type: 'expense', description: 'FAKE', categoryId: GROC, clearingStatus: 'cleared' });
  assert.notEqual(await hashNow(), j.state_hash, 'hash changes with spending');
  assert.equal(patches, 0);
});
await test('GET: 409 no budget; Supabase 5xx → 502', async () => {
  seed();
  remote.state = null;
  assert.equal((await getBal()).status, 409);
  seed();
  getHook = () => jsonRes(500, {});
  assert.equal((await getBal()).status, 502);
  assert.equal((await getSnaps()).status, 502);
});

// --- reset ---
await test('reset: 409 on a stale hash, nothing written', async () => {
  seed();
  const r = await reset({ ...PLAN(), expected_state_hash: 'b'.repeat(64), dry_run: false });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'stale_state');
  assert.match(r.json.state_hash, /^[a-f0-9]{64}$/);
  assert.equal(patches, 0);
});
await test('reset: 400 on unknown envelope, lists valid names, never creates; duplicate 400; sub not a target', async () => {
  seed();
  const h = await hashNow();
  const n = remote.state.categories.length;
  const r = await reset({ ...PLAN(), targets: [{ envelope: 'Totally New Envelope', amount: 5 }], expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'unknown_envelope');
  assert.equal(r.json.envelope, 'Totally New Envelope');
  assert.ok(r.json.validEnvelopes.includes('Groceries'));
  assert.ok(!r.json.validEnvelopes.includes('Fake Sub'));
  const sub = await reset({ targets: [{ envelope: 'Fake Sub', amount: 5 }], expected_state_hash: h, dry_run: false });
  assert.equal(sub.json.error, 'unknown_envelope');
  const dup = await reset({ targets: [{ envelope: 'Groceries', amount: 5 }, { envelope: 'GROCERIES', amount: 6 }], expected_state_hash: h, dry_run: false });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error, 'invalid_body');
  assert.equal(remote.state.categories.length, n);
  assert.equal(patches, 0);
});
await test('reset dry run (default): before/after table + totals, writes nothing', async () => {
  seed();
  const before = structuredClone(remote.state);
  const h = await hashNow();
  const body = { ...PLAN(), expected_state_hash: h };
  const r = await reset(body);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'dry_run');
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.snapshot, undefined);
  assert.equal(patches, 0, 'dry run writes nothing');
  assert.deepEqual(remote.state, before);
  assert.deepEqual(r.json.totals, {
    total_allocated_before: 5979.49, total_allocated_after: 4359.49, total_allocated_change: -1620,
    unallocated_before: -1979.49, unallocated_after: -359.49, unallocated_change: 1620,
  });
  const row = n => r.json.changes.find(x => x.envelope === n);
  assert.deepEqual(row('Groceries'), { id: GROC, envelope: 'Groceries', allocated_before: 1400, allocated_after: 1000, remaining_before: 1187.56, remaining_after: 787.56, changed: true });
  assert.equal(row('Mortgage').changed, false);
  assert.equal(row('Christmas').allocated_after, 0);
  assert.equal(row('Fake Sub'), undefined, 'sub-envelopes are not reset');
  assert.equal(r.json.state_hash_before, h);
  // explicit dry_run:true identical
  const r2 = await reset({ ...body, dry_run: true });
  assert.deepEqual(r2.json, r.json);
  assert.equal(patches, 0);
  for (const k of Object.keys(r.json)) assert.ok(['ok', 'status', 'dry_run', 'state_hash_before', 'state_hash_after', 'totals', 'changes'].includes(k), k);
});
await test('reset real run: snapshot saved first (own write), then applied; audit; nothing else touched', async () => {
  seed();
  const before = structuredClone(remote.state);
  const h = await hashNow();
  const r = await reset({ ...PLAN(), expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'applied');
  assert.match(r.json.snapshot.id, /^snap_[a-f0-9]{16}$/);
  assert.equal(r.json.snapshot.reason, 'pre_reset');
  assert.equal(r.json.snapshot.state_hash, h);
  assert.equal(patches, 2, 'snapshot write, then reset write');
  // 1st write: snapshot only, allocations still the old ones
  const w1 = patchBodies[0];
  assert.equal(w1.categories.find(c => c.id === GROC).monthlyBudget, 1400);
  assert.equal(w1.envelopeSnapshots.length, 1);
  const snap = w1.envelopeSnapshots[0];
  assert.equal(snap.id, r.json.snapshot.id);
  assert.equal(snap.actor, 'CoS');
  assert.equal(snap.month, YM);
  assert.equal(snap.categories.find(c => c.id === GROC).monthlyBudget, 1400);
  assert.equal(snap.categories.find(c => c.id === EAT).carryOver, -45.5);
  assert.equal(w1.envelopeResetAudit, undefined);
  // 2nd write: applied
  const s = remote.state;
  assert.equal(rcat(GROC).monthlyBudget, 1000);
  assert.equal(rcat(MORT).monthlyBudget, 3219.49);
  assert.equal(rcat(UTIL).monthlyBudget, 140);
  assert.equal(rcat(EAT).monthlyBudget, 0);
  assert.equal(rcat(XMAS).monthlyBudget, 0);
  assert.equal(rcat('fake-sub').monthlyBudget, 99, 'sub untouched');
  assert.equal(rcat(EAT).carryOver, -45.5, 'carry untouched by reset');
  assert.equal(s.categories.length, before.categories.length, 'no envelopes created/deleted');
  assert.deepEqual(s.categories.map(c => [c.id, c.name, c.parentId || null]), before.categories.map(c => [c.id, c.name, c.parentId || null]));
  assert.deepEqual(s.transactions, before.transactions, 'transactions untouched');
  assert.equal(s.balances.checking, 4000, 'checking untouched');
  assert.deepEqual(s.debts, before.debts, 'debts untouched');
  assert.deepEqual(s.monthPlanExtras || {}, before.monthPlanExtras || {}, 'snowball plan extras untouched');
  assert.equal(s.envelopeResetAudit.length, 1);
  const a = s.envelopeResetAudit[0];
  assert.equal(a.actor, 'CoS');
  assert.equal(a.action, 'reset');
  assert.equal(a.snapshot_id, r.json.snapshot.id);
  assert.equal(a.note, 'Fake reset');
  assert.deepEqual(a.before.find(x => x.categoryId === GROC), { categoryId: GROC, monthlyBudget: 1400, carryOver: 0 });
  assert.deepEqual(a.after.find(x => x.categoryId === GROC), { categoryId: GROC, monthlyBudget: 1000, carryOver: 0 });
  assert.ok(!a.before.some(x => x.categoryId === MORT), 'unchanged rows not audited');
  const strip = o => { const x = structuredClone(o); for (const k of ['categories', 'envelopeSnapshots', 'envelopeResetAudit', '_cloudUpdatedAt']) delete x[k]; return x; };
  assert.deepEqual(strip(w1), strip(before), 'snapshot write changes nothing but envelopeSnapshots');
  assert.deepEqual(strip(s), strip(before), 'reset write changes nothing outside envelopes/snapshots/audit');
  const catStrip = cs => cs.map(c => { const { monthlyBudget, ...rest } = c; return rest; });
  assert.deepEqual(catStrip(s.categories), catStrip(before.categories), 'only monthlyBudget changes on envelopes');
  const g = await getBal();
  assert.equal(g.json.total_allocated, 4359.49);
  assert.equal(g.json.state_hash, r.json.state_hash_after);
  assert.ok(!/envelopeSnapshots|envelopeResetAudit|secret fake envelope note/.test(r.text), 'trimmed response');
});
await test('reset without default_amount leaves untargeted envelopes alone', async () => {
  seed();
  const h = await hashNow();
  const r = await reset({ targets: [{ envelope: 'Groceries', amount: 1000 }], expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(rcat(GROC).monthlyBudget, 1000);
  assert.equal(rcat(XMAS).monthlyBudget, 500);
  assert.equal(rcat(EAT).monthlyBudget, 600);
});
await test('reset: snapshot write conflict → 409, reset not applied', async () => {
  seed();
  const h = await hashNow();
  hooks = [() => { remote.updated_at = '2026-10-18T12:00:01.000Z'; return null; }];
  const r = await reset({ ...PLAN(), expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'conflict');
  assert.equal(rcat(GROC).monthlyBudget, 1400);
});
await test('reset: envelopes changed between snapshot and apply → 409 stale_state, snapshot id returned', async () => {
  seed();
  const h = await hashNow();
  hooks = [null, () => {
    remote.state.categories.find(c => c.id === XMAS).monthlyBudget = 777;
    remote.updated_at = '2026-10-18T12:00:02.000Z';
    return null;
  }];
  const r = await reset({ ...PLAN(), expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, 'stale_state');
  assert.match(r.json.snapshot.id, /^snap_/);
  assert.equal(rcat(XMAS).monthlyBudget, 777);
  assert.equal(rcat(GROC).monthlyBudget, 1400);
});
await test('reset: snapshot wiped by another save before apply → 409 conflict, nothing applied', async () => {
  seed();
  const h = await hashNow();
  hooks = [null, () => {
    delete remote.state.envelopeSnapshots; // e.g. a stale device pushed over the row
    remote.updated_at = '2026-10-18T12:00:03.000Z';
    return null;
  }];
  const r = await reset({ ...PLAN(), expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, 'conflict');
  assert.equal(rcat(GROC).monthlyBudget, 1400);
});
await test('reset: envelope only present after normalization → 409, nothing written', async () => {
  seed();
  remote.state.categories = remote.state.categories.filter(c => c.name !== 'Vacation');
  const h = await hashNow();
  const r = await reset({ ...PLAN(), expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 409, r.text);
  // A default envelope re-added by normalization gets a fresh id each load, so the hash
  // never settles: either way it fails closed before any write.
  assert.ok(['stale_state', 'state_not_normalized'].includes(r.json.error), r.json.error);
  assert.equal(patches, 0);
});
await test('reset: Supabase 5xx on load or on save → 502 (never a conflict)', async () => {
  seed();
  const h = await hashNow();
  getHook = () => jsonRes(503, {});
  assert.equal((await reset({ ...PLAN(), expected_state_hash: h, dry_run: false })).status, 502);
  getHook = null;
  hooks = [() => jsonRes(500, {})];
  assert.equal((await reset({ ...PLAN(), expected_state_hash: h, dry_run: false })).status, 502);
  hooks = [() => new Response('<html>', { status: 200 })];
  assert.equal((await snapshot({})).status, 502);
  assert.equal(rcat(GROC).monthlyBudget, 1400);
});

// --- snapshots + restore ---
await test('manual snapshot + trimmed list', async () => {
  seed();
  const r = await snapshot({ note: 'Fake manual' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.snapshot.reason, 'manual');
  assert.equal(patches, 1);
  assert.equal(remote.state.categories.find(c => c.id === GROC).monthlyBudget, 1400, 'snapshot changes no allocation');
  const l = await getSnaps();
  assert.equal(l.status, 200, l.text);
  assert.deepEqual(Object.keys(l.json).sort(), ['ok', 'snapshots']);
  assert.equal(l.json.snapshots.length, 1);
  assert.deepEqual(Object.keys(l.json.snapshots[0]).sort(), ['actor', 'at', 'envelope_count', 'id', 'month', 'note', 'reason', 'state_hash', 'total_allocated']);
  assert.equal(l.json.snapshots[0].actor, 'CoS');
  assert.equal(l.json.snapshots[0].total_allocated, 5979.49);
  assert.ok(!/monthlyBudget|carryOver|categories|secret/.test(l.text));
});
await test('restore round-trips to the same state hash; dry run default writes nothing', async () => {
  seed();
  const h0 = await hashNow();
  const r = await reset({ ...PLAN(), expected_state_hash: h0, dry_run: false });
  assert.equal(r.status, 200, r.text);
  const sid = r.json.snapshot.id;
  const h1 = await hashNow();
  assert.notEqual(h1, h0);
  patches = 0;
  const dry = await restore(sid, { expected_state_hash: h1 });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.status, 'dry_run');
  assert.equal(dry.json.state_hash_after, h0, 'dry run predicts the original state');
  assert.equal(patches, 0);
  const real = await restore(sid, { expected_state_hash: h1, dry_run: false, note: 'Fake undo' });
  assert.equal(real.status, 200, real.text);
  assert.equal(real.json.status, 'applied');
  assert.equal(real.json.restored_from, sid);
  assert.equal(real.json.snapshot.reason, 'pre_restore');
  assert.equal(patches, 2);
  assert.equal(await hashNow(), h0, 'back to the exact pre-reset state hash');
  assert.equal(rcat(GROC).monthlyBudget, 1400);
  assert.equal(rcat(XMAS).monthlyBudget, 500);
  const a = remote.state.envelopeResetAudit;
  assert.equal(a.length, 2);
  assert.equal(a[1].action, 'restore');
  assert.equal(a[1].snapshot_id, real.json.snapshot.id);
  // and the restore itself can be undone
  const undo = await restore(real.json.snapshot.id, { expected_state_hash: h0, dry_run: false });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(await hashNow(), h1);
});
await test('restore restores carry-over too (full envelope state)', async () => {
  seed();
  const s = await snapshot({});
  const sid = s.json.snapshot.id;
  remote.state.categories.find(c => c.id === EAT).carryOver = 0;
  remote.state.categories.find(c => c.id === GROC).monthlyBudget = 10;
  const h = await hashNow();
  const r = await restore(sid, { expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(rcat(EAT).carryOver, -45.5);
  assert.equal(rcat(GROC).monthlyBudget, 1400);
});
await test('restore: 409 stale hash, 404 unknown id, 409 month mismatch, 409 envelope set changed', async () => {
  seed();
  const s = await snapshot({});
  const sid = s.json.snapshot.id;
  const h = await hashNow();
  patches = 0;
  const stale = await restore(sid, { expected_state_hash: 'c'.repeat(64), dry_run: false });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'stale_state');
  assert.equal((await restore('snap_0000000000000000', { expected_state_hash: h, dry_run: false })).status, 404);
  remote.state.envelopeSnapshots[0].month = getPreviousMonth(YM);
  const mm = await restore(sid, { expected_state_hash: h, dry_run: false });
  assert.equal(mm.status, 409);
  assert.equal(mm.json.error, 'snapshot_month_mismatch');
  remote.state.envelopeSnapshots[0].month = YM;
  remote.state.categories.push({ ...remote.state.categories[0], id: 'fake-new', name: 'Fake New', parentId: null, monthlyBudget: 0 });
  const h2 = await hashNow();
  const ch = await restore(sid, { expected_state_hash: h2, dry_run: false });
  assert.equal(ch.status, 409);
  assert.equal(ch.json.error, 'envelopes_changed');
  assert.ok(remote.state.categories.some(c => c.id === 'fake-new'), 'never deletes envelopes');
  assert.equal(patches, 0);
});
await test('snapshot cap keeps the restore target', async () => {
  seed();
  const first = await snapshot({});
  for (let i = 1; i < SNAPSHOT_MAX; i++) { _resetRateLimit(); await snapshot({}); }
  assert.equal(remote.state.envelopeSnapshots.length, SNAPSHOT_MAX);
  assert.equal(remote.state.envelopeSnapshots[0].id, first.json.snapshot.id);
  _resetRateLimit();
  const h = await hashNow();
  const r = await restore(first.json.snapshot.id, { expected_state_hash: h, dry_run: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(remote.state.envelopeSnapshots.length, SNAPSHOT_MAX);
  assert.ok(remote.state.envelopeSnapshots.some(x => x.id === first.json.snapshot.id));
});

assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`envelope-reset: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
