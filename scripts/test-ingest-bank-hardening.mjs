// Fake data only: tokens, URLs and IDs below are test fixtures.
import assert from 'node:assert/strict';

const TOKEN = 'test-ingest-token-0123456789abcdef-FAKE';
process.env.FIGPIG_INGEST_SECRET = TOKEN;
process.env.SUPABASE_URL = 'https://fake-project.supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.FIGPIG_OWNER_USER_ID = '00000000-0000-0000-0000-000000000000';

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || 'GET' });
  return new Response(JSON.stringify([{ id: 'fake-inbox-1', created_at: '2026-01-01T00:00:00Z' }]), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
};

const mod = await import('../netlify/functions/ingest-bank.mjs');
const handler = mod.default;
let passed = 0;
const ok = (name) => { passed += 1; console.log('  ok', name); };

let ipSeq = 0;
function req({ token = TOKEN, body, ip, method = 'POST', ctype = 'application/json' } = {}) {
  const headers = { 'x-nf-client-connection-ip': ip || `10.0.0.${++ipSeq}` };
  if (token != null) headers.authorization = `Bearer ${token}`;
  if (ctype) headers['content-type'] = ctype;
  return new Request('http://localhost/api/ingest-bank', {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body ?? validBody())) : undefined,
  });
}
function validBody() {
  return {
    source: 'test',
    apply: false,
    transactions: [{ date: '2026-01-02', amount: -12.34, description: 'FAKE COFFEE', id: 'fake-1' }],
  };
}

mod._resetRateLimit();

// Valid request still passes
let r = await handler(req());
assert.equal(r.status, 200);
assert.equal((await r.json()).count, 1);
assert.ok(calls.some((c) => c.url.includes('/rest/v1/import_inbox') && c.method === 'POST'));
ok('valid request -> 200 and inbox insert');

// Auth failures
for (const [name, token] of [
  ['missing token', null],
  ['short token', 'short'],
  ['wrong token same length', TOKEN.replace(/.$/, 'X')],
  ['wrong token longer', TOKEN + 'extra'],
  ['token prefix', TOKEN.slice(0, 32)],
]) {
  const before = calls.length;
  r = await handler(req({ token }));
  assert.equal(r.status, 401, name);
  assert.equal(calls.length, before, `${name}: no Supabase call`);
  ok(`401 on ${name}`);
}

// Rate limit: burst from one IP; limiter runs before auth
mod._resetRateLimit();
const statuses = [];
for (let i = 0; i < 35; i++) statuses.push((await handler(req({ ip: '192.0.2.9', token: 'bad' }))).status);
assert.equal(statuses.filter((s) => s === 401).length, 30);
assert.equal(statuses.slice(30).every((s) => s === 429), true);
r = await handler(req({ ip: '192.0.2.9' }));
assert.equal(r.status, 429, 'valid token still limited once over');
ok('429 on burst (checked before auth)');
r = await handler(req({ ip: '192.0.2.10' }));
assert.equal(r.status, 200);
ok('other IP unaffected');

// Input validation fails closed
const bad = [
  ['array body', []],
  ['unknown field', { ...validBody(), owner: 'x' }],
  ['transactions not array', { transactions: 'nope' }],
  ['empty transactions', { transactions: [] }],
  ['non-object row', { transactions: [1] }],
  ['too many rows', { transactions: Array.from({ length: 201 }, (_, i) => ({ date: '2026-01-02', amount: -1, id: `f${i}` })) }],
  ['source not string', { ...validBody(), source: { a: 1 } }],
  ['apply not boolean', { ...validBody(), apply: 'false' }],
  ['both transactions and rows', { ...validBody(), rows: [] }],
  ['no valid rows after normalize', { transactions: [{ foo: 'bar' }] }],
];
for (const [name, body] of bad) {
  r = await handler(req({ body }));
  assert.equal(r.status, 400, name);
  ok(`400 on ${name}`);
}
r = await handler(req({ body: '{not json' }));
assert.equal(r.status, 400); ok('400 on malformed JSON');
r = await handler(req({ ctype: 'text/plain' }));
assert.equal(r.status, 415); ok('415 on non-JSON content-type');
r = await handler(req({ body: JSON.stringify({ ...validBody(), note: 'x'.repeat(300 * 1024) }) }));
assert.equal(r.status, 413); ok('413 on oversized body');
r = await handler(req({ method: 'GET' }));
assert.equal(r.status, 405); ok('405 on GET');

// Fail closed when the configured secret is too short
process.env.FIGPIG_INGEST_SECRET = 'short';
r = await handler(req({ token: 'short' }));
assert.equal(r.status, 503); ok('503 when configured secret is below minimum length');
process.env.FIGPIG_INGEST_SECRET = TOKEN;

console.log(`test-ingest-bank-hardening: ${passed} passed`);
