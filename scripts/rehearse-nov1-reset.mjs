/**
 * LOCAL rehearsal of the Nov 1 start-fresh against a read-only copy of GET /api/envelopes.
 * usage: FAKE_NOW=2026-11-01T12:00:00 TZ=America/New_York node scripts/rehearse-nov1-reset.mjs <copy-dir> [plan.json]
 * Never talks to the network: fetch is stubbed with an in-memory Supabase; any other URL throws.
 * The copy is GET output only, so Oct is rebuilt as one synthetic spend + one synthetic move per
 * envelope that reproduces the copy's Oct allocated/carry/spent/remaining exactly.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'env_oct.json'))) { console.error('need <copy-dir> with env_oct.json'); process.exit(2); }
const fakeNow = process.env.FAKE_NOW;
if (!fakeNow || Number.isNaN(Date.parse(fakeNow))) { console.error('FAKE_NOW (ISO) required'); process.exit(2); }
const RealDate = Date; const off = Date.parse(fakeNow) - RealDate.now();
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.now() + off])); } static now() { return RealDate.now() + off; } };

const TOKEN = 'local-rehearsal-write-token-000000'; const READ = 'local-rehearsal-read-token-0000000';
Object.assign(process.env, { FIGPIG_ENVELOPE_WRITE_TOKEN: TOKEN, FIGPIG_BILLS_READ_TOKEN: READ, SUPABASE_URL: 'https://local-copy.invalid', SUPABASE_SERVICE_ROLE_KEY: 'local', FIGPIG_OWNER_USER_ID: 'local' });
let remote = { state: null, updated_at: 't0' }; let n = 0;
globalThis.fetch = async (url, o = {}) => {
  if (!String(url).startsWith('https://local-copy.invalid/rest/v1/budget_states')) throw new Error('stray fetch blocked');
  const j = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  if ((o.method || 'GET') === 'GET') return j(200, [{ state: structuredClone(remote.state), updated_at: remote.updated_at }]);
  const m = String(url).match(/updated_at=eq\.([^&]+)/);
  if (m && decodeURIComponent(m[1]) !== remote.updated_at) return j(200, []);
  const p = JSON.parse(o.body); remote = { state: p.state, updated_at: `t${++n}` }; return j(200, [{ updated_at: remote.updated_at }]);
};
const { default: W, _resetRateLimit } = await import('../netlify/functions/envelopes-write.mjs');
const { default: R } = await import('../netlify/functions/envelopes.mjs');
const { createDefaultState } = await import('../js/defaults.js');
const { store } = await import('../js/store.js');

const oct = JSON.parse(fs.readFileSync(path.join(dir, 'env_oct.json'), 'utf8'));
if (oct.month !== '2026-10') throw new Error('copy must be the 2026-10 GET');
const s = createDefaultState();
const tops = new Map(oct.envelopes.filter(e => !e.group).map(e => [e.name, e.id]));
s.categories = oct.envelopes.map(e => ({ id: e.id, name: e.name, parentId: e.group ? tops.get(e.group) : undefined, isSinkingFund: !!e.sinkingFund, monthlyBudget: e.allocated, carryOver: e.carry, note: '' }));
s.transactions = []; s.monthEnvelopeMoves = { '2026-10': [] }; s.bills = []; s.debts = [];
for (const e of oct.envelopes) {
  if (e.spent) s.transactions.push({ id: `syn-${e.id}`, date: '2026-10-15', amount: e.spent, type: 'expense', description: 'synthetic', categoryId: e.id, clearingStatus: 'cleared' });
  const mv = Math.round((e.remaining - (e.allocated + e.carry - e.spent)) * 100) / 100;
  if (mv) s.monthEnvelopeMoves['2026-10'].push({ id: `synmv-${e.id}`, fromId: mv < 0 ? e.id : null, toId: mv > 0 ? e.id : null, amount: Math.abs(mv), source: 'synthetic' });
}
s.balances.checking = oct.checking_balance; s.setupComplete = true; s.lastMonthProcessed = '2026-10';
remote.state = s;

const call = async (h, p, body) => { _resetRateLimit(); const r = await h(new Request(`http://localhost${p}`, body ? { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { authorization: `Bearer ${READ}` } }), {}); return { status: r.status, json: await r.json() }; };
const get = () => call(R, '/api/envelopes');
const pick = b => ({ month: b.month, checking: b.checking_balance, total_allocated: b.total_allocated, unallocated: b.unallocated, envelopes: Object.fromEntries(b.envelopes.filter(e => !e.group).map(e => [e.name, { allocated: e.allocated, carry: e.carry, remaining: e.remaining }])) });
const out = {};

// Check the rebuilt Oct matches the copy.
remote.state.lastMonthProcessed = '2026-10';
out.fake_now = new Date().toString();
let g = await get(); out.server_month = g.json.month;

// A) Run start-fresh BEFORE the app rolled over → must be refused.
out.A_before_rollover = await call(W, '/api/envelopes/start-fresh', { expected_state_hash: g.json.state_hash, envelopes: 'all', dry_run: false });
// B) David opens FigPig on Nov 1 → client rollover persisted.
store.hydrateFromObject(structuredClone(remote.state)); remote.state = structuredClone(store.getState()); remote.updated_at = 'rolled';
g = await get(); out.B_nov_after_rollover = pick(g.json); const h0 = g.json.state_hash;
out.B_negative_carry_into_nov = Object.entries(out.B_nov_after_rollover.envelopes).filter(([, v]) => v.carry < 0).map(([k, v]) => ({ envelope: k, carry: v.carry }));
// C) start-fresh dry run, real run, rerun, restore.
const dry = await call(W, '/api/envelopes/start-fresh', { expected_state_hash: h0, envelopes: 'all' });
out.C_dry_run = { status: dry.status, totals: dry.json.totals, writes: n };
const real = await call(W, '/api/envelopes/start-fresh', { expected_state_hash: h0, envelopes: 'all', dry_run: false, note: 'Nov 1 start fresh (local rehearsal)' });
out.C_real = { status: real.status, snapshot: real.json.snapshot, totals: real.json.totals };
g = await get(); out.C_after = pick(g.json); const h1 = g.json.state_hash;
const again = await call(W, '/api/envelopes/start-fresh', { expected_state_hash: h1, envelopes: 'all' });
out.C_idempotent = { status: again.status, any_change: again.json.changes.some(c => c.changed), state_hash_unchanged: again.json.state_hash_after === h1 };
// D) Optional allocation plan (dry run only).
const planPath = process.argv[3];
if (planPath) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const d = await call(W, '/api/envelopes/allocations', { month: '2026-11', expected_state_hash: h1, mode: 'replace', allocations: plan, dry_run: true });
  out.D_allocations_dry_run = { status: d.status, error: d.json.error, totals: d.json.totals, total_allocated: d.json.total_allocated, checking_balance: d.json.checking_balance };
}
// E) Rollback via the pre_start_fresh snapshot.
const rb = await call(W, `/api/envelopes/snapshots/${real.json.snapshot.id}/restore`, { expected_state_hash: h1, dry_run: false });
g = await get(); out.E_rollback = { status: rb.status, hash_matches_pre_reset: g.json.state_hash === h0, unallocated: g.json.unallocated };
console.log(JSON.stringify(out, null, 1));
