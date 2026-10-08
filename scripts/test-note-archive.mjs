/**
 * Sticky archive + booklets checks (js/note-archive.js, js/components/note-booklets.js).
 * FAKE DATA ONLY — invented notes, merchants and amounts. Never real budget data.
 */
import {
  archiveSticky,
  unarchiveSticky,
  deleteBoardKeepingArchive,
  activeStickies,
  countArchived,
  groupArchivedBooklets,
  bookletKey,
  stickyTilt,
  hashString,
  TILT_MIN_DEG,
  TILT_MAX_DEG,
  TILT_MAX_OFFSET_PX,
  normalizeStickyArchive,
  isIsoTimestamp,
  UNDATED_KEY,
} from '../js/note-archive.js';
import {
  applyAutoNoteLinks,
  computeNoteMatches,
  unlinkNote,
  listNoteLinks,
} from '../js/note-matcher.js';

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}
const clone = o => JSON.parse(JSON.stringify(o));
// Mid-day UTC on the 15th → same local month in every US/EU/NZ zone
const mid = ym => `${ym}-15T16:00:00.000Z`;
const at = day => `${day}T16:00:00.000Z`;
let seq = 0;
const nextId = () => `gen-${++seq}`;

function sticky(id, text, created, extra = {}) {
  return { id, title: '', text, color: 'yellow', createdAt: created, updatedAt: created, createdBy: 'notes', ...extra };
}
function contentOf(n) {
  const { archived, archivedAt, ...rest } = n;
  return JSON.stringify(rest);
}

// ---- 1. archive sets the fields; text and everything else unchanged ---------
{
  const n = sticky('a1', 'Fake note: bring $12.00 for field trip', at('2026-09-03'), { title: 'Field trip', color: 'pink' });
  const s = { noteBoards: [{ id: 'b1', title: 'Kids', stickies: [n] }] };
  const before = contentOf(n);
  const now = new Date('2026-10-08T15:30:00.000Z');
  const res = archiveSticky(s, 'a1', { now });
  expect(res.ok && res.boardId === 'b1', 'archive returns ok + board');
  expect(n.archived === true && n.archivedAt === '2026-10-08T15:30:00.000Z', 'archive sets archived + archivedAt');
  expect(contentOf(n) === before, 'archive leaves title/text/color/createdAt/updatedAt/createdBy unchanged');
  expect(activeStickies(s.noteBoards[0]).length === 0 && countArchived(s) === 1, 'archived note leaves the board view');
  expect(s.noteBoards[0].stickies.length === 1, 'archived note text is still stored (never deleted)');
  const again = archiveSticky(s, 'a1', { now: new Date('2026-12-01T00:00:00Z') });
  expect(again.reason === 'already-archived' && n.archivedAt === '2026-10-08T15:30:00.000Z', 're-archive keeps the first archivedAt');
  expect(archiveSticky(s, 'nope').ok === false, 'archive of unknown id fails cleanly');
}

// ---- 2. unarchive goes back to the original board; deleted-board fallback ----
{
  const s = { noteBoards: [
    { id: 'b1', title: 'General', stickies: [sticky('g1', 'general', at('2026-09-01'))] },
    { id: 'b2', title: 'Shopping', stickies: [sticky('s1', 'Fake milk $3.49', at('2026-09-02')), sticky('s2', 'eggs', at('2026-09-02'))] },
  ] };
  archiveSticky(s, 's1');
  const un = unarchiveSticky(s, 's1');
  expect(un.ok && un.boardId === 'b2' && un.boardTitle === 'Shopping', 'unarchive reports the original board');
  expect(activeStickies(s.noteBoards[1]).some(n => n.id === 's1'), 'unarchived note is back on Shopping');
  expect(!activeStickies(s.noteBoards[0]).some(n => n.id === 's1'), 'unarchived note is not on another board');
  const n = s.noteBoards[1].stickies.find(x => x.id === 's1');
  expect(n.archived === false && n.archivedAt === null, 'unarchive clears both fields');

  // Board deleted while a note is archived: archived note survives on the first remaining page
  archiveSticky(s, 's1');
  const del = deleteBoardKeepingArchive(s, 'b2', nextId);
  expect(del.moved === 1 && del.fallbackBoardId === 'b1', 'archived note moves to the first remaining page');
  expect(!s.noteBoards.some(b => b.id === 'b2'), 'the page itself is deleted');
  expect(!JSON.stringify(s).includes('"eggs"'), 'live (unarchived) stickies on a deleted page go with it, as before');
  const moved = s.noteBoards[0].stickies.find(x => x.id === 's1');
  expect(moved && moved.archived === true && moved.text === 'Fake milk $3.49', 'moved note keeps archive state + text');
  const un2 = unarchiveSticky(s, 's1');
  expect(un2.ok && un2.boardId === 'b1', 'unarchive after page delete lands on the fallback page');

  // Deleting the only page: a fresh General page holds the archive
  const solo = { noteBoards: [{ id: 'only', title: 'Only', stickies: [sticky('o1', 'keep me', at('2026-08-01'), { archived: true, archivedAt: at('2026-09-01') })] }] };
  const d2 = deleteBoardKeepingArchive(solo, 'only', nextId);
  expect(solo.noteBoards.length === 1 && solo.noteBoards[0].title === 'General' && d2.moved === 1, 'deleting the last page keeps archived notes on a new General page');
}

// ---- 3. booklets: createdAt month, archivedAt fallback, newest first, counts ---
{
  const s = { noteBoards: [{ id: 'b1', title: 'General', stickies: [
    sticky('m1', 'aug a', mid('2026-08'), { archived: true, archivedAt: mid('2026-10') }),
    sticky('m2', 'aug b', mid('2026-08'), { archived: true, archivedAt: mid('2026-09') }),
    sticky('m3', 'oct', mid('2026-10'), { archived: true, archivedAt: mid('2026-10') }),
    sticky('m4', 'no created', null, { updatedAt: null, archived: true, archivedAt: mid('2026-07') }),
    sticky('m5', 'dec 2025', mid('2025-12'), { archived: true, archivedAt: mid('2026-01') }),
    sticky('m6', 'live sept', mid('2026-09')),
    sticky('m7', 'undated', null, { updatedAt: null, archived: true, archivedAt: null }),
  ] }] };
  expect(bookletKey(s.noteBoards[0].stickies[0]) === '2026-08', 'booklet uses createdAt month, not archivedAt');
  expect(bookletKey(s.noteBoards[0].stickies[3]) === '2026-07', 'booklet falls back to archivedAt');
  const books = groupArchivedBooklets(s);
  const keys = books.map(b => b.key);
  expect(JSON.stringify(keys) === JSON.stringify(['2026-10', '2026-08', '2026-07', '2025-12', UNDATED_KEY]), `newest first, undated last (got ${keys.join(',')})`);
  const counts = Object.fromEntries(books.map(b => [b.key, b.count]));
  expect(counts['2026-10'] === 1 && counts['2026-08'] === 2 && counts['2026-07'] === 1 && counts['2025-12'] === 1 && counts[UNDATED_KEY] === 1, 'booklet counts are correct');
  expect(!books.some(b => b.notes.some(x => x.note.id === 'm6')), 'live notes are not in booklets');
  expect(books[0].label === 'October 2026' && books[3].label === 'December 2025', 'month/year labels');
  expect(books[1].notes.map(x => x.note.text).join('|') === 'aug a|aug b', 'booklet notes read oldest → newest');
}

// ---- normalize: strict types --------------------------------------------------
{
  const bad = normalizeStickyArchive({ id: 'x', archived: 'yes', archivedAt: 'yesterday' });
  expect(bad.archived === false && bad.archivedAt === null, 'non-boolean archived → false');
  const bad2 = normalizeStickyArchive({ id: 'y', archived: true, archivedAt: '<img src=x>' });
  expect(bad2.archived === true && bad2.archivedAt === null, 'garbage archivedAt → null');
  const ok = normalizeStickyArchive({ id: 'z', archived: true, archivedAt: '2026-10-08T12:00:00-04:00' });
  expect(ok.archivedAt === '2026-10-08T12:00:00-04:00', 'offset ISO timestamp kept');
  expect(!isIsoTimestamp('2026-10-08T16:00:00.000Z' + 'x'.repeat(40)), 'over-long timestamp rejected');
}

// ---- store + notes-only path round trip ---------------------------------------
globalThis.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const { store } = await import('../js/store.js');
const { stampNoteAuthors } = await import('../js/cloud-sync.js');
{
  const boards = [{ id: 'b1', title: 'General', stickies: [
    sticky('r1', 'Fake note one', at('2026-09-05'), { archived: true, archivedAt: '2026-10-08T16:00:00.000Z' }),
    sticky('r2', 'Fake note two', at('2026-09-06'), { archived: false, archivedAt: null }),
  ] }];
  // What the notes-only login sends (JSON body of the RPC) and what the fallback path writes
  const wire = JSON.parse(JSON.stringify(boards));
  const stamped = stampNoteAuthors(wire, boards, 'notes');
  const st = store.hydrateFromObject({ setupComplete: true, noteBoards: stamped });
  const r1 = st.noteBoards[0].stickies.find(n => n.id === 'r1');
  const r2 = st.noteBoards[0].stickies.find(n => n.id === 'r2');
  expect(r1.archived === true && r1.archivedAt === '2026-10-08T16:00:00.000Z' && r1.text === 'Fake note one', 'notes-only round trip keeps archived + archivedAt + text');
  expect(r2.archived === false && r2.archivedAt === null, 'notes-only round trip keeps unarchived state');

  // Store actions (same code path for both roles — update(..., { notes: true }))
  const notesAtBefore = st.notesUpdatedAt;
  const a = store.archiveStickyNote('r2');
  expect(a.ok && store.getState().noteBoards[0].stickies.find(n => n.id === 'r2').archived === true, 'store.archiveStickyNote archives');
  expect(store.getState().notesUpdatedAt && store.getState().notesUpdatedAt !== notesAtBefore, 'archive bumps notesUpdatedAt so the notes login sync keeps it');
  const u = store.unarchiveStickyNote('r2');
  expect(u.ok && u.boardId === 'b1', 'store.unarchiveStickyNote returns to the original board');
  expect(store.getState().noteBoards[0].stickies.find(n => n.id === 'r2').text === 'Fake note two', 'store archive/unarchive never changes text');
  // Older stickies without the fields normalize to not-archived
  const legacy = store.hydrateFromObject({ setupComplete: true, noteBoards: [{ id: 'b', title: 'G', stickies: [{ id: 'l1', text: 'old' }] }] });
  expect(legacy.noteBoards[0].stickies[0].archived === false && legacy.noteBoards[0].stickies[0].archivedAt === null, 'legacy stickies default to not archived');
}

// ---- 5 + 6. matcher: links kept, Unlink works, never looser -----------------
{
  const tx = (id, date, description, amount, memo = '') => ({ id, date, description, amount, type: 'expense', categoryId: 'c', memo });
  const base = {
    setupComplete: true,
    noteBoards: [{ id: 'b1', title: 'General', stickies: [
      sticky('k1', 'Costco $42.17 party', at('2026-09-10')),                 // strict → auto
      sticky('k2', 'Fakemart $25.00 supplies', at('2026-09-10')),            // ambiguous
      sticky('k3', 'Dentist copay $35.00', at('2026-09-10')),                // weak
      sticky('k4', 'Kroger $63.10', at('2026-09-10')),                       // amount miss
      sticky('k5', 'Target $19.99 socks', null, { updatedAt: at('2026-08-01') }), // old updatedAt only
    ] }],
    transactions: [
      tx('t1', '2026-09-09', 'FAKE COSTCO WHSE #0001', 42.17, 'bulk run'),
      tx('t2', '2026-09-09', 'FAKEMART SUPERCENTER 1', 25.0), tx('t3', '2026-09-11', 'FAKEMART SUPERCENTER 2', 25.0),
      tx('t4', '2026-09-10', 'FAKE OIL STATION 9', 35.0),
      tx('t5', '2026-09-10', 'KROGER #771', 61.0),
      tx('t6', '2026-10-08', 'TARGET 00012345', 19.99),                     // archive day ≠ note day
    ],
    noteLinks: [], noteLinkDismissals: [],
  };

  // Linked archived note keeps its link; Unlink still works
  const s = clone(base);
  applyAutoNoteLinks(s);
  const linksBefore = JSON.stringify(s.noteLinks);
  const memosBefore = JSON.stringify(s.transactions.map(t => t.memo));
  expect(s.noteLinks.length === 1 && s.noteLinks[0].noteId === 'k1', 'setup: k1 auto-linked');
  archiveSticky(s, 'k1', { now: new Date('2026-10-08T16:00:00Z') });
  const res = applyAutoNoteLinks(s);
  expect(!res.changed && JSON.stringify(s.noteLinks) === linksBefore, 'archiving keeps existing links exactly');
  expect(JSON.stringify(s.transactions.map(t => t.memo)) === memosBefore, 'archiving never rewrites memos');
  expect(listNoteLinks(s).some(r => r.note?.id === 'k1'), 'archived linked note still listed under Linked notes');
  const un = unlinkNote(s, s.noteLinks[0].id);
  expect(un.ok && un.memoRestored && s.transactions[0].memo === 'bulk run', 'Unlink on an archived note restores the memo');

  // Archiving never loosens: matches with every note archived == matches with none archived
  const live = clone(base);
  const arch = clone(base);
  arch.noteBoards[0].stickies.forEach(n => archiveSticky(arch, n.id, { now: new Date('2026-10-08T16:00:00Z') }));
  const sig = st => {
    const m = computeNoteMatches(st);
    return JSON.stringify({
      auto: m.auto.map(a => `${a.note.id}->${a.tx.id}`).sort(),
      review: m.review.map(r => `${r.note.id}:${r.reason}:${r.candidates.map(c => c.txId).sort().join('+')}`).sort(),
    });
  };
  expect(sig(live) === sig(arch), `archived notes match exactly as before (live ${sig(live)} vs archived ${sig(arch)})`);
  const archRun = applyAutoNoteLinks(arch);
  const liveRun = applyAutoNoteLinks(live);
  expect(archRun.linked === liveRun.linked && JSON.stringify(arch.transactions.map(t => t.memo)) === JSON.stringify(live.transactions.map(t => t.memo)), 'archived auto-link outcome identical to unarchived');
  expect(!arch.noteLinks.some(l => l.noteId === 'k5'), 'archivedAt is never used as the note date (k5 archived on the tx day still does not match)');
  expect(!arch.noteLinks.some(l => ['k2', 'k3', 'k4'].includes(l.noteId)), 'ambiguous / weak / miss notes stay unlinked when archived');
}

// ---- 7. HTML in a note shows as plain text (minimal fake DOM) ----------------
{
  const innerHtmlWrites = [];
  const created = [];
  class FakeText { constructor(t) { this.nodeType = 3; this._t = String(t); } get textContent() { return this._t; } }
  class FakeEl {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.classList = { add: (...c) => { this.className += ' ' + c.join(' '); } }; const props = {}; this.style = { setProperty: (k, v) => { props[k] = String(v); }, getPropertyValue: k => props[k] ?? '' }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {}
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...c) { this.children = c; }
    get textContent() { return this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children = [new FakeText(v)]; }
    set innerHTML(v) { innerHtmlWrites.push(String(v)); this._html = String(v); }
    get innerHTML() { return this._html || ''; }
  }
  globalThis.document = {
    createElement: tag => { const e = new FakeEl(tag); created.push(e); return e; },
    createTextNode: t => new FakeText(t),
    documentElement: { getAttribute: () => null },
  };
  const { renderFlipbookNote, renderArchiveShelf } = await import('../js/components/note-booklets.js');
  const evilTitle = '<script>alert(1)</script>';
  const evilText = '<img src=x onerror="window.__x=1"> Fake $9.99 <b>bold</b>\nline two';
  const node = renderFlipbookNote({
    note: { id: 'h1', title: evilTitle, text: evilText, color: 'yellow', createdAt: at('2026-09-01'), archived: true, archivedAt: at('2026-10-01') },
    boardId: 'b1', boardTitle: '<i>Page</i>',
  }, { onUnarchive: () => {} });
  const all = node.textContent;
  expect(all.includes(evilTitle) && all.includes(evilText.trim()) && all.includes('<i>Page</i>'), 'note title/text/page render as literal text');
  expect(!created.some(e => ['IMG', 'SCRIPT', 'B', 'I'].includes(e.tagName)), 'no elements created from note markup');
  expect(!innerHtmlWrites.some(h => h.includes('alert') || h.includes('onerror') || h.includes('Fake $9.99')), 'note text never goes through innerHTML (only static icon SVG does)');

  store.hydrateFromObject({ setupComplete: true, noteBoards: [{ id: 'b1', title: 'G', stickies: [
    { id: 'h2', title: '', text: '<svg onload=alert(1)>', color: 'blue', createdAt: at('2026-09-01'), archived: true, archivedAt: at('2026-10-01') },
  ] }] });
  const shelf = renderArchiveShelf({});
  expect(shelf.textContent.includes('September') && shelf.textContent.includes('1 note'), 'shelf shows month + count');
  expect(!innerHtmlWrites.some(h => h.includes('onload')), 'shelf never puts note text in innerHTML');

  // Shelf stack: one layer per real note (max 4), each tilted by its own id
  store.hydrateFromObject({ setupComplete: true, noteBoards: [{ id: 'b1', title: 'G', stickies: [
    ...['s1', 's2', 's3', 's4', 's5', 's6'].map((id, i) => ({ id, title: '', text: `fake ${id}`, color: ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'][i], createdAt: at(`2026-09-0${i + 1}`), archived: true, archivedAt: at('2026-10-01') })),
    { id: 't1', title: '', text: 'lonely', color: 'blue', createdAt: at('2026-07-04'), archived: true, archivedAt: at('2026-10-01') },
  ] }] });
  const walk = (n, out = []) => { if (n && n.children) { out.push(n); n.children.forEach(c => walk(c, out)); } return out; };
  const stacks = walk(renderArchiveShelf({})).filter(n => String(n.className).split(/\s+/).includes("note-stack"));
  expect(stacks.length === 2, 'one stack per month');
  const sepLayers = stacks[0].children.filter(Boolean);
  expect(sepLayers.length === 4, `busy month shows 4 layers max (got ${sepLayers.length})`);
  expect(stacks[1].children.filter(Boolean).length === 1, 'single-note month is a single sticky');
  const top = sepLayers[sepLayers.length - 1];
  expect(/note-stack-top/.test(top.className) && /sticky-yellow/.test(top.className) && top.textContent.includes('September'), 'top note is the first note, in its own color, with the month label');
  expect(top.style.getPropertyValue('--tilt') === `${stickyTilt('s1').angle}deg`, 'top note tilt comes from its id');
  const peekColors = sepLayers.slice(0, 3).map(n => (n.className.match(/sticky-(\w+)/) || [])[1]).join(',');
  expect(peekColors === 'green,blue,pink', `peeking layers use those notes' own colors, back to front (got ${peekColors})`);
  expect(sepLayers[0].style.getPropertyValue('--tilt') === `${stickyTilt('s4').angle}deg` && sepLayers[2].style.getPropertyValue('--tilt') === `${stickyTilt('s2').angle}deg`, 'each peeking layer is askew by its own id');
  const again = walk(renderArchiveShelf({})).filter(n => String(n.className).split(/\s+/).includes("note-stack"))[0].children.map(n => n.style.getPropertyValue('--tilt')).join();
  expect(again === sepLayers.map(n => n.style.getPropertyValue('--tilt')).join(), 'stack angles identical across re-renders');
}

// ---- askew stacks: tilt is a pure function of the note id, within bounds ----
{
  expect(hashString('abc') === hashString('abc') && hashString('abc') !== hashString('abd'), 'hash is stable and id-sensitive');
  const ids = Array.from({ length: 500 }, (_, i) => `fake-note-${i}`).concat(['', 'x', 'm1', 'a'.repeat(200), '🙂 ünïcode']);
  let pos = 0; let neg = 0;
  const angles = new Set();
  ids.forEach(id => {
    const a = stickyTilt(id);
    const b = stickyTilt(id);
    expect(JSON.stringify(a) === JSON.stringify(b), `tilt deterministic for ${JSON.stringify(id)}`);
    const mag = Math.abs(a.angle);
    expect(Number.isFinite(a.angle) && mag >= TILT_MIN_DEG && mag <= TILT_MAX_DEG, `tilt angle within ±${TILT_MIN_DEG}–${TILT_MAX_DEG}° for ${JSON.stringify(id)} (got ${a.angle})`);
    expect(Number.isInteger(a.dx) && Number.isInteger(a.dy) && Math.abs(a.dx) <= TILT_MAX_OFFSET_PX && Math.abs(a.dy) <= TILT_MAX_OFFSET_PX, `tilt offset within ±${TILT_MAX_OFFSET_PX}px for ${JSON.stringify(id)}`);
    if (a.angle > 0) pos++; else neg++;
    angles.add(a.angle);
  });
  expect(pos > 150 && neg > 150, `tilts lean both ways (pos ${pos}, neg ${neg})`);
  expect(angles.size > 200, 'notes get their own angles, not a handful of presets');
  expect(TILT_MIN_DEG === 1 && TILT_MAX_DEG === 4, 'bounds are ±1–4°');
  // Same id from a fresh module instance → same tilt (no per-session randomness)
  const fresh = await import('../js/note-archive.js?fresh=1');
  expect(JSON.stringify(fresh.stickyTilt('fake-note-7')) === JSON.stringify(stickyTilt('fake-note-7')), 'tilt survives a reload');
}

if (failures.length) {
  console.error(`test-note-archive: ${failures.length} failure(s)`);
  failures.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('test-note-archive: all checks passed');
process.exit(0);
