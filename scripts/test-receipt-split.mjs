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
    const out = hook ? hook() : false;
    if (out instanceof Response) return out; // upstream failure (5xx / 4xx)
    if (out) return jsonRes(200, []); // updated_at filter matched nothing
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
  assert.match(remoteTx('t-sams').receiptFingerprint, /^t-sams\|/);
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
  assert.equal(reconcileSplitCents([{ categoryId: 'a', cents: 5000 }, { categoryId: 'b', cents: 4996 }], 10000).ok, false);
  const two = reconcileSplitCents([{ categoryId: 'a', cents: 5000 }, { categoryId: 'b', cents: 4998 }], 10000);
  assert.deepEqual([two.adjustedCents, two.adjustedCategoryId, two.value[0].cents], [2, 'a', 5002]);
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
  // Edge: +3 days, +3¢ still matches AND can be applied (3¢ goes on the largest split)
  seed([tx('e', '2026-10-09', 120.03, 'SAMS CLUB')]);
  const edge = await call(okBody({ dryRun: true }));
  assert.equal(edge.status, 200, edge.text);
  assert.equal(edge.json.status, 'dry_run');
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
  // The 120.02 row is listed, so it must be approvable: preview shows +2¢ on Groceries
  const pre = store.previewReceiptReview('rcpt-review-1', 't-s3');
  assert.equal(pre.ok, true, JSON.stringify(pre));
  assert.equal(pre.adjustedCents, 2);
  assert.equal(pre.adjustedCategoryId, GROC);
  let res = store.approveReceiptReview('rcpt-review-1', 't-s2', null, { persist: false });
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
  store.updateTransaction('t-sams', { categoryId: HOUSE, splits: [] }, { persist: false });
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

// --- Fix 1: ≤3¢ bank gap goes on the largest split (API + review agree) -----------
await test('fix1 API: $120.00 receipt vs $120.03 bank row → applied, +3¢ on Groceries', async () => {
  seed([tx('t-3c', '2026-10-05', 120.03, 'SAMS CLUB #0000 FAKETOWN')]);
  const r = await call(okBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'applied');
  assert.deepEqual(r.json.adjustment, { envelope: 'Groceries', amount: 0.03, note: '+3¢ on Groceries to match bank' });
  assert.deepEqual(remoteTx('t-3c').splits.map(x => x.amount), [80.03, 40]);
  assert.equal(remoteTx('t-3c').amount, 120.03);
  assert.equal(remote.state.balances.checking, 1234.56);
});
await test('fix1 API: $119.97 bank row → −3¢; 4¢ gap still sum_mismatch', async () => {
  seed([tx('t-m3', '2026-10-05', 119.97, 'SAMS CLUB #0000 FAKETOWN')]);
  let r = await call(okBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.adjustment.amount, -0.03);
  assert.equal(r.json.adjustment.note, '\u22123¢ on Groceries to match bank');
  assert.deepEqual(remoteTx('t-m3').splits.map(x => x.amount), [79.97, 40]);
  seed([tx('t-4c', '2026-10-05', 120.03, 'SAMS CLUB')]);
  r = await call(okBody({ splits: [{ envelope: 'Groceries', amount: 79.99 }, { envelope: 'Household / Misc', amount: 40 }] }));
  assert.equal(r.status, 422);
  assert.equal(r.json.error, 'sum_mismatch');
  r = await call(okBody());
  assert.equal(r.status, 200, 'no adjustment field when exact');
  seed([SAMS()]);
  r = await call(okBody());
  assert.ok(!('adjustment' in r.json));
});
await test('fix1 review: $120.00 receipt vs $120.03 row → listed, preview +3¢, Approve sums exactly', async () => {
  seed([tx('t-r3', '2026-10-06', 120.03, 'SAMS CLUB #0000')]);
  const q = await call(reviewBody({ receiptId: 'rcpt-3c' }));
  assert.equal(q.json.candidates, 1);
  store.hydrateFromObject(structuredClone(remote.state));
  assert.equal(store.getReceiptReview()[0].candidates[0].id, 't-r3');
  const pre = store.previewReceiptReview('rcpt-3c', 't-r3');
  assert.equal(pre.adjustedCents, 3);
  assert.equal(pre.adjustedCategoryId, GROC);
  const res = store.approveReceiptReview('rcpt-3c', 't-r3', null, { persist: false });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.adjustedCents, 3);
  const t = store.getState().transactions.find(x => x.id === 't-r3');
  assert.deepEqual(t.splits.map(x => x.amount), [80.03, 40]);
  assert.equal(t.splits.reduce((s2, x) => s2 + Math.round(x.amount * 100), 0), 12003);
  // Edit path too: tax-spread buckets then the same 3¢ nudge
  seed([tx('t-r4', '2026-10-06', 120.03, 'SAMS CLUB #0000')]);
  await call(reviewBody({ receiptId: 'rcpt-3d' }));
  store.hydrateFromObject(structuredClone(remote.state));
  const item = store.getState().receiptReview[0];
  const edited = splitsFromItemBuckets(item, [GROC, HOUSE, HOUSE]);
  const res2 = store.approveReceiptReview('rcpt-3d', 't-r4', edited.value, { persist: false });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  const t2 = store.getState().transactions.find(x => x.id === 't-r4');
  assert.equal(t2.splits.reduce((s2, x) => s2 + Math.round(x.amount * 100), 0), 12003);
});

// --- Fix 2: receiptId fingerprint --------------------------------------------------------
await test('fix2: same receiptId + same row + same cents → unchanged; other splits → receipt_conflict', async () => {
  seed([SAMS()]);
  await call(okBody());
  assert.equal(remoteTx('t-sams').receiptFingerprint, `t-sams|${[`${GROC}=8000`, `${HOUSE}=4000`].sort().join(',')}`);
  const p = patches;
  const same = await call(okBody());
  assert.equal(same.json.status, 'unchanged');
  const sameByExt = await call(okBody({ match: { externalId: 'fake-ext-sams' } }));
  assert.equal(sameByExt.json.status, 'unchanged');
  const other = await call(okBody({ splits: [{ envelope: 'Groceries', amount: 60 }, { envelope: 'Household / Misc', amount: 60 }] }));
  assert.equal(other.status, 409);
  assert.equal(other.json.error, 'receipt_conflict');
  const swapped = await call(okBody({ splits: [{ envelope: 'Groceries', amount: 40 }, { envelope: 'Household / Misc', amount: 80 }] }));
  assert.equal(swapped.json.error, 'receipt_conflict');
  const unknown = await call(okBody({ splits: [{ envelope: 'Nope', amount: 60 }, { envelope: 'Groceries', amount: 60 }] }));
  assert.equal(unknown.json.error, 'receipt_conflict');
  assert.equal(patches, p, 'no writes');
  assert.equal(remoteTx('t-sams').splits[0].amount, 80);
});
await test('fix2: same receiptId aimed at a different row → receipt_conflict', async () => {
  seed([SAMS(), tx('t-sams2', '2026-09-20', 75, 'SAMS CLUB #0000 FAKETOWN', { externalId: 'fake-ext-2' })]);
  await call(okBody());
  const p = patches;
  let r = await call(okBody({
    match: { externalId: 'fake-ext-2' },
    splits: [{ envelope: 'Groceries', amount: 50 }, { envelope: 'Household / Misc', amount: 25 }],
  }));
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'receipt_conflict');
  r = await call(okBody({ match: { date: '2026-09-20', amount: -120, merchant: 'Sams Club' } }));
  assert.equal(r.json.error, 'receipt_conflict', 'fuzzy match no longer fits the stored row');
  assert.equal(patches, p);
  assert.equal(remoteTx('t-sams2').splits, undefined);
});

// --- Fix 3: user removed / changed the split ------------------------------------------------------
await test('fix3: split removed by the user → removed_by_user, not re-applied', async () => {
  seed([SAMS()]);
  await call(okBody());
  store.hydrateFromObject(structuredClone(remote.state));
  // Log-form shape: pick a single envelope again
  store.updateTransaction('t-sams', { categoryId: GROC, splits: [], memo: 'Fake receipt' }, { persist: false });
  remote.state = structuredClone(store.getState());
  const p = patches;
  const r = await call(okBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'removed_by_user');
  assert.deepEqual(r.json.splits, []);
  assert.equal(patches, p);
  assert.equal(remoteTx('t-sams').splits, undefined);
  assert.equal(remoteTx('t-sams').categoryId, GROC);
});
await test('fix3: split changed by the user → changed_by_user, not re-applied', async () => {
  seed([SAMS()]);
  await call(okBody());
  store.hydrateFromObject(structuredClone(remote.state));
  store.updateTransaction('t-sams', { splits: [{ categoryId: GROC, amount: 100 }, { categoryId: HOUSE, amount: 20 }] }, { persist: false });
  remote.state = structuredClone(store.getState());
  const p = patches;
  const r = await call(okBody());
  assert.equal(r.json.status, 'changed_by_user');
  assert.equal(patches, p);
  assert.equal(remoteTx('t-sams').splits[0].amount, 100);
});

// --- Fix 4: upstream failures are not conflicts ---------------------------------------------------
await test('fix4: Supabase 5xx on save → 502 upstream_error, no retry', async () => {
  seed([SAMS()]);
  conflictPlan = [() => jsonRes(503, { message: 'fake outage' })];
  const r = await call(okBody());
  assert.equal(r.status, 502, r.text);
  assert.equal(r.json.error, 'upstream_error');
  assert.equal(patches, 1);
  assert.equal(remoteTx('t-sams').splits, undefined);
});
await test('fix4: 4xx on save and 5xx on the retry save → 502; real mismatch still 409', async () => {
  seed([SAMS()]);
  conflictPlan = [() => jsonRes(400, { message: 'fake bad request' })];
  let r = await call(okBody());
  assert.equal(r.status, 502);
  seed([SAMS()]);
  conflictPlan = [() => true, () => jsonRes(500, {})];
  r = await call(okBody());
  assert.equal(r.status, 502);
  assert.equal(r.json.error, 'upstream_error');
  assert.equal(patches, 2);
  seed([SAMS()]);
  conflictPlan = [() => true, () => true];
  r = await call(okBody());
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'conflict');
});

// --- Fix 5: Approve only on a listed candidate ------------------------------------------------------
await test('fix5: approve refuses a row that is not a candidate', async () => {
  seed([tx('t-s2', '2026-10-05', 120, 'SAMSCLUB #0000'), tx('t-far', '2026-08-01', 120, 'FAKE OTHER STORE')]);
  await call(reviewBody());
  store.hydrateFromObject(structuredClone(remote.state));
  const before = JSON.stringify(store.getState().transactions);
  for (const id of ['t-far', 'no-such-id']) {
    const res = store.approveReceiptReview('rcpt-review-1', id, null, { persist: false });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'not_a_candidate');
  }
  assert.equal(JSON.stringify(store.getState().transactions), before);
  assert.equal(store.getState().receiptReview[0].status, 'pending');
  assert.equal(store.approveReceiptReview('rcpt-review-1', 't-s2', null, { persist: false }).ok, true);
});

// --- Fix 6: categorySource survives memo-only Log saves ---------------------------------------------
await test('fix6: Log-form memo-only save keeps rule tag; envelope/split change clears it', async () => {
  seed([{ ...SAMS(), categoryId: GAS, categorySource: 'rule' }]);
  store.hydrateFromObject(structuredClone(remote.state));
  const formSave = extra => store.updateTransaction('t-sams', {
    date: '2026-10-05', amount: 120, type: 'expense', description: 'SAMS CLUB #0000 FAKETOWN',
    memo: 'edited memo', clearingStatus: 'cleared', categoryId: GAS, splits: [], ...extra,
  }, { persist: false });
  formSave();
  const t = () => store.getState().transactions[0];
  assert.equal(t().memo, 'edited memo');
  assert.equal(t().categorySource, 'rule', 'memo-only edit keeps rule tag');
  formSave({ categoryId: HOUSE });
  assert.equal(t().categorySource, undefined, 'envelope change clears it');
  // split change clears it too
  seed([{ ...SAMS(), categoryId: GAS, categorySource: 'rule' }]);
  store.hydrateFromObject(structuredClone(remote.state));
  store.updateTransaction('t-sams', { splits: [{ categoryId: GROC, amount: 60 }, { categoryId: HOUSE, amount: 60 }] }, { persist: false });
  assert.equal(t().categorySource, undefined);
  // re-saving identical splits keeps a receipt tag
  store.updateTransaction('t-sams', { categorySource: 'receipt' }, { persist: false });
  store.updateTransaction('t-sams', { splits: [{ categoryId: GROC, amount: 60 }, { categoryId: HOUSE, amount: 60 }], memo: 'x' }, { persist: false });
  assert.equal(t().categorySource, 'receipt');
});

assert.deepEqual(stray, [], 'no network calls outside the fake Supabase');
console.log(`receipt-split: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
