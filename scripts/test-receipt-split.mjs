/**
 * Receipt split endpoint + Receipts to review. FAKE DATA ONLY.
 * Mocks Supabase (budget_states) with a local fetch stub; any other URL fails the run.
 */
import assert from 'node:assert/strict';
import handler, { _resetRateLimit, secretsMatch } from '../netlify/functions/transactions-split.mjs';
import { store } from '../js/store.js';
import { createDefaultState } from '../js/defaults.js';
import { applyRuleToTransaction } from '../js/category-rules.js';
import {
  validateSplitBody,
  reconcileSplitCents,
  splitsFromItemBuckets,
  toCents,
  sanitizeReceiptReview,
} from '../js/receipt-split.js';

const TOKEN = 'fake-split-token-0123456789abcdef';
const ENV = {
  FIGPIG_TX_SPLIT_TOKEN: TOKEN,
  SUPABASE_URL: 'https://fake-project.example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  FIGPIG_OWNER_USER_ID: 'fake-owner',
};
function setEnv(on = true) {
  for (const [k, v] of Object.entries(ENV)) {
    if (on) process.env[k] = v; else delete process.env[k];
  }
}
setEnv(true);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    _resetRateLimit();
    await fn();
    passed++;
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}\n`, err);
  }
}

// --- fake Supabase -------------------------------------------------------
let remote = { state: null, updated_at: null };
let patches = 0;
let stray = [];
let conflictPlan = []; // queue of functions run on PATCH; return true → force conflict
function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith(ENV.SUPABASE_URL) || !/budget_states/.test(u)) {
    stray.push(u);
    throw new Error(`stray fetch ${u}`);
  }
  const method = String(opts.method || 'GET').toUpperCase();
  if (method === 'GET') {
    return jsonRes(200, remote.state ? [{ state: structuredClone(remote.state), updated_at: remote.updated_at }] : []);
  }
  if (method === 'PATCH') {
    patches++;
    const hook = conflictPlan.shift();
    if (hook && hook()) return jsonRes(200, []); // updated_at filter matched nothing
    const m = u.match(/updated_at=eq\.([^&]+)/);
    if (m && decodeURIComponent(m[1]) !== remote.updated_at) return jsonRes(200, []);
    const payload = JSON.parse(opts.body);
    remote = { state: payload.state, updated_at: payload.updated_at };
    return jsonRes(200, [{ updated_at: remote.updated_at }]);
  }
  return new Response('nope', { status: 405 });
};

// --- fake budget -----------------------------------------------------------
const base = createDefaultState();
const catId = name => base.categories.find(c => c.name === name).id;
const GROC = catId('Groceries');
const HOUSE = catId('Household / Misc');
const GAS = catId('Gas & Transportation');

function tx(id, date, amount, description, extra = {}) {
  return { id, date, amount, type: 'expense', description, categoryId: null, clearingStatus: 'cleared', ...extra };
}
function seed(transactions, extra = {}) {
  const s = structuredClone(base);
  s.setupComplete = true;
  s.balances.checking = 1234.56;
  s.transactions = transactions;
  Object.assign(s, extra);
  remote = { state: s, updated_at: '2026-10-09T12:00:00.000Z' };
  patches = 0;
  conflictPlan = [];
}
const remoteTx = id => remote.state.transactions.find(t => t.id === id);

async function call(body, { token = TOKEN, headers = {}, method = 'POST', raw } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await handler(new Request('http://localhost/api/transactions/split', {
    method, headers: h, body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
  }));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const SAMS = () => tx('t-sams', '2026-10-05', 120.0, 'SAMS CLUB #0000 FAKETOWN', { externalId: 'fake-ext-sams' });
const OTHER = () => tx('t-gas', '2026-10-05', 40.0, 'FAKE FUEL STOP', { categoryId: GAS });
const okBody = (over = {}) => ({
  match: { date: '2026-10-06', amount: -120.0, merchant: 'Sams Club' },
  splits: [{ envelope: 'Groceries', amount: 80.0 }, { envelope: 'Household / Misc', amount: 40.0 }],
  receiptId: 'rcpt-fake-001',
  memo: 'Fake receipt',
  ...over,
});

// --- security / validation -----------------------------------------------
await test('fails closed (503) when the token env is unset', async () => {
  seed([SAMS()]);
  delete process.env.FIGPIG_TX_SPLIT_TOKEN;
  const r = await call(okBody());
  process.env.FIGPIG_TX_SPLIT_TOKEN = TOKEN;
  assert.equal(r.status, 503);
  assert.equal(patches, 0);
});
await test('fails closed (503) when Supabase env is unset', async () => {
  setEnv(false); process.env.FIGPIG_TX_SPLIT_TOKEN = TOKEN;
  const r = await call(okBody());
  setEnv(true);
  assert.equal(r.status, 503);
});
await test('401 on missing / wrong / prefix token', async () => {
  seed([SAMS()]);
  assert.equal((await call(okBody(), { token: '' })).status, 401);
  assert.equal((await call(okBody(), { token: 'wrong' })).status, 401);
  assert.equal((await call(okBody(), { token: TOKEN.slice(0, -1) })).status, 401);
  assert.equal((await call(okBody(), { token: TOKEN + 'x' })).status, 401);
  assert.equal(patches, 0);
  assert.equal(secretsMatch(TOKEN, TOKEN), true);
  assert.equal(secretsMatch('', TOKEN), false);
});
await test('alternate header x-figpig-tx-split-token works', async () => {
  seed([SAMS()]);
  const r = await call(okBody({ dryRun: true }), { token: '', headers: { 'x-figpig-tx-split-token': TOKEN } });
  assert.equal(r.status, 200, r.text);
});
await test('rate limit 429 (counted before auth)', async () => {
  seed([SAMS()]);
  let last;
  for (let i = 0; i < 21; i++) last = await call(okBody(), { token: 'wrong' });
  assert.equal(last.status, 429);
});
await test('405 non-POST, 415 non-JSON, 400 bad JSON, 413 huge body', async () => {
  assert.equal((await call(null, { method: 'GET' })).status, 405);
  assert.equal((await call(okBody(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(null, { raw: '{nope' })).status, 400);
  assert.equal((await call(null, { raw: JSON.stringify({ memo: 'x'.repeat(70000) }) })).status, 413);
});
await test('strict body validation', async () => {
  const bad = [
    { ...okBody(), extra: 1 },
    okBody({ receiptId: 'has space' }),
    okBody({ receiptId: '<script>' }),
    okBody({ splits: [] }),
    okBody({ splits: [{ envelope: 'Groceries', amount: 80.005 }, { envelope: 'Household / Misc', amount: 40 }] }),
    okBody({ splits: [{ envelope: 'Groceries', amount: -80 }, { envelope: 'Household / Misc', amount: 200 }] }),
    okBody({ splits: [{ envelope: 'Groceries', amount: 80, categoryId: 'x' }, { envelope: 'Household / Misc', amount: 40 }] }),
    okBody({ match: { date: '2026-10-06', amount: -120 } }),
    okBody({ match: { date: '2026-13-45', amount: -120, merchant: 'x' } }),
    okBody({ match: { externalId: 'a', id: 't-sams' } }),
    okBody({ memo: 'x'.repeat(201) }),
    okBody({ dryRun: 'yes' }),
    { review: true, receipt: { receiptId: 'r1', store: 'S', date: '2026-10-06', total: 10, proposedSplits: [], status: 'applied' } },
    { review: true, receipt: { receiptId: 'r1', store: 'S', date: '2026-10-06', total: 10, proposedSplits: [], candidates: ['t-sams'] } },
    { review: false, ...okBody() },
  ];
  for (const b of bad) {
    const v = validateSplitBody(b);
    assert.equal(v.ok, false, `should reject ${JSON.stringify(b).slice(0, 120)}`);
  }
  seed([SAMS()]);
  const r = await call({ ...okBody(), extra: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'invalid_body');
  assert.equal(patches, 0);
});

// --- apply ------------------------------------------------------------------
await test('applies split; amount and checking untouched; response trimmed', async () => {
  seed([SAMS(), OTHER()]);
  const beforeOther = structuredClone(remoteTx('t-gas'));
  const r = await call(okBody());
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['candidate', 'memoSet', 'ok', 'receiptId', 'splits', 'status']);
  assert.equal(r.json.status, 'applied');
  assert.deepEqual(r.json.candidate, { id: 't-sams', date: '2026-10-05', amount: 120, description: 'SAMS CLUB #0000 FAKETOWN' });
  assert.deepEqual(r.json.splits, [{ envelope: 'Groceries', amount: 80 }, { envelope: 'Household / Misc', amount: 40 }]);
  assert.ok(!/checking|balances|transactions|service/i.test(r.text), 'no other state in response');
  const t = remoteTx('t-sams');
  assert.equal(t.amount, 120);
  assert.equal(remote.state.balances.checking, 1234.56, 'checking unchanged');
  assert.deepEqual(t.splits, [{ categoryId: GROC, amount: 80 }, { categoryId: HOUSE, amount: 40 }]);
  assert.equal(t.categoryId, null);
  assert.equal(t.receiptId, 'rcpt-fake-001');
  assert.equal(t.categorySource, 'receipt');
  assert.equal(t.memo, 'Fake receipt');
  const afterOther = remoteTx('t-gas');
  for (const k of ['amount', 'categoryId', 'description', 'date']) assert.equal(afterOther[k], beforeOther[k]);
  assert.equal(patches, 1);
});
await test('idempotent receiptId: second call is a no-op (no write)', async () => {
  seed([SAMS()]);
  await call(okBody());
  const snap = JSON.stringify(remote.state.transactions);
  const p = patches;
  const r = await call(okBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'unchanged');
  assert.equal(patches, p, 'no extra save');
  assert.equal(JSON.stringify(remote.state.transactions), snap);
  // Different splits with the same receiptId still no-op (never re-split)
  const r2 = await call(okBody({ splits: [{ envelope: 'Groceries', amount: 60 }, { envelope: 'Household / Misc', amount: 60 }] }));
  assert.equal(r2.json.status, 'unchanged');
  assert.equal(remoteTx('t-sams').splits[0].amount, 80);
});
await test('memo kept when the transaction already has one', async () => {
  seed([{ ...SAMS(), memo: 'linked note text' }]);
  const r = await call(okBody());
  assert.equal(r.json.memoSet, false);
  assert.equal(remoteTx('t-sams').memo, 'linked note text');
});

// --- sums / rounding ----------------------------------------------------------
await test('sum validation: off by 5¢ → sum_mismatch, nothing written', async () => {
  seed([SAMS()]);
  const r = await call(okBody({ splits: [{ envelope: 'Groceries', amount: 80.05 }, { envelope: 'Household / Misc', amount: 40 }] }));
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'sum_mismatch');
  assert.equal(r.json.bankAmount, 120);
  assert.equal(r.json.splitsTotal, 120.05);
  assert.equal(patches, 0);
  assert.equal(remoteTx('t-sams').splits, undefined);
});
await test('rounding: 1¢ gap absorbed by the largest split; stored sum is exact', async () => {
  seed([SAMS()]);
  const r = await call(okBody({ splits: [{ envelope: 'Groceries', amount: 79.99 }, { envelope: 'Household / Misc', amount: 40 }] }));
  assert.equal(r.status, 200, r.text);
  const t = remoteTx('t-sams');
  assert.deepEqual(t.splits.map(s => s.amount), [80, 40]);
  const cents = t.splits.reduce((s, x) => s + Math.round(x.amount * 100), 0);
  assert.equal(cents, 12000);
});
await test('rounding: float sums done in cents (0.10 + 0.20 style)', async () => {
  seed([tx('t-f', '2026-10-05', 30.3, 'FAKE MART', { externalId: 'fake-f' })]);
  const r = await call({
    match: { externalId: 'fake-f' },
    splits: [{ envelope: 'Groceries', amount: 10.1 }, { envelope: 'Household / Misc', amount: 20.2 }],
    receiptId: 'rcpt-float',
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(remoteTx('t-f').splits.map(s => s.amount), [10.1, 20.2]);
  assert.equal(toCents(0.1 + 0.2), 30);
  const rec = reconcileSplitCents([{ categoryId: 'a', cents: 3333 }, { categoryId: 'b', cents: 3333 }, { categoryId: 'c', cents: 3333 }], 10000);
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.value.map(l => l.cents), [3334, 3333, 3333]);
  assert.equal(reconcileSplitCents([{ categoryId: 'a', cents: 5000 }, { categoryId: 'b', cents: 4998 }], 10000).ok, false);
});
await test('repeated envelope lines are merged; single envelope refused', async () => {
  seed([SAMS()]);
  const one = await call(okBody({ splits: [{ envelope: 'Groceries', amount: 100 }, { envelope: 'groceries', amount: 20 }] }));
  assert.equal(one.status, 422);
  assert.equal(one.json.error, 'invalid_splits');
  const unk = await call(okBody({ splits: [{ envelope: 'Not An Envelope', amount: 100 }, { envelope: 'Groceries', amount: 20 }] }));
  assert.equal(unk.json.error, 'unknown_envelope');
  assert.equal(patches, 0);
});

// --- matching -----------------------------------------------------------------
await test('ambiguity refusal: two fitting rows → multiple_matches, no write', async () => {
  seed([
    tx('w1', '2026-10-04', 55.12, 'WALMART SUPERCENTER #1'),
    tx('w2', '2026-10-06', 55.13, 'WAL-MART #2'),
  ]);
  const r = await call({
    match: { date: '2026-10-05', amount: 55.12, merchant: 'Walmart' },
    splits: [{ envelope: 'Groceries', amount: 30 }, { envelope: 'Household / Misc', amount: 25.12 }],
    receiptId: 'rcpt-amb',
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'multiple_matches');
  assert.equal(r.json.count, 2);
  assert.ok(!('candidate' in r.json));
  assert.equal(patches, 0);
});
await test('externalId wins over an ambiguous fuzzy match', async () => {
  seed([
    tx('w1', '2026-10-04', 55.12, 'WALMART SUPERCENTER #1', { externalId: 'fake-w1' }),
    tx('w2', '2026-10-06', 55.12, 'WAL-MART #2', { externalId: 'fake-w2' }),
  ]);
  const r = await call({
    match: { externalId: 'fake-w2', date: '2026-10-05', amount: 55.12, merchant: 'Walmart' },
    splits: [{ envelope: 'Groceries', amount: 30 }, { envelope: 'Household / Misc', amount: 25.12 }],
    receiptId: 'rcpt-ext',
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.candidate.id, 'w2');
});
await test('no_match: amount off by 4¢, date off by 4 days, weak merchant, or income', async () => {
  for (const t of [
    tx('a', '2026-10-05', 120.04, 'SAMS CLUB'),
    tx('b', '2026-10-10', 120, 'SAMS CLUB'),
    tx('c', '2026-10-05', 120, 'FAKE HARDWARE BARN'),
    { ...tx('d', '2026-10-05', 120, 'SAMS CLUB'), type: 'income' },
  ]) {
    seed([t]);
    const r = await call(okBody());
    assert.equal(r.status, 404, `${t.id}: ${r.text}`);
    assert.equal(r.json.error, 'no_match');
  }
  // Edge: +3 days, +3¢ still MATCHES, but splits must equal the bank amount → sum_mismatch, not no_match
  seed([tx('e', '2026-10-09', 120.03, 'SAMS CLUB')]);
  const edge = await call(okBody({ dryRun: true }));
  assert.equal(edge.json.error, 'sum_mismatch');
  assert.equal(edge.json.bankAmount, 120.03);
  seed([tx('e', '2026-10-09', 120.01, 'SAMS CLUB')]); // 1¢ off: matches and penny is absorbed
  assert.equal((await call(okBody({ dryRun: true }))).status, 200);
});
await test('already_split (different receiptId) refused', async () => {
  seed([{ ...SAMS(), splits: [{ categoryId: GROC, amount: 60 }, { categoryId: HOUSE, amount: 60 }] }]);
  const r = await call(okBody());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'already_split');
});
await test('envelope guard: manual Gas refused; rule Gas, Groceries, Household, none allowed', async () => {
  seed([{ ...SAMS(), categoryId: GAS }]);
  let r = await call(okBody());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'category_conflict');
  for (const extra of [{ categoryId: GAS, categorySource: 'rule' }, { categoryId: GROC }, { categoryId: HOUSE }, { categoryId: null }]) {
    seed([{ ...SAMS(), ...extra }]);
    r = await call(okBody());
    assert.equal(r.status, 200, `${JSON.stringify(extra)} ${r.text}`);
  }
});
await test('dryRun returns candidate + proposal, writes nothing', async () => {
  seed([SAMS()]);
  const r = await call(okBody({ dryRun: true }));
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'dry_run');
  assert.equal(r.json.candidate.id, 't-sams');
  assert.equal(r.json.splits.length, 2);
  assert.equal(patches, 0);
  assert.equal(remoteTx('t-sams').splits, undefined);
});

// --- concurrency ------------------------------------------------------------------
await test('optimistic concurrency: conflict → reload, re-plan, one retry keeps the other write', async () => {
  seed([SAMS()]);
  conflictPlan = [() => {
    // Another writer saves first (e.g. bank sync adds a row)
    remote.state.transactions.push(tx('t-new', '2026-10-07', 9.99, 'FAKE OTHER WRITER'));
    remote.updated_at = '2026-10-09T12:00:05.000Z';
    return true;
  }];
  const r = await call(okBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'applied');
  assert.equal(patches, 2);
  assert.ok(remoteTx('t-new'), 'other writer row kept');
  assert.equal(remoteTx('t-sams').receiptId, 'rcpt-fake-001');
});
await test('optimistic concurrency: two conflicts → 409 conflict, exactly one retry', async () => {
  seed([SAMS()]);
  conflictPlan = [() => true, () => true];
  const r = await call(okBody());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'conflict');
  assert.equal(patches, 2);
  assert.equal(remoteTx('t-sams').splits, undefined);
});
await test('conflict where the other writer already applied the receipt → unchanged', async () => {
  seed([SAMS()]);
  conflictPlan = [() => {
    const t = remote.state.transactions.find(x => x.id === 't-sams');
    t.splits = [{ categoryId: GROC, amount: 80 }, { categoryId: HOUSE, amount: 40 }];
    t.receiptId = 'rcpt-fake-001';
    remote.updated_at = '2026-10-09T12:00:06.000Z';
    return true;
  }];
  const r = await call(okBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'unchanged');
  assert.equal(patches, 1);
});
await test('409 no_budget when cloud row is missing', async () => {
  remote = { state: null, updated_at: null };
  const r = await call(okBody());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'no_budget');
});

// --- review queue --------------------------------------------------------------------
const reviewBody = (over = {}) => ({
  review: true,
  receipt: {
    receiptId: 'rcpt-review-1',
    store: "Sam's Club",
    date: '2026-10-06',
    total: 120,
    proposedSplits: [{ envelope: 'Groceries', amount: 80 }, { envelope: 'Household / Misc', amount: 40 }],
    items: [
      { desc: 'Fake bananas', amount: 50, bucket: 'Groceries', confidence: 0.9 },
      { desc: 'Fake milk', amount: 25, bucket: 'Groceries', confidence: 0.95 },
      { desc: 'Fake paper towels', amount: 37.5, bucket: 'Household / Misc', confidence: 0.6 },
    ],
    reason: 'low_confidence',
    ...over,
  },
});
await test('review: queue, refresh, dryRun; candidates computed server-side', async () => {
  seed([tx('t-s2', '2026-10-05', 120, 'SAMSCLUB #0000'), tx('t-s3', '2026-10-07', 120.02, 'SAMS CLUB FAKE')]);
  const dry = await call({ ...reviewBody(), dryRun: true });
  assert.equal(dry.json.status, 'dry_run');
  assert.equal(patches, 0);
  let r = await call(reviewBody());
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json, { ok: true, status: 'queued', receiptId: 'rcpt-review-1', candidates: 2, pending: 1 });
  const item = remote.state.receiptReview[0];
  assert.equal(item.status, 'pending');
  assert.deepEqual(item.candidates.sort(), ['t-s2', 't-s3']);
  assert.equal(item.items[2].bucket, HOUSE);
  assert.equal(remote.state.balances.checking, 1234.56);
  r = await call(reviewBody({ reason: 'multiple_matches' }));
  assert.equal(r.json.status, 'updated');
  assert.equal(remote.state.receiptReview.length, 1);
  assert.equal(remote.state.receiptReview[0].reason, 'multiple_matches');
});
await test('review: proposedSplits must equal total; unknown bucket refused', async () => {
  seed([]);
  let r = await call(reviewBody({ total: 130 }));
  assert.equal(r.json.error, 'sum_mismatch');
  r = await call(reviewBody({ items: [{ desc: 'x', amount: 1, bucket: 'Nope' }] }));
  assert.equal(r.json.error, 'unknown_envelope');
  assert.equal(patches, 0);
});
await test('review UI path: approve applies split, checking unchanged; idempotent after', async () => {
  seed([tx('t-s2', '2026-10-05', 120, 'SAMSCLUB #0000'), tx('t-s3', '2026-10-07', 120.02, 'SAMS CLUB FAKE')]);
  await call(reviewBody());
  store.hydrateFromObject(structuredClone(remote.state));
  const list = store.getReceiptReview();
  assert.equal(list.length, 1);
  assert.equal(list[0].candidates.length, 2);
  assert.equal(store.getReceiptReviewCount(), 1);
  const checking = store.getState().balances.checking;
  // Approve on the 120.02 row: proposed 120.00 → 2¢ off → sum_mismatch, nothing changes
  let res = store.approveReceiptReview('rcpt-review-1', 't-s3', null, { persist: false });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'sum_mismatch');
  res = store.approveReceiptReview('rcpt-review-1', 't-s2', null, { persist: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  const t = store.getState().transactions.find(x => x.id === 't-s2');
  assert.equal(t.amount, 120);
  assert.equal(t.receiptId, 'rcpt-review-1');
  assert.equal(t.memo, "Receipt: Sam's Club");
  assert.equal(store.getState().balances.checking, checking);
  assert.equal(store.getState().receiptReview[0].status, 'applied');
  assert.equal(store.getReceiptReview().length, 0);
  res = store.approveReceiptReview('rcpt-review-1', 't-s3', null, { persist: false });
  assert.equal(res.ok, false);
});
await test('review: re-posting an applied or dismissed receipt is a no-op', async () => {
  seed([tx('t-s2', '2026-10-05', 120, 'SAMSCLUB #0000')]);
  await call(reviewBody());
  store.hydrateFromObject(structuredClone(remote.state));
  store.dismissReceiptReview('rcpt-review-1', { persist: false });
  assert.equal(store.getReceiptReview().length, 0);
  remote.state = structuredClone(store.getState());
  const r = await call(reviewBody());
  assert.equal(r.json.status, 'unchanged');
});
await test('Edit buckets: tax spread by share, sums to the receipt total exactly', async () => {
  const item = { total: 120, items: [{ amount: 50, bucket: GROC }, { amount: 25, bucket: GROC }, { amount: 37.5, bucket: HOUSE }] };
  let r = splitsFromItemBuckets(item, [GROC, GROC, HOUSE]);
  assert.equal(r.ok, true);
  assert.equal(r.value.reduce((s, l) => s + l.cents, 0), 12000);
  assert.deepEqual(r.value, [{ categoryId: GROC, cents: 8000 }, { categoryId: HOUSE, cents: 4000 }]);
  r = splitsFromItemBuckets(item, [GROC, HOUSE, HOUSE]); // move milk to Household
  assert.deepEqual(r.value, [{ categoryId: GROC, cents: 5333 }, { categoryId: HOUSE, cents: 6667 }]);
  assert.equal(splitsFromItemBuckets(item, [GROC, GROC, GROC]).ok, false, 'one bucket is not a split');
});
await test('categorySource: rules tag it, manual edits clear it', async () => {
  const t = { type: 'expense', amount: 10, description: 'x' };
  applyRuleToTransaction(t, { categoryId: GAS });
  assert.equal(t.categorySource, 'rule');
  seed([{ ...SAMS(), categoryId: GAS, categorySource: 'rule' }]);
  store.hydrateFromObject(structuredClone(remote.state));
  store.updateTransaction('t-sams', { memo: 'only memo' }, { persist: false });
  assert.equal(store.getState().transactions[0].categorySource, 'rule');
  store.updateTransaction('t-sams', { categoryId: GAS, splits: [] }, { persist: false });
  assert.equal(store.getState().transactions[0].categorySource, undefined);
});
await test('sanitizeReceiptReview drops junk and unknown keys', async () => {
  const out = sanitizeReceiptReview([
    null, { receiptId: 'bad id' },
    { receiptId: 'ok-1', store: 'S\u202eX', total: 'x', status: 'weird', evil: 1, items: [{ desc: 'a', amount: 1, bucket: 'b', html: '<b>' }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'pending');
  assert.equal(out[0].total, 0);
  assert.ok(!('evil' in out[0]));
  assert.ok(!('html' in out[0].items[0]));
  assert.ok(!/\u202e/.test(out[0].store));
});

assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`receipt-split: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
