/**
 * Note ↔ transaction matcher checks (js/note-matcher.js).
 * FAKE DATA ONLY — invented merchants, amounts and notes. Never real budget data.
 */
import {
  applyAutoNoteLinks,
  computeNoteMatches,
  linkNoteToTransaction,
  unlinkNote,
  dismissNote,
  parseNoteAmounts,
  noteMemoSnippet,
  NOTE_SNIPPET_MAX,
  NOTE_MEMO_SEPARATOR,
  listNoteLinks,
} from '../js/note-matcher.js';

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}
const clone = o => JSON.parse(JSON.stringify(o));
// Noon Eastern on the given day, so local-day math is stable in any US zone.
const at = day => `${day}T16:00:00.000Z`;

let txSeq = 0;
function tx(date, description, amount, extra = {}) {
  txSeq++;
  return { id: `tx${txSeq}`, date, description, amount, type: 'expense', categoryId: 'cat-fake', clearingStatus: 'cleared', memo: '', ...extra };
}
function sticky(id, text, day, extra = {}) {
  return { id, title: '', text, color: 'yellow', createdAt: at(day), updatedAt: at(day), createdBy: 'notes', ...extra };
}
function makeState(stickies, transactions, boardTitle = 'General') {
  return {
    setupComplete: true,
    noteBoards: [{ id: 'board1', title: boardTitle, stickies }],
    transactions,
    noteLinks: [],
    noteLinkDismissals: [],
  };
}
function boardsSnapshot(state) {
  return JSON.stringify(state.noteBoards);
}
function txWithoutMemo(t) {
  const { memo, ...rest } = t;
  return JSON.stringify(rest);
}

// ---- amount parsing --------------------------------------------------------
{
  const got = parseNoteAmounts('Costco $42.17, gas 38.50 and $1,234.56 plus $20 — 3 kids on 10.08.2026');
  expect(got.includes(42.17), 'parse $42.17');
  expect(got.includes(38.5), 'parse bare 38.50');
  expect(got.includes(1234.56), 'parse $1,234.56');
  expect(got.includes(20), 'parse $20');
  expect(!got.includes(3), 'bare integer "3 kids" is not money');
  expect(!got.includes(10.08), 'date 10.08.2026 is not money');
  expect(parseNoteAmounts('pick up kids at 3').length === 0, 'no amounts in plain note');
}

// ---- 1. one candidate → auto-link -----------------------------------------
{
  const t1 = tx('2026-09-09', 'COSTCO WHSE #0421 FAKETOWN', 42.17);
  const tAmountMiss = tx('2026-09-10', 'COSTCO WHSE #0421 FAKETOWN', 18.0);
  const tDateMiss = tx('2026-09-25', 'COSTCO WHSE #0421 FAKETOWN', 42.17);
  const s = makeState([sticky('n1', 'Costco run $42.17 for the party', '2026-09-10')], [t1, tAmountMiss, tDateMiss]);
  const notesBefore = boardsSnapshot(s);
  const otherBefore = [t1, tAmountMiss, tDateMiss].map(txWithoutMemo);
  const res = applyAutoNoteLinks(s);
  expect(res.linked === 1, `one-candidate note should auto-link (got ${res.linked})`);
  expect(s.noteLinks.length === 1 && s.noteLinks[0].txId === t1.id && s.noteLinks[0].noteId === 'n1', 'link points at the Costco $42.17 tx');
  expect(s.noteLinks[0].mode === 'auto', 'auto link mode');
  expect(t1.memo === 'Note: Costco run $42.17 for the party', `empty memo gets the note (got "${t1.memo}")`);
  expect(tAmountMiss.memo === '' && tDateMiss.memo === '', 'non-matching transactions untouched');
  expect(boardsSnapshot(s) === notesBefore, 'note text unchanged after auto-link');
  expect([t1, tAmountMiss, tDateMiss].map(txWithoutMemo).join() === otherBefore.join(), 'only memo changes — amount/category/status untouched');

  // ---- 4. no double attach on a second run (same device and another device) ----
  const memoAfter = t1.memo;
  const res2 = applyAutoNoteLinks(s);
  expect(res2.linked === 0 && !res2.changed, 'second run is a no-op');
  expect(t1.memo === memoAfter && s.noteLinks.length === 1, 'second run does not append twice');
  const deviceB = clone(s);
  applyAutoNoteLinks(deviceB);
  expect(JSON.stringify(deviceB.transactions) === JSON.stringify(s.transactions), 'other device re-run: same memos');
  // Link record lost in a sync but memo still has the note → adopt, don't append again
  const lost = clone(s);
  lost.noteLinks = [];
  const res3 = applyAutoNoteLinks(lost);
  expect(res3.linked === 1 && lost.transactions[0].memo === memoAfter, 'lost link is re-adopted without a second append');
  expect(lost.noteLinks[0].appended === memoAfter, 're-adopted link records the exact appended text');
  // Manual link of the same pair is idempotent too
  const again = linkNoteToTransaction(s, 'n1', t1.id, 'manual');
  expect(again.ok && again.reason === 'already-linked' && t1.memo === memoAfter, 'manual re-link of same pair is a no-op');
}

// ---- within a few cents still links ----------------------------------------
{
  const t = tx('2026-09-11', 'KROGER #771', 63.12);
  const s = makeState([sticky('n-cents', 'kroger 63.10', '2026-09-10')], [t]);
  expect(applyAutoNoteLinks(s).linked === 1, 'amount within a few cents links');
}

// ---- 2. two or more candidates → review, not linked -------------------------
{
  const a = tx('2026-09-09', 'WALMART SUPERCENTER 1111', 25.0);
  const b = tx('2026-09-11', 'WAL-MART #2222', 25.0);
  const s = makeState([sticky('n2', 'Walmart $25.00 school supplies', '2026-09-10')], [a, b]);
  const res = applyAutoNoteLinks(s);
  expect(res.linked === 0 && s.noteLinks.length === 0, 'ambiguous note is not linked');
  expect(a.memo === '' && b.memo === '', 'ambiguous note leaves memos alone');
  const { review } = computeNoteMatches(s);
  expect(review.length === 1 && review[0].reason === 'ambiguous' && review[0].candidates.length === 2, 'ambiguous note goes to review with both candidates');
  // One-tap Link from review
  const linked = linkNoteToTransaction(s, 'n2', b.id, 'manual');
  expect(linked.ok && b.memo.startsWith('Note: Walmart') && a.memo === '', 'manual Link from review appends to the chosen tx only');
  expect(computeNoteMatches(s).review.length === 0, 'linked note leaves the review list');
}

// ---- 3. amount / date / merchant misses don't link ------------------------
{
  const amountMiss = makeState([sticky('na', 'Kroger $63.10', '2026-09-10')], [tx('2026-09-10', 'KROGER #771', 61.0)]);
  expect(applyAutoNoteLinks(amountMiss).linked === 0, 'amount miss does not link');
  expect(computeNoteMatches(amountMiss).review.length === 0, 'amount miss is not even a review item');

  const dateFar = makeState([sticky('nd', 'Home Depot $88.40 mulch', '2026-09-10')], [tx('2026-09-20', 'THE HOME DEPOT #0099', 88.4)]);
  expect(applyAutoNoteLinks(dateFar).linked === 0, 'date 10 days off does not link');
  expect(computeNoteMatches(dateFar).review.length === 0, 'far date is not a review item');

  const dateLoose = makeState([sticky('nd2', 'Home Depot $88.40 mulch', '2026-09-10')], [tx('2026-09-15', 'THE HOME DEPOT #0099', 88.4)]);
  expect(applyAutoNoteLinks(dateLoose).linked === 0, 'date 5 days off does not auto-link');
  const looseReview = computeNoteMatches(dateLoose).review;
  expect(looseReview.length === 1 && looseReview[0].reason === 'weak', 'date 5 days off is a weak review item');

  const merchantMiss = makeState([sticky('nm', 'Dentist copay $35.00', '2026-09-10')], [tx('2026-09-10', 'FAKE OIL STATION 1234', 35.0)]);
  expect(applyAutoNoteLinks(merchantMiss).linked === 0, 'merchant miss does not link');
  const mr = computeNoteMatches(merchantMiss).review;
  expect(mr.length === 1 && mr[0].reason === 'weak', 'merchant miss with exact amount + date goes to review as weak');

  const noAmount = makeState([sticky('nn', 'Costco tomorrow for the party', '2026-09-10')], [tx('2026-09-10', 'COSTCO WHSE #0421', 42.17)]);
  expect(applyAutoNoteLinks(noAmount).linked === 0 && computeNoteMatches(noAmount).review.length === 0, 'note with no amount is ignored');

  // createdAt missing → updatedAt is used
  const upd = makeState([sticky('nu', 'Target $19.99 socks', '2026-09-10', { createdAt: null })], [tx('2026-09-11', 'TARGET 00012345', 19.99)]);
  expect(applyAutoNoteLinks(upd).linked === 1, 'falls back to updatedAt when createdAt is missing');
}

// ---- 5. existing memo preserved and appended -------------------------------
{
  const t = tx('2026-09-10', 'FAKE PIZZA PALACE', 31.4, { memo: 'split w/ neighbors' });
  const s = makeState([sticky('n5', 'Pizza night $31.40', '2026-09-10')], [t]);
  applyAutoNoteLinks(s);
  expect(t.memo === `split w/ neighbors${NOTE_MEMO_SEPARATOR}Note: Pizza night $31.40`, `hand memo kept, note appended (got "${t.memo}")`);

  // ---- 7. unlink restores the original memo, and never re-auto-links ----
  const un = unlinkNote(s, s.noteLinks[0].id);
  expect(un.ok && un.memoRestored && t.memo === 'split w/ neighbors', `unlink restores the original memo (got "${t.memo}")`);
  expect(s.noteLinks.length === 0, 'unlink removes the link');
  expect(applyAutoNoteLinks(s).linked === 0 && t.memo === 'split w/ neighbors', 'unlinked pair does not auto-link again');
}

// ---- unlink with two notes on one transaction ------------------------------
{
  const t = tx('2026-09-10', 'FAKE GARDEN CENTER', 54.0, { memo: '' });
  const s = makeState([
    sticky('nA', 'Garden center $54.00 tomatoes', '2026-09-10'),
    sticky('nB', 'Garden center $54.00 for mom', '2026-09-10'),
  ], [t]);
  linkNoteToTransaction(s, 'nA', t.id, 'manual');
  linkNoteToTransaction(s, 'nB', t.id, 'manual');
  expect(t.memo === `Note: Garden center $54.00 tomatoes${NOTE_MEMO_SEPARATOR}Note: Garden center $54.00 for mom`, 'two notes appended in order');
  const linkA = s.noteLinks.find(l => l.noteId === 'nA');
  unlinkNote(s, linkA.id);
  expect(t.memo === 'Note: Garden center $54.00 for mom', `unlinking the first note leaves the second cleanly (got "${t.memo}")`);
  const linkB = s.noteLinks.find(l => l.noteId === 'nB');
  unlinkNote(s, linkB.id);
  expect(t.memo === '', `unlinking both restores the empty memo (got "${t.memo}")`);
}

// ---- hand-edited memo after link: unlink leaves it alone -------------------
{
  const t = tx('2026-09-10', 'FAKE BOOKSHOP', 12.5, { memo: 'gift' });
  const s = makeState([sticky('ne', 'Bookshop $12.50', '2026-09-10')], [t]);
  applyAutoNoteLinks(s);
  t.memo = 'gift for teacher';
  const un = unlinkNote(s, s.noteLinks[0].id);
  expect(un.ok && !un.memoRestored && t.memo === 'gift for teacher', 'unlink never mangles a memo that was edited by hand');
}

// ---- 6. dismissed notes don't re-link --------------------------------------
{
  const t = tx('2026-09-10', 'COSTCO WHSE #0421', 77.77);
  const s = makeState([sticky('n6', 'Costco $77.77', '2026-09-10')], [t]);
  dismissNote(s, 'n6');
  expect(applyAutoNoteLinks(s).linked === 0 && t.memo === '', 'dismissed note never auto-links');
  expect(computeNoteMatches(s).review.length === 0, 'dismissed note leaves the review list');
  const s2 = clone(s);
  applyAutoNoteLinks(s2);
  expect(s2.noteLinks.length === 0, 'dismissal survives a reload / other device');
}

// ---- author + board filters -------------------------------------------------
{
  const t = tx('2026-09-10', 'COSTCO WHSE #0421', 42.17);
  const owner = makeState([sticky('no', 'Costco $42.17', '2026-09-10', { createdBy: 'owner' })], [clone(t)]);
  expect(applyAutoNoteLinks(owner).linked === 0, "owner's own sticky is not auto-matched");
  const legacy = makeState([sticky('nl', 'Costco $42.17', '2026-09-10', { createdBy: null })], [clone(t)]);
  expect(applyAutoNoteLinks(legacy).linked === 1, 'legacy (unknown author) sticky is matched');
  const advisor = makeState([sticky('nadv', 'Costco $42.17', '2026-09-10', { createdBy: null })], [clone(t)], 'Advisor plans');
  expect(applyAutoNoteLinks(advisor).linked === 0, 'Advisor plans board is skipped');
  const funded = makeState([sticky('nf', 'Costco $42.17', '2026-09-10')], [tx('2026-09-10', 'Funded envelope: Costco', 42.17, { type: 'transfer' })]);
  expect(applyAutoNoteLinks(funded).linked === 0, 'internal envelope-funding rows are never matched');
}

// ---- two notes fit one tx → both to review; tx already linked → review -------
{
  const t = tx('2026-09-10', 'COSTCO WHSE #0421', 42.17);
  const s = makeState([sticky('n7', 'Costco $42.17 food', '2026-09-10'), sticky('n8', 'Costco $42.17 drinks', '2026-09-10')], [t]);
  applyAutoNoteLinks(s);
  expect(s.noteLinks.length === 0 && t.memo === '', 'two notes fitting the same tx: neither auto-links');
  const r = computeNoteMatches(s).review;
  expect(r.length === 2 && r.every(x => x.reason === 'shared'), 'both notes wait in review');
  linkNoteToTransaction(s, 'n7', t.id, 'manual');
  const r2 = computeNoteMatches(s).review;
  expect(r2.length === 1 && r2[0].note.id === 'n8' && r2[0].reason === 'taken', 'after one is linked, the other stays in review (taken)');
  applyAutoNoteLinks(s);
  expect(s.noteLinks.length === 1, 'matcher never auto-adds a second note to a linked tx');
}

// ---- deleted transaction prunes its link ------------------------------------
{
  const t = tx('2026-09-10', 'COSTCO WHSE #0421', 42.17);
  const s = makeState([sticky('n9', 'Costco $42.17', '2026-09-10')], [t]);
  applyAutoNoteLinks(s);
  s.transactions = [];
  const res = applyAutoNoteLinks(s);
  expect(res.pruned === 1 && s.noteLinks.length === 0, 'link to a deleted tx is pruned');
  expect(listNoteLinks(s).length === 0, 'pruned link not listed');
}

// ---- memo text is sanitized + capped; markup stays literal text -------------
{
  const evil = '<img src=x onerror=alert(1)>\n\nCostco $42.17\u0007 ' + 'x'.repeat(400);
  const snip = noteMemoSnippet({ text: evil });
  expect(snip.length <= NOTE_SNIPPET_MAX, `snippet capped at ${NOTE_SNIPPET_MAX}`);
  expect(!/[\n\r\u0007]/.test(snip), 'snippet has no newlines/control chars');
  expect(snip.startsWith('<img src=x onerror=alert(1)>'), 'markup kept as literal text (UI renders via text nodes)');
}

// ---- 8. note text unchanged across every operation --------------------------
{
  const t = tx('2026-09-10', 'FAKE CAFE', 9.75, { memo: 'latte' });
  const s = makeState([sticky('nz', 'Cafe $9.75 — with Sam', '2026-09-10', { title: 'Coffee' })], [t]);
  const before = boardsSnapshot(s);
  applyAutoNoteLinks(s);
  unlinkNote(s, s.noteLinks[0]?.id);
  linkNoteToTransaction(s, 'nz', t.id, 'manual');
  dismissNote(s, 'nz');
  applyAutoNoteLinks(s);
  expect(boardsSnapshot(s) === before, 'note title/text/timestamps never change');
}

// ---- store integration: normalize keeps links, cleans bad author tags --------
globalThis.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const { store } = await import('../js/store.js');
const { stampNoteAuthors } = await import('../js/cloud-sync.js');
{
  const raw = makeState(
    [sticky('s1', 'Costco $42.17', '2026-09-10', { createdBy: 'hacker' }), sticky('s2', 'x', '2026-09-10', { createdBy: 'owner' })],
    [tx('2026-09-10', 'COSTCO WHSE #0421', 42.17)],
  );
  raw.noteLinks = [{ id: 'l1', noteId: 's1', txId: 'tx-x', mode: 'weird', appended: 'Note: a' }, { bogus: true }, 'str'];
  raw.noteLinkDismissals = [{ noteId: 's9', txId: null }, null];
  const st = store.hydrateFromObject(raw);
  expect(st.noteBoards[0].stickies[0].createdBy === null, 'unknown createdBy normalizes to null');
  expect(st.noteBoards[0].stickies[1].createdBy === 'owner', 'owner createdBy kept');
  expect(st.noteLinks.length === 1 && st.noteLinks[0].mode === 'manual', 'noteLinks normalized (bad rows dropped, mode clamped)');
  expect(st.noteLinkDismissals.length === 1 && st.noteLinkDismissals[0].txId === null, 'dismissals normalized');
  const fresh = store.hydrateFromObject({ setupComplete: true });
  expect(Array.isArray(fresh.noteLinks) && Array.isArray(fresh.noteLinkDismissals), 'old states get empty link arrays');
}

// ---- client mirror of the server author rule (fallback save path) -----------
{
  const prior = [{ id: 'b', stickies: [{ id: 'o', createdBy: 'owner' }, { id: 'l' }] }];
  const next = [{ id: 'b', stickies: [{ id: 'o', createdBy: 'notes' }, { id: 'l', createdBy: 'owner' }, { id: 'new', createdBy: 'owner' }] }];
  const out = stampNoteAuthors(next, prior, 'notes');
  expect(out[0].stickies.map(n => n.createdBy).join() === 'owner,,notes', `notes login cannot re-tag notes (got ${out[0].stickies.map(n => String(n.createdBy)).join()})`);
  expect(next[0].stickies[0].createdBy === 'notes', 'stampNoteAuthors does not mutate its input');
}

if (failures.length) {
  console.error(`test-note-matcher: ${failures.length} failure(s)`);
  failures.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('test-note-matcher: all checks passed');
process.exit(0);
