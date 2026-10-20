/**
 * Budget-fix API: GET /api/transactions, void + restore, GET /api/envelopes?month. FAKE DATA ONLY.
 * Mocks Supabase (budget_states) with a local fetch stub; any other URL fails the run.
 */
import assert from 'node:assert/strict';
import readTx, { _resetRateLimit as rlRead } from '../netlify/functions/transactions-read.mjs';
import voidTx, { _resetRateLimit as rlVoid } from '../netlify/functions/transactions-void.mjs';
import readEnv, { _resetRateLimit as rlEnv } from '../netlify/functions/envelopes.mjs';
import { config as importConfig } from '../netlify/functions/transactions.mjs';
import { createDefaultState } from '../js/defaults.js';
import { getCurrentMonth, getPreviousMonth } from '../js/utils.js';
import { validateVoidBody, validateListQuery } from '../js/tx-fix.js';

const TXR = 'fake-tx-read-token-0123456789abcd';
const TXV = 'fake-tx-void-token-0123456789abcd';
const BILLS = 'fake-read-token-0123456789abcdef';
const ENV = {
  FIGPIG_TX_READ_TOKEN: TXR, FIGPIG_TX_VOID_TOKEN: TXV, FIGPIG_BILLS_READ_TOKEN: BILLS,
  FIGPIG_ENVELOPE_WRITE_TOKEN: 'fake-envelope-write-token-0123456789',
  FIGPIG_TX_WRITE_TOKEN: 'fake-tx-write-import-token-0123456789',
  SUPABASE_URL: 'https://fake-project.example.test', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', FIGPIG_OWNER_USER_ID: 'fake-owner',
};
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;

let passed = 0; const failures = [];
async function test(name, fn) {
  try { rlRead(); rlVoid(); rlEnv(); await fn(); passed++; console.log(`ok   ${name}`); } catch (err) { failures.push(name); console.error(`FAIL ${name}\n`, err); }
}

let remote; let patches; let stray = []; let patchHook = null;
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith(ENV.SUPABASE_URL) || !/budget_states/.test(u)) { stray.push(u); throw new Error(`stray fetch ${u}`); }
  const method = String(opts.method || 'GET').toUpperCase();
  if (method === 'GET') return jsonRes(200, remote.state ? [{ state: structuredClone(remote.state), updated_at: remote.updated_at }] : []);
  if (method === 'PATCH') {
    patches++;
    if (patchHook) { const r = patchHook(); if (r) return r; }
    const m = u.match(/updated_at=eq\.([^&]+)/);
    if (m && decodeURIComponent(m[1]) !== remote.updated_at) return jsonRes(200, []);
    const p = JSON.parse(opts.body);
    remote = { state: p.state, updated_at: p.updated_at };
    return jsonRes(200, [{ updated_at: p.updated_at }]);
  }
  return new Response('nope', { status: 405 });
};

const YM = getCurrentMonth(); const PM = getPreviousMonth(YM);
const base = createDefaultState();
const id = n => base.categories.find(c => c.name === n).id;
const GROC = id('Groceries'); const EAT = id('Eating Out / Fast Food'); const UTIL = id('Utilities');
function seed() {
  const s = structuredClone(base);
  s.setupComplete = true; s.lastMonthProcessed = YM; s.balances.checking = 4000;
  s.categories.forEach(c => { c.monthlyBudget = { [GROC]: 900, [EAT]: 200, [UTIL]: 260 }[c.id] || 0; });
  s.categories.find(c => c.id === GROC).carryOver = 50;
  s.debts = [{ id: 'fake-debt', name: 'Fake Card', balance: 1000, interestRate: 19.9, minPayment: 45, archived: false }];
  s.transactions = [
    { id: 'fake-bank-1', date: `${YM}-02`, amount: 212.44, type: 'expense', description: 'FAKE GROCER #12', categoryId: GROC, clearingStatus: 'cleared', importCategory: null, externalId: 'ext-fake-1', note: 'secret fake note' },
    { id: 'fake-man-1', date: `${YM}-04`, amount: 80, type: 'expense', description: 'FAKE PIZZA', categoryId: EAT, clearingStatus: 'cleared' },
    { id: 'fake-split', date: `${YM}-05`, amount: 100, type: 'expense', description: 'FAKE MART', categoryId: null, splits: [{ categoryId: GROC, amount: 60 }, { categoryId: EAT, amount: 40 }], clearingStatus: 'cleared', importCategory: 'Shopping' },
    { id: 'fake-old', date: `${PM}-27`, amount: 30, type: 'expense', description: 'FAKE OLD', categoryId: GROC, clearingStatus: 'cleared' },
    { id: 'fake-debtpay', date: `${YM}-06`, amount: 45, type: 'debt_payment', description: 'FAKE CARD PMT', debtId: 'fake-debt', clearingStatus: 'cleared' },
    { id: 'fake-uncat', date: `${YM}-07`, amount: 12.5, type: 'expense', description: 'FAKE ??', categoryId: null, clearingStatus: 'cleared' },
  ];
  remote = { state: s, updated_at: '2026-10-18T12:00:00.000Z' }; patches = 0; patchHook = null;
}
async function req(handler, path, { method = 'GET', token, body, headers = {}, params } = {}) {
  const h = { ...headers }; if (token) h.authorization = `Bearer ${token}`;
  if (method === 'POST' && !('content-type' in h)) h['content-type'] = 'application/json';
  const res = await handler(new Request(`http://localhost${path}`, { method, headers: h, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), { params: params || {} });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const list = (q, token = TXR) => req(readTx, `/api/transactions?${q}`, { token });
const doVoid = (tid, body, token = TXV) => req(voidTx, `/api/transactions/${encodeURIComponent(tid)}/void`, { method: 'POST', token, body, params: { id: tid } });
const doRestore = (vid, body, token = TXV) => req(voidTx, `/api/transactions/voids/${vid}/restore`, { method: 'POST', token, body, params: { voidId: vid } });

await test('routing: import function is POST-only by config; read is GET-only', async () => {
  assert.deepEqual(importConfig.method, ['POST', 'OPTIONS']);
  seed();
  assert.equal((await req(readTx, '/api/transactions?month=' + YM, { method: 'POST', token: TXR })).status, 405);
  assert.equal((await req(voidTx, '/api/transactions/x/void', { token: TXV })).status, 405);
});

await test('auth: 503 unset/short/reused token, 401 wrong or other token (read + void)', async () => {
  seed();
  for (const [name, call] of [['FIGPIG_TX_READ_TOKEN', t => list('month=' + YM, t)], ['FIGPIG_TX_VOID_TOKEN', t => doVoid('fake-man-1', {}, t)]]) {
    const keep = process.env[name];
    delete process.env[name]; assert.equal((await call(keep)).status, 503, name + ' unset');
    process.env[name] = 'short-123'; assert.equal((await call('short-123')).status, 503, name + ' short');
    process.env[name] = BILLS; assert.equal((await call(BILLS)).status, 503, name + ' reused');
    process.env[name] = keep;
    rlRead(); rlVoid();
    for (const t of ['', 'wrong', BILLS, ENV.FIGPIG_ENVELOPE_WRITE_TOKEN, ENV.FIGPIG_TX_WRITE_TOKEN, name === 'FIGPIG_TX_READ_TOKEN' ? TXV : TXR]) {
      assert.equal((await call(t)).status, 401, `${name} token ${t}`);
    }
  }
  process.env.FIGPIG_TX_VOID_TOKEN = TXR; // read == void → both fail closed
  assert.equal((await list('month=' + YM)).status, 503);
  process.env.FIGPIG_TX_VOID_TOKEN = TXV;
  assert.equal(patches, 0);
});

await test('rate limits: void 11th/min → 429 (before auth); read 31st → 429', async () => {
  seed();
  for (let i = 0; i < 10; i++) await doVoid('fake-man-1', {}, 'wrong');
  assert.equal((await doVoid('fake-man-1', {}, TXV)).status, 429);
  for (let i = 0; i < 30; i++) await list('month=' + YM, 'wrong');
  assert.equal((await list('month=' + YM)).status, 429);
});

await test('list: month filter, newest first, source bank/manual, splits, trimmed fields', async () => {
  seed();
  const r = await list(`month=${YM}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.transactions.map(t => t.id), ['fake-uncat', 'fake-debtpay', 'fake-split', 'fake-man-1', 'fake-bank-1']);
  const t = n => r.json.transactions.find(x => x.id === n);
  assert.deepEqual(t('fake-bank-1'), { id: 'fake-bank-1', date: `${YM}-02`, amount: 212.44, type: 'expense', payee: 'FAKE GROCER #12', envelope: 'Groceries', source: 'bank' });
  assert.equal(t('fake-man-1').source, 'manual');
  assert.deepEqual(t('fake-split').splits, [{ envelope: 'Groceries', amount: 60 }, { envelope: 'Eating Out / Fast Food', amount: 40 }]);
  assert.equal(t('fake-split').envelope, null);
  assert.ok(!/secret fake note|ext-fake-1|importCategory|Shopping|fake-debt"/.test(r.text), 'trimmed');
});

await test('list: envelope filter (incl. splits, any month), month+envelope, unknown envelope, bad query', async () => {
  seed();
  const e = await list('envelope=groceries');
  assert.deepEqual(e.json.transactions.map(t => t.id), ['fake-split', 'fake-bank-1', 'fake-old']);
  const both = await list(`month=${PM}&envelope=Groceries`);
  assert.deepEqual(both.json.transactions.map(t => t.id), ['fake-old']);
  const lim = await list(`month=${YM}&limit=2`);
  assert.equal(lim.json.transactions.length, 2); assert.equal(lim.json.truncated, true); assert.equal(lim.json.total, 5);
  const u = await list('envelope=Nope');
  assert.equal(u.status, 400); assert.equal(u.json.error, 'unknown_envelope');
  for (const q of ['', 'month=2026-13', 'month=2026-1', "month=2026-10'--", 'foo=1&month=' + YM, 'limit=0&month=' + YM, 'limit=501&month=' + YM, `month=${YM}&month=${YM}`, 'envelope=' + 'x'.repeat(81)]) {
    const b = await list(q); assert.equal(b.status, 400, q); assert.equal(b.json.error, 'invalid_query');
  }
  assert.equal(validateListQuery(new URLSearchParams('month=2026-10')).ok, true);
});

await test('void validation: expected_amount + expected_date required, strict keys, bad ids', async () => {
  for (const b of [{}, { expected_amount: 80 }, { expected_date: `${YM}-04` }, { expected_amount: -1, expected_date: `${YM}-04` },
    { expected_amount: 80.001, expected_date: `${YM}-04` }, { expected_amount: 80, expected_date: '10/04/2026' }, { expected_amount: 80, expected_date: `${YM}-04`, x: 1 },
    { expected_amount: '80', expected_date: `${YM}-04`, dry_run: 'false' }]) {
    assert.equal(validateVoidBody(b).ok, false, JSON.stringify(b));
  }
  assert.equal(validateVoidBody({ expected_amount: 80, expected_date: `${YM}-04` }).value.dryRun, true);
  seed();
  assert.equal((await doVoid('bad id!', { expected_amount: 80, expected_date: `${YM}-04` })).status, 400);
  assert.equal((await doRestore('void_nothex', {})).status, 400);
  const nf = await doVoid('fake-missing', { expected_amount: 80, expected_date: `${YM}-04`, dry_run: false });
  assert.equal(nf.status, 404);
  assert.equal(patches, 0);
});

await test('void: 409 when amount or date differ (nothing written)', async () => {
  seed();
  const a = await doVoid('fake-man-1', { expected_amount: 81, expected_date: `${YM}-04`, dry_run: false });
  assert.equal(a.status, 409); assert.equal(a.json.error, 'expected_mismatch'); assert.deepEqual(a.json.actual, { amount: 80, date: `${YM}-04` });
  const d = await doVoid('fake-man-1', { expected_amount: 80, expected_date: `${YM}-05`, dry_run: false });
  assert.equal(d.status, 409);
  assert.equal(patches, 0);
  assert.ok(remote.state.transactions.some(t => t.id === 'fake-man-1'));
});

await test('void dry run (default): preview + effects, writes nothing', async () => {
  seed();
  const before = structuredClone(remote.state);
  const r = await doVoid('fake-man-1', { expected_amount: 80, expected_date: `${YM}-04` });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'dry_run'); assert.equal(r.json.void_id, undefined);
  assert.deepEqual(r.json.effects, { checking_before: 4000, checking_after: 4080, debt_adjusted: false, carry_adjusted: false });
  assert.equal(patches, 0); assert.deepEqual(remote.state, before);
  globalThis.__sample_void = r.json;
});

await test('void real run: removes row, reverses checking + debt, writes undo record, nothing else; restore undoes exactly', async () => {
  seed();
  const before = structuredClone(remote.state);
  const r = await doVoid('fake-debtpay', { expected_amount: 45, expected_date: `${YM}-06`, dry_run: false, note: 'fake dup' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'voided'); assert.match(r.json.void_id, /^void_[a-f0-9]{16}$/);
  assert.equal(patches, 1);
  assert.ok(!remote.state.transactions.some(t => t.id === 'fake-debtpay'));
  assert.equal(remote.state.balances.checking, 4045);
  assert.equal(remote.state.debts[0].balance, 1045);
  const rec = remote.state.transactionVoids.at(-1);
  assert.equal(rec.id, r.json.void_id); assert.equal(rec.tx.id, 'fake-debtpay'); assert.equal(rec.note, 'fake dup');
  assert.deepEqual(remote.state.categories, before.categories);
  assert.equal(remote.state.lastMonthProcessed, before.lastMonthProcessed);
  // Restore: dry run default first
  const dry = await doRestore(r.json.void_id, {});
  assert.equal(dry.status, 200); assert.equal(dry.json.status, 'dry_run'); assert.equal(patches, 1);
  const u = await doRestore(r.json.void_id, { dry_run: false });
  assert.equal(u.status, 200, u.text); assert.equal(u.json.status, 'restored');
  const { transactionVoids, _cloudUpdatedAt, ...after } = remote.state;
  const sortTx = s => ({ ...s, transactions: [...s.transactions].sort((a, b) => a.id.localeCompare(b.id)) });
  assert.deepEqual(sortTx(after), sortTx(before), 'state equals the pre-void state (row order aside)');
  assert.ok(transactionVoids[0].restored_at);
  const again = await doRestore(r.json.void_id, { dry_run: false });
  assert.equal(again.status, 409); assert.equal(again.json.error, 'already_restored');
});

await test('void: CAS conflict once → re-checks and retries; twice → 409; Supabase 5xx → 502', async () => {
  seed();
  let n = 0;
  patchHook = () => (n++ === 0 ? jsonRes(200, []) : null);
  const r = await doVoid('fake-man-1', { expected_amount: 80, expected_date: `${YM}-04`, dry_run: false });
  assert.equal(r.status, 200, r.text); assert.equal(patches, 2);
  seed(); patchHook = () => jsonRes(200, []);
  const c = await doVoid('fake-man-1', { expected_amount: 80, expected_date: `${YM}-04`, dry_run: false });
  assert.equal(c.status, 409); assert.equal(c.json.error, 'conflict');
  seed(); patchHook = () => jsonRes(500, { message: 'fake' });
  const e = await doVoid('fake-man-1', { expected_amount: 80, expected_date: `${YM}-04`, dry_run: false });
  assert.equal(e.status, 502); assert.ok(!/fake-service-role/.test(e.text));
});

await test('GET /api/envelopes: allocated/spent/carry/remaining per envelope, checking, unallocated, uncategorized; ?month', async () => {
  seed();
  const r = await req(readEnv, '/api/envelopes', { token: BILLS });
  assert.equal(r.status, 200, r.text);
  const g = r.json.envelopes.find(e => e.name === 'Groceries');
  assert.equal(g.allocated, 900); assert.equal(g.carry, 50); assert.equal(g.spent, 272.44); assert.equal(g.remaining, 677.56);
  assert.equal(r.json.checking_balance, 4000); assert.equal(typeof r.json.unallocated, 'number');
  assert.deepEqual(r.json.uncategorized, { count: 1, total: 12.5 });
  const p = await req(readEnv, `/api/envelopes?month=${PM}`, { token: BILLS });
  assert.equal(p.status, 200, p.text); assert.equal(p.json.month, PM);
  assert.equal(p.json.envelopes.find(e => e.name === 'Groceries').spent, 30);
  assert.equal(p.json.state_hash, r.json.state_hash, 'hash always current month');
  for (const q of ['month=2026-13', 'foo=1', 'month=x']) assert.equal((await req(readEnv, '/api/envelopes?' + q, { token: BILLS })).status, 400, q);
});

if (process.env.FP_SAMPLE) console.log(JSON.stringify(globalThis.__sample_void, null, 1));
assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`budget-fix-api: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
