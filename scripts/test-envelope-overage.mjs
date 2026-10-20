/**
 * POST /api/envelopes/overage — cover overspend from the free bonus pot first, then a forced
 * equal split across selected or all non-bill envelopes. FAKE DATA ONLY.
 * Mocks Supabase (budget_states) with a local fetch stub; any other URL fails the run.
 */
import assert from 'node:assert/strict';
import writeHandler, { _resetRateLimit } from '../netlify/functions/envelopes-write.mjs';
import readHandler, { _resetRateLimit as _resetReadRL } from '../netlify/functions/envelopes.mjs';
import { createDefaultState } from '../js/defaults.js';
import { getCurrentMonth } from '../js/utils.js';
import { store } from '../js/store.js';
import { validateOverageBody, equalSplit, cascadeSplit, overageOptions, planOverage, planSignature, coverOverageInStore } from '../js/envelope-overage.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = 'fake-envelope-write-token-0123456789';
const READ = 'fake-read-token-0123456789abcdef';
const ENV = {
  FIGPIG_ENVELOPE_WRITE_TOKEN: TOKEN,
  FIGPIG_BILLS_READ_TOKEN: READ,
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
const stray = [];
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith(ENV.SUPABASE_URL) || !/budget_states/.test(u)) { stray.push(u); throw new Error(`stray fetch ${u}`); }
  const method = String(opts.method || 'GET').toUpperCase();
  if (method === 'GET') return jsonRes(200, remote.state ? [{ state: structuredClone(remote.state), updated_at: remote.updated_at }] : []);
  if (method === 'PATCH') {
    patches++;
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
const UTIL = id('Utilities');
const GROC = id('Groceries');
const EAT = id('Eating Out / Fast Food');
const ENT = id('Entertainment');
const CLO = id('Clothing');
const GAS = id('Gas & Transportation');
const XMAS = id('Christmas');
const EDU = id('Education');
const WORK = id('Work travel');
const PRIMARY = base.incomeSources.find(s => s.type !== 'bonus').id;
const BONUS_SRC = base.incomeSources.find(s => s.type === 'bonus').id;

let txn = 0;
const spend = (cat, amount) => ({ id: `fake-x${txn++}`, date: `${YM}-03`, amount, type: 'expense', description: 'FAKE SPEND', categoryId: cat, clearingStatus: 'cleared' });

/**
 * Fake month: Groceries 1000 budget / 1100 spent → −100.00 overage.
 * Leftover: Eating Out 300, Entertainment 100, Clothing 50, Gas 10, Christmas (sinking) 200.
 * Protected: Mortgage + Utilities (bills), Education (debt), Work travel (pass-through).
 */
function seed({ bonus = 0, grocSpent = 1100, extra = [] } = {}) {
  const s = structuredClone(base);
  s.setupComplete = true;
  s.lastMonthProcessed = YM;
  s.balances.checking = 3000;
  const budgets = { [MORT]: 1500, [UTIL]: 200, [GROC]: 1000, [EAT]: 300, [ENT]: 100, [CLO]: 50, [GAS]: 10, [XMAS]: 200, [EDU]: 80, [WORK]: 500 };
  s.categories.forEach(c => { c.monthlyBudget = budgets[c.id] || 0; c.carryOver = 0; });
  s.bills = [
    { id: 'fake-bill-mort', name: 'Fake Mortgage Co', amount: 1500, dueDate: `${YM}-28`, status: 'pending', recurring: true, categoryId: MORT },
    { id: 'fake-bill-power', name: 'Fake Power', amount: 200, dueDate: `${YM}-25`, status: 'pending', recurring: true, categoryId: UTIL },
  ];
  s.debts = [{ id: 'fake-debt', name: 'Fake Student Loan', balance: 900, interestRate: 5, minPayment: 80, archived: false, categoryId: EDU }];
  s.transactions = [
    { id: 'fake-pay', date: `${YM}-01`, amount: 4000, type: 'income', description: 'FAKE PAYROLL', incomeSourceId: PRIMARY, categoryId: null, clearingStatus: 'cleared' },
    spend(GROC, grocSpent),
    ...extra,
  ];
  if (bonus) s.transactions.push({ id: 'fake-bonus', date: `${YM}-05`, amount: bonus, type: 'income', description: 'FAKE REFUND', incomeSourceId: BONUS_SRC, categoryId: null, clearingStatus: 'cleared' });
  remote = { state: s, updated_at: '2026-10-18T12:00:00.000Z' };
  patches = 0; patchBodies = [];
}

async function req(handler, path, { method = 'GET', token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (method === 'POST') h['content-type'] = 'application/json';
  const res = await handler(new Request(`http://localhost${path}`, { method, headers: h, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined }), { params: {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const getBal = () => req(readHandler, '/api/envelopes', { token: READ });
const overage = (body, o = {}) => req(writeHandler, '/api/envelopes/overage', { method: 'POST', token: TOKEN, body, ...o });
async function bal() { const r = await getBal(); assert.equal(r.status, 200, r.text); return r.json; }
async function hashNow() { return (await bal()).state_hash; }
const remOf = (j, n) => j.envelopes.find(e => e.name === n).remaining;
const debit = (r, n) => r.json.debits.find(d => d.envelope === n);

// --- pure math ---
await test('equalSplit / cascadeSplit: exact cents, pennies to the first slots, caps respected', async () => {
  assert.deepEqual(equalSplit(10000, 3), [3334, 3333, 3333]);
  assert.deepEqual(equalSplit(10001, 3), [3334, 3334, 3333]);
  assert.deepEqual(equalSplit(2, 3), [1, 1, 0]);
  assert.deepEqual(equalSplit(0, 2), [0, 0]);
  for (let t = 0; t < 500; t += 7) for (let n = 1; n < 9; n++) assert.equal(equalSplit(t, n).reduce((a, b) => a + b, 0), t);
  assert.deepEqual(cascadeSplit(10000, [1000, 30000, 10000, 5000, 20000]), { takes: [1000, 2250, 2250, 2250, 2250], residue: 0 });
  assert.deepEqual(cascadeSplit(10000, [1000, 5000]), { takes: [1000, 5000], residue: 4000 });
  assert.deepEqual(cascadeSplit(100, [0, 0]), { takes: [0, 0], residue: 100 });
  assert.deepEqual(cascadeSplit(7, [3, 3, 1]), { takes: [3, 3, 1], residue: 0 });
  assert.deepEqual(cascadeSplit(5, [3, 3, 3]), { takes: [2, 2, 1], residue: 0 });
});

await test('validation: targets required, dry_run default true, strict keys and enums', async () => {
  const H = 'a'.repeat(64);
  const v = validateOverageBody({ expected_state_hash: H, targets: 'all' });
  assert.equal(v.ok, true);
  assert.equal(v.value.dryRun, true);
  assert.equal(v.value.negativeRule, 'cascade');
  assert.equal(v.value.includeSinking, true);
  for (const b of [
    { expected_state_hash: H },
    { expected_state_hash: H, targets: 'ALL' },
    { expected_state_hash: H, targets: [] },
    { expected_state_hash: H, targets: [5] },
    { expected_state_hash: H, targets: 'all', extra: 1 },
    { expected_state_hash: H, targets: 'all', negative_rule: 'clamp' },
    { expected_state_hash: H, targets: 'all', dry_run: 'false' },
    { expected_state_hash: H, targets: 'all', include_sinking_funds: 'no' },
    { expected_state_hash: H, targets: 'all', envelopes: 'Groceries' },
    { expected_state_hash: H, targets: 'all', note: 'x'.repeat(201) },
    { targets: 'all' },
    null, [],
  ]) assert.equal(validateOverageBody(b).ok, false, JSON.stringify(b));
  seed();
  const r = await overage({ expected_state_hash: H, targets: 'all', bogus: true });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_body');
  assert.equal(patches, 0);
});

// --- auth ---
await test('auth: 503 when FIGPIG_ENVELOPE_WRITE_TOKEN unset or short; 401 on missing/wrong/read token', async () => {
  seed();
  const body = { expected_state_hash: 'a'.repeat(64), targets: 'all' };
  delete process.env.FIGPIG_ENVELOPE_WRITE_TOKEN;
  assert.equal((await overage(body)).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = 'too-short';
  assert.equal((await overage(body, { token: 'too-short' })).status, 503);
  process.env.FIGPIG_ENVELOPE_WRITE_TOKEN = TOKEN;
  for (const t of ['', 'wrong', READ, TOKEN.slice(0, -1)]) {
    _resetRateLimit();
    const r = await overage(body, { token: t });
    assert.equal(r.status, 401, `token ${t}`);
    assert.equal(r.json.error, 'unauthorized');
  }
  assert.equal(patches, 0);
});

// --- core cases ---
await test('stale expected_state_hash → 409 stale_state, nothing written', async () => {
  seed();
  const r = await overage({ expected_state_hash: 'b'.repeat(64), targets: 'all', dry_run: false });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'stale_state');
  assert.match(r.json.state_hash, /^[a-f0-9]{64}$/);
  assert.equal(patches, 0);
});
await test('stale after a new bonus deposit: hash covers bonus_available', async () => {
  seed();
  const h = await hashNow();
  remote.state.transactions.push({ id: 'fake-late-bonus', date: `${YM}-06`, amount: 25, type: 'income', description: 'FAKE REFUND', incomeSourceId: BONUS_SRC, clearingStatus: 'cleared' });
  const r = await overage({ expected_state_hash: h, targets: 'all', dry_run: false });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'stale_state');
  assert.equal(patches, 0);
});
await test('dry run (default) writes nothing and predicts the post-apply hash', async () => {
  seed({ bonus: 40 });
  const before = structuredClone(remote.state);
  const h = await hashNow();
  const body = { expected_state_hash: h, targets: ['Eating Out / Fast Food', 'Entertainment', 'Clothing'] };
  const r = await overage(body);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'dry_run');
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.snapshot, undefined);
  assert.equal(patches, 0, 'dry run writes nothing');
  assert.deepEqual(remote.state, before);
  const again = await overage({ ...body, dry_run: true });
  assert.deepEqual(again.json, r.json, 'deterministic');
  const real = await overage({ ...body, dry_run: false });
  assert.equal(real.status, 200, real.text);
  assert.equal(real.json.state_hash_after, r.json.state_hash_after);
  assert.equal(await hashNow(), r.json.state_hash_after);
});
await test('bonus fully covers the overage: no envelope debited', async () => {
  seed({ bonus: 150 });
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: 'all' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.overage, {
    month: YM, total: 100, from_bonus: 100, split_total: 0, forced_below_zero: 0,
    bonus_available_before: 150, bonus_available_after: 50,
    target_mode: 'all', negative_rule: 'cascade', include_sinking_funds: true, target_count: r.json.debits.length,
  });
  assert.ok(r.json.debits.every(d => d.debit === 0));
  assert.deepEqual(r.json.moves, []);
  assert.deepEqual(r.json.overspent, [{ id: GROC, envelope: 'Groceries', remaining_before: -100, from_bonus: 100, from_split: 0, remaining_after: 0 }]);
  const a = await overage({ expected_state_hash: h, targets: 'all', dry_run: false });
  assert.equal(a.status, 200, a.text);
  const j = await bal();
  assert.equal(remOf(j, 'Groceries'), 0);
  assert.equal(remOf(j, 'Eating Out / Fast Food'), 300);
  assert.equal(j.bonus_available, 50);
  const rows = remote.state.monthBonusAllocations[YM];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].categoryId, GROC);
  assert.equal(rows[0].amount, 100);
  assert.equal(rows[0].overageBatchId, a.json.batch_id);
  assert.equal((remote.state.monthEnvelopeMoves?.[YM] || []).length, 0);
});
await test('bonus partially covers: bonus first, rest split equally across selected targets', async () => {
  seed({ bonus: 40 });
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: ['Eating Out / Fast Food', 'Entertainment', 'Clothing'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.overage.from_bonus, 40);
  assert.equal(r.json.overage.split_total, 60);
  assert.equal(r.json.overage.bonus_available_after, 0);
  assert.equal(r.json.overage.target_mode, 'selected');
  assert.deepEqual(r.json.debits.map(d => [d.envelope, d.debit, d.remaining_after]), [
    ['Clothing', 20, 30], ['Eating Out / Fast Food', 20, 280], ['Entertainment', 20, 80],
  ]);
  assert.equal(r.json.overspent[0].from_split, 60);
});
await test('no bonus + all targets (cascade): bills/debt/pass-through/overspent excluded, small envelope capped', async () => {
  seed();
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: 'all' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.overage.from_bonus, 0);
  assert.equal(r.json.overage.split_total, 100);
  const ex = Object.fromEntries(r.json.excluded.map(e => [e.envelope, e.reason]));
  assert.equal(ex.Mortgage, 'bill');
  assert.equal(ex.Utilities, 'bill');
  assert.equal(ex.Education, 'debt');
  assert.equal(ex['Work travel'], 'pass_through');
  assert.equal(ex.Groceries, 'overspent');
  for (const n of ['Mortgage', 'Utilities', 'Education', 'Work travel', 'Groceries']) assert.equal(debit(r, n), undefined, `${n} never a target`);
  assert.equal(debit(r, 'Gas & Transportation').debit, 10, 'capped at its leftover');
  for (const n of ['Eating Out / Fast Food', 'Entertainment', 'Clothing', 'Christmas']) assert.equal(debit(r, n).debit, 22.5, n);
  assert.ok(r.json.debits.every(d => !d.went_negative));
  assert.equal(r.json.debits.filter(d => d.debit > 0).length, 5, 'zero-leftover envelopes are not pushed negative');
  assert.equal(Math.round(r.json.debits.reduce((s, d) => s + d.debit * 100, 0)), 10000);
  assert.deepEqual(r.json.warnings, []);
});
await test('all targets with include_sinking_funds:false skips sinking funds', async () => {
  seed();
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: 'all', include_sinking_funds: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(debit(r, 'Christmas'), undefined);
  assert.equal(r.json.excluded.find(e => e.envelope === 'Christmas').reason, 'sinking_fund');
  assert.equal(debit(r, 'Gas & Transportation').debit, 10);
  for (const n of ['Eating Out / Fast Food', 'Entertainment', 'Clothing']) assert.equal(debit(r, n).debit, 30, n);
});
await test('selected vs all: selected touches only the named envelopes', async () => {
  seed();
  const h = await hashNow();
  const sel = await overage({ expected_state_hash: h, targets: ['entertainment', 'Christmas'] });
  assert.equal(sel.status, 200, sel.text);
  assert.deepEqual(sel.json.debits.map(d => [d.envelope, d.debit]), [['Christmas', 50], ['Entertainment', 50]]);
  const all = await overage({ expected_state_hash: h, targets: 'all' });
  assert.ok(all.json.debits.length > 2);
  // selecting the overspent envelope itself just excludes it
  const self = await overage({ expected_state_hash: h, targets: ['Groceries', 'Clothing', 'Entertainment'] });
  assert.equal(self.status, 200, self.text);
  assert.deepEqual(self.json.excluded, [{ id: GROC, envelope: 'Groceries', reason: 'overspent' }]);
  assert.deepEqual(self.json.debits.map(d => [d.envelope, d.debit]), [['Clothing', 50], ['Entertainment', 50]]);
  assert.equal(patches, 0);
});
await test('bills excluded: bill/debt/pass-through as target → 400; overspent bill is never split', async () => {
  seed({ extra: [spend(UTIL, 250)] }); // Utilities (bill) 50 over
  const h = await hashNow();
  for (const [n, why] of [['Mortgage', 'bill'], ['Utilities', 'bill'], ['Education', 'debt'], ['Work travel', 'pass_through']]) {
    _resetRateLimit();
    const r = await overage({ expected_state_hash: h, targets: ['Clothing', n] });
    assert.equal(r.status, 400, `${n}: ${r.text}`);
    assert.equal(r.json.error, 'protected_envelope');
    assert.equal(r.json.reason, why);
  }
  _resetRateLimit();
  const all = await overage({ expected_state_hash: h, targets: 'all' });
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.json.overspent.map(o => o.envelope), ['Groceries'], 'bill overage is not auto-covered');
  assert.equal(all.json.overage.total, 100);
  const asked = await overage({ expected_state_hash: h, targets: 'all', envelopes: ['Utilities'] });
  assert.equal(asked.status, 400);
  assert.equal(asked.json.error, 'protected_envelope');
  assert.equal(patches, 0);
});
await test('penny remainders go to targets in name order; totals exact', async () => {
  seed({ grocSpent: 1100.01 }); // 100.01 over
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: ['Entertainment', 'Eating Out / Fast Food', 'Christmas'], negative_rule: 'allow' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.overage.total, 100.01);
  assert.deepEqual(r.json.debits.map(d => [d.envelope, d.debit]), [['Christmas', 33.34], ['Eating Out / Fast Food', 33.34], ['Entertainment', 33.33]]);
  assert.equal(Math.round(r.json.moves.reduce((s, m) => s + m.amount * 100, 0)), 10001);
  const a = await overage({ expected_state_hash: h, targets: ['Entertainment', 'Eating Out / Fast Food', 'Christmas'], negative_rule: 'allow', dry_run: false });
  assert.equal(a.status, 200, a.text);
  const j = await bal();
  assert.equal(remOf(j, 'Groceries'), 0, 'overspent envelope ends at exactly 0');
  assert.equal(remOf(j, 'Christmas'), 166.66);
  assert.equal(remOf(j, 'Entertainment'), 66.67);
  // 100.00 over 3 → one extra penny to the first name
  seed();
  const h2 = await hashNow();
  const r2 = await overage({ expected_state_hash: h2, targets: ['Entertainment', 'Eating Out / Fast Food', 'Christmas'] });
  assert.deepEqual(r2.json.debits.map(d => d.debit), [33.34, 33.33, 33.33]);
});
await test('negative rule: allow pushes below 0 and flags; cascade drains first, then forces and flags', async () => {
  seed();
  const h = await hashNow();
  const allow = await overage({ expected_state_hash: h, targets: ['Gas & Transportation', 'Entertainment'], negative_rule: 'allow' });
  assert.equal(allow.status, 200, allow.text);
  assert.deepEqual(allow.json.debits.map(d => [d.envelope, d.debit, d.remaining_after, d.went_negative]), [
    ['Entertainment', 50, 50, false], ['Gas & Transportation', 50, -40, true],
  ]);
  assert.equal(allow.json.warnings.length, 1);
  const cas = await overage({ expected_state_hash: h, targets: ['Gas & Transportation', 'Entertainment'] });
  assert.deepEqual(cas.json.debits.map(d => [d.envelope, d.debit, d.remaining_after, d.went_negative]), [
    ['Entertainment', 90, 10, false], ['Gas & Transportation', 10, 0, false],
  ], 'cascade: Gas gives its 10, Entertainment covers the rest');
  assert.equal(cas.json.overage.forced_below_zero, 0);
  const forced = await overage({ expected_state_hash: h, targets: ['Gas & Transportation', 'Clothing'] });
  assert.deepEqual(forced.json.debits.map(d => [d.envelope, d.debit, d.remaining_after, d.went_negative]), [
    ['Clothing', 70, -20, true], ['Gas & Transportation', 30, -20, true],
  ], 'only 60 of leftover: residue 40 forced 20/20');
  assert.equal(forced.json.overage.forced_below_zero, 40);
  assert.match(forced.json.warnings[0], /forced/);
  assert.equal(patches, 0);
});
await test('multiple overspent envelopes: biggest first, each ends at 0', async () => {
  seed({ extra: [spend(ENT, 130)] }); // Entertainment 30 over
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: ['Eating Out / Fast Food', 'Christmas'], dry_run: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.overage.total, 130);
  assert.deepEqual(r.json.overspent.map(o => [o.envelope, o.remaining_before]), [['Groceries', -100], ['Entertainment', -30]]);
  assert.deepEqual(r.json.moves, [
    { from: 'Christmas', to: 'Groceries', amount: 65 },
    { from: 'Eating Out / Fast Food', to: 'Groceries', amount: 35 },
    { from: 'Eating Out / Fast Food', to: 'Entertainment', amount: 30 },
  ]);
  const j = await bal();
  assert.equal(remOf(j, 'Groceries'), 0);
  assert.equal(remOf(j, 'Entertainment'), 0);
  assert.equal(remOf(j, 'Christmas'), 135);
  assert.equal(remOf(j, 'Eating Out / Fast Food'), 235);
});
await test('real run: pre_overage snapshot first, month-only rows + IOUs + audit; plan/carry/transactions untouched', async () => {
  seed({ bonus: 40 });
  const before = structuredClone(remote.state);
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: ['Eating Out / Fast Food', 'Entertainment', 'Clothing'], dry_run: false, note: 'Fake overage' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'applied');
  assert.equal(r.json.snapshot.reason, 'pre_overage');
  assert.match(r.json.batch_id, /^ovr_[a-f0-9]{16}$/);
  assert.equal(patches, 2, 'snapshot write, then overage write');
  assert.equal(patchBodies[0].monthEnvelopeMoves?.[YM]?.length || 0, 0, 'first write is the snapshot only');
  const s = remote.state;
  assert.deepEqual(s.categories, before.categories, 'monthlyBudget / carryOver untouched (month-only cover)');
  assert.deepEqual(s.transactions, before.transactions);
  assert.deepEqual(s.debts, before.debts);
  assert.deepEqual(s.bills, before.bills);
  assert.equal(s.balances.checking, 3000);
  assert.equal(s.monthBonusAllocations[YM].length, 1);
  assert.equal(s.monthBonusAllocations[YM][0].amount, 40);
  assert.equal(s.monthEnvelopeMoves[YM].length, 3);
  assert.ok(s.monthEnvelopeMoves[YM].every(m => m.toId === GROC && m.amount === 20 && m.coverBatchId === r.json.batch_id));
  assert.equal(s.overspendCoverIous.length, 3);
  const audit = s.envelopeResetAudit.at(-1);
  assert.equal(audit.action, 'overage');
  assert.equal(audit.actor, 'CoS');
  assert.equal(audit.snapshot_id, r.json.snapshot.id);
  assert.equal(audit.batch_id, r.json.batch_id);
  assert.equal(audit.from_bonus, 40);
  assert.equal(audit.split_total, 60);
  assert.equal(audit.note, 'Fake overage');
  const strip = o => { const x = structuredClone(o); for (const k of ['envelopeSnapshots', 'envelopeResetAudit', 'monthBonusAllocations', 'monthEnvelopeMoves', 'overspendCoverIous', '_cloudUpdatedAt']) delete x[k]; return x; };
  assert.deepEqual(strip(s), strip(before), 'nothing else in the row changed');
  const j = await bal();
  assert.equal(j.state_hash, r.json.state_hash_after);
  assert.equal(remOf(j, 'Groceries'), 0);
  assert.equal(remOf(j, 'Clothing'), 30);
  assert.equal(j.bonus_available, 0);
  // The app sees the same thing: IOUs for "Repay cover from bonus", and per-move Undo.
  store.hydrateFromObject(structuredClone(s));
  assert.equal(store.getCoverIouSummary().total, 60);
  assert.equal(store.reverseEnvelopeTransfer(s.monthEnvelopeMoves[YM][0].id, YM), true);
  assert.equal(store.getCategoryRemaining(GROC, YM), -20);
  // A second run now finds nothing to cover.
  const again = await overage({ expected_state_hash: j.state_hash, targets: 'all' });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'no_overage');
});
await test('409 no_overage when nothing is over; 409 no_targets when bonus is short and no target is eligible; 400 unknown', async () => {
  seed({ grocSpent: 900 });
  let h = await hashNow();
  const none = await overage({ expected_state_hash: h, targets: 'all' });
  assert.equal(none.status, 409);
  assert.equal(none.json.error, 'no_overage');
  const notOver = await overage({ expected_state_hash: h, targets: 'all', envelopes: ['Groceries'] });
  assert.equal(notOver.status, 409);
  assert.equal(notOver.json.error, 'not_overspent');
  seed({ bonus: 30 });
  h = await hashNow();
  const nt = await overage({ expected_state_hash: h, targets: ['Groceries'] });
  assert.equal(nt.status, 409, nt.text);
  assert.equal(nt.json.error, 'no_targets');
  assert.equal(nt.json.from_bonus, 30);
  const unk = await overage({ expected_state_hash: h, targets: ['Fake Nowhere'] });
  assert.equal(unk.status, 400);
  assert.equal(unk.json.error, 'unknown_envelope');
  assert.ok(unk.json.validEnvelopes.includes('Clothing'));
  const dup = await overage({ expected_state_hash: h, targets: ['Clothing', 'clothing'] });
  assert.equal(dup.status, 400);
  assert.equal(patches, 0);
});
await test('response is trimmed: no notes, transactions, bill names or raw rows', async () => {
  seed({ bonus: 40 });
  const h = await hashNow();
  const r = await overage({ expected_state_hash: h, targets: 'all' });
  assert.equal(r.status, 200, r.text);
  assert.ok(!/FAKE REFUND|FAKE SPEND|Fake Mortgage Co|Fake Student Loan|monthlyBudget|carryOver|overspendCoverIous|envelopeSnapshots/.test(r.text));
  for (const k of Object.keys(r.json)) assert.ok(['ok', 'status', 'dry_run', 'state_hash_before', 'state_hash_after', 'overage', 'overspent', 'debits', 'excluded', 'moves', 'warnings', 'totals'].includes(k), k);
  assert.equal(r.json.totals.total_allocated_change, 0, 'plan unchanged');
});

// --- Budget-page path: same planner, store's own write path, no server/token ---
const UI_IN = (targets = 'all', extra = {}) => ({ targets, envelopes: null, includeSinking: true, negativeRule: 'cascade', note: '', ...extra });
let uiSeq = 0;
const uiIds = () => `fake-ui-${uiSeq++}`;
await test('UI options: overspent list, bonus pot, eligible vs protected targets', async () => {
  seed({ bonus: 40, extra: [spend(UTIL, 250)] });
  store.hydrateFromObject(structuredClone(remote.state));
  const o = overageOptions(store);
  assert.equal(o.month, YM);
  assert.equal(o.bonusAvailable, 4000);
  assert.equal(o.total, 10000, 'bill overage (Utilities) is not part of it');
  assert.deepEqual(o.overspent.map(x => x.name), ['Groceries']);
  const c = Object.fromEntries(o.candidates.map(x => [x.name, x]));
  assert.equal(c.Groceries.eligible, false); assert.equal(c.Groceries.reason, 'overspent');
  assert.equal(c.Mortgage.reason, 'bill'); assert.equal(c.Utilities.reason, 'bill');
  assert.equal(c.Education.reason, 'debt'); assert.equal(c['Work travel'].reason, 'pass_through');
  assert.equal(c.Clothing.eligible, true); assert.equal(c.Clothing.remaining, 5000);
  assert.equal(c.Christmas.isSinking, true); assert.equal(c.Christmas.eligible, true);
  assert.ok(o.candidates.every(x => !x.id.includes('/')));
});
await test('UI apply: coverOverageInStore writes through the store, ends at 0, persists locally', async () => {
  seed({ bonus: 40 });
  store.hydrateFromObject(structuredClone(remote.state));
  const inp = UI_IN(['Eating Out / Fast Food', 'Entertainment', 'Clothing']);
  const plan = planOverage(store, inp);
  const res = coverOverageInStore(store, inp, { signature: planSignature(plan), newId: uiIds, batchId: 'ovr_fakeui000000001' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(store.getCategoryRemaining(GROC, YM), 0);
  assert.equal(store.getCategoryRemaining(CLO, YM), 30);
  assert.equal(store.getBonusAvailable(YM), 0);
  const saved = JSON.parse(globalThis.localStorage.getItem('financial-peace-dashboard'));
  assert.equal(saved.monthEnvelopeMoves[YM].filter(m => m.overageBatchId === 'ovr_fakeui000000001').length, 3);
  assert.equal(saved.monthBonusAllocations[YM].filter(m => m.overageBatchId === 'ovr_fakeui000000001').length, 1);
  assert.equal(patches, 0, 'browser path makes no server call');
});
await test('UI apply: stale preview (budget changed) → stale_state, nothing written; all-mode + sinking off', async () => {
  seed();
  store.hydrateFromObject(structuredClone(remote.state));
  const inp = UI_IN('all', { includeSinking: false });
  const sig = planSignature(planOverage(store, inp));
  store.update(s => { s.transactions.push(spend(CLO, 5)); }, { persist: false });
  const before = JSON.stringify(store.getState().monthEnvelopeMoves);
  const r = coverOverageInStore(store, inp, { signature: sig, newId: uiIds, batchId: 'ovr_fakeui000000002' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'stale_state');
  assert.equal(JSON.stringify(store.getState().monthEnvelopeMoves), before);
  const ok = coverOverageInStore(store, inp, { signature: planSignature(planOverage(store, inp)), newId: uiIds, batchId: 'ovr_fakeui000000003' });
  assert.equal(ok.ok, true);
  assert.equal(store.getCategoryRemaining(XMAS, YM), 200, 'sinking untouched when toggled off');
  assert.equal(store.getCategoryRemaining(MORT, YM), 1500, 'bill untouched');
  assert.equal(store.getCategoryRemaining(GROC, YM), 0);
});
await test('client code: no write token or secret, no innerHTML in the overage panel', async () => {
  const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const root = new URL('..', import.meta.url).pathname;
  for (const f of walk(join(root, 'js')).filter(f => f.endsWith('.js') && !/config(\.example)?\.js$/.test(f))) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/FIGPIG_ENVELOPE_WRITE_TOKEN|envelope_write_token|SERVICE_ROLE/.test(src), `secret name in ${f}`);
    assert.ok(!/\/api\/envelopes\/overage/.test(src) || f.endsWith('envelope-overage.js'), `browser must not call the write API: ${f}`);
  }
  const panel = readFileSync(join(root, 'js/components/overage-cover.js'), 'utf8');
  assert.ok(!/innerHTML/.test(panel), 'panel renders text nodes only');
});

assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`envelope-overage: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
