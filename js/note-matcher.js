/**
 * Match household sticky notes to transactions — strictly, never forced.
 *
 * Pure functions over the app state (no DOM, no network). The app calls
 * `applyAutoNoteLinks` after load / cloud sync and saves through the normal
 * store save path. Nothing here edits note text, amounts, envelopes,
 * categories, balances, bill matches, or pay status — only `tx.memo`,
 * `state.noteLinks`, and `state.noteLinkDismissals`.
 *
 * Auto-link only when ALL hold for exactly ONE transaction:
 *   - an amount parsed from the note equals |tx.amount| within AMOUNT_TOLERANCE
 *   - tx.date is within DATE_WINDOW_DAYS of the note's createdAt (else updatedAt)
 *   - a word in the note fits the merchant/description (descriptionSimilarity)
 * Anything ambiguous (2+ strict candidates) or weak goes to "Notes to review".
 */
import { descriptionSimilarity } from './csv-import.js';
import { formatLocalISODate } from './utils.js';

export const AMOUNT_TOLERANCE = 0.03;
export const DATE_WINDOW_DAYS = 3;
/** Weak (review-only) candidates may be a bit further out in time. */
export const WEAK_DATE_WINDOW_DAYS = 7;
export const MERCHANT_FIT_MIN = 0.6;
/** Max characters of note text copied into a memo. */
export const NOTE_SNIPPET_MAX = 160;
/** Never grow a memo past this; such notes stay in review instead. */
export const MEMO_MAX = 1000;
export const NOTE_MEMO_LABEL = 'Note: ';
export const NOTE_MEMO_SEPARATOR = ' · ';
const MAX_REVIEW_CANDIDATES = 5;
const MAX_NOTE_SCAN_CHARS = 4000;

/** Words that never count as a merchant fit on their own. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'that', 'this', 'was', 'were', 'are', 'but', 'not', 'you',
  'your', 'our', 'ours', 'his', 'her', 'she', 'him', 'they', 'them', 'their', 'have', 'has', 'had',
  'got', 'get', 'paid', 'pay', 'paying', 'payment', 'bought', 'buy', 'spent', 'spend', 'cost',
  'costs', 'total', 'about', 'just', 'also', 'some', 'will', 'should', 'could', 'would', 'need',
  'needs', 'card', 'debit', 'credit', 'cash', 'check', 'money', 'dollars', 'bucks', 'charge',
  'charged', 'refund', 'returned', 'return', 'today', 'yesterday', 'tomorrow', 'tonight', 'week',
  'month', 'note', 'notes', 'reminder', 'please', 'thanks', 'thank', 'store', 'online', 'order',
  'stuff', 'things', 'thing', 'kids', 'kid', 'mock', 'test',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september',
  'october', 'november', 'december',
]);

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Internal envelope funding rows are bookkeeping, not purchases. */
function isEnvelopeFundingTransfer(tx) {
  return tx?.type === 'transfer' && /^Funded envelope:/i.test(String(tx.description || ''));
}

/**
 * Dollar amounts written in a note. Accepts "$42.17", "$42", "$1,234.56",
 * and bare "42.17" (two decimals). Bare integers ("3 kids", "Oct 8") are ignored.
 */
export function parseNoteAmounts(text) {
  const s = String(text || '').slice(0, MAX_NOTE_SCAN_CHARS);
  const out = [];
  const re = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?![\d.,]*\d)/g;
  let m;
  while ((m = re.exec(s))) {
    const hasDollar = !!m[1];
    const cents = m[3] || '';
    // Bare numbers need exactly two decimals to count as money.
    if (!hasDollar && cents.length !== 3) continue;
    // Skip parts of dates/versions like 10.08.2026 or 1.2.3
    const before = s[m.index - 1] || '';
    if (/[\d.\/-]/.test(before) && !hasDollar) continue;
    const n = Number(m[2].replace(/,/g, '') + cents);
    if (!Number.isFinite(n) || n <= 0 || n > 1e6) continue;
    const v = r2(n);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Local calendar day (YYYY-MM-DD) the note was written; createdAt, else updatedAt. */
export function noteDay(note) {
  const iso = note?.createdAt || note?.updatedAt || '';
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatLocalISODate(d);
}

function dayNumber(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDay || ''));
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

export function daysApart(a, b) {
  const x = dayNumber(a);
  const y = dayNumber(b);
  if (x == null || y == null) return Infinity;
  return Math.abs(x - y);
}

/** Candidate merchant words (and adjacent pairs, e.g. "home depot") from a note. */
export function noteMerchantTerms(note) {
  const raw = `${note?.title || ''} ${note?.text || ''}`.slice(0, MAX_NOTE_SCAN_CHARS).toLowerCase();
  const words = raw
    .replace(/[''`]/g, '')
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
  const terms = [];
  const seen = new Set();
  const push = t => { if (!seen.has(t)) { seen.add(t); terms.push(t); } };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const usable = w.length >= 3 && !/^\d+$/.test(w) && !STOP_WORDS.has(w);
    if (usable) push(w);
    const next = words[i + 1];
    if (next && usable && next.length >= 3 && !/^\d+$/.test(next) && !STOP_WORDS.has(next)) {
      push(`${w} ${next}`);
    }
    if (terms.length > 200) break;
  }
  return terms;
}

/** Best fit (0..1) between any note word and the transaction's merchant/description. */
export function merchantFit(note, tx) {
  const desc = String(tx?.description || '').trim();
  if (!desc) return 0;
  let best = 0;
  for (const term of noteMerchantTerms(note)) {
    const score = descriptionSimilarity(term, desc);
    if (score > best) best = score;
    if (best >= 1) break;
  }
  return best;
}

/** One-line, length-capped note text for a memo. Control chars stripped. */
export function noteMemoSnippet(note) {
  const title = String(note?.title || '');
  const text = String(note?.text || '');
  let body = [title.trim(), text.trim()].filter(Boolean);
  if (body.length === 2 && body[1].toLowerCase().startsWith(body[0].toLowerCase())) body = [body[1]];
  let s = body.join(' — ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > NOTE_SNIPPET_MAX) s = `${s.slice(0, NOTE_SNIPPET_MAX - 1).trimEnd()}…`;
  return s;
}

/** Exact text appended to a memo for this note (separator only if memo is non-empty). */
export function memoAppendText(existingMemo, note) {
  const snippet = noteMemoSnippet(note);
  if (!snippet) return '';
  const core = `${NOTE_MEMO_LABEL}${snippet}`;
  return String(existingMemo || '').trim() ? `${NOTE_MEMO_SEPARATOR}${core}` : core;
}

function ensureArrays(state) {
  if (!Array.isArray(state.noteLinks)) state.noteLinks = [];
  if (!Array.isArray(state.noteLinkDismissals)) state.noteLinkDismissals = [];
}

/** All stickies with their board, in board order. */
export function listStickies(state) {
  const out = [];
  (Array.isArray(state?.noteBoards) ? state.noteBoards : []).forEach(board => {
    if (!isPlainObject(board) || !Array.isArray(board.stickies)) return;
    board.stickies.forEach(note => {
      if (isPlainObject(note) && note.id) out.push({ note, board });
    });
  });
  return out;
}

/**
 * Notes the matcher looks at: written by the notes-only login, or legacy/unknown
 * author. Notes the owner wrote in the main app (and Advisor plan stickies) are skipped.
 */
export function isMatchableNote(note, board) {
  if (!isPlainObject(note) || !note.id) return false;
  if (note.createdBy === 'owner') return false;
  if (/^advisor\s*plans$/i.test(String(board?.title || '').trim())) return false;
  if (!noteMemoSnippet(note)) return false;
  return parseNoteAmounts(`${note.title || ''} ${note.text || ''}`).length > 0;
}

function txById(state) {
  const map = new Map();
  (state?.transactions || []).forEach(t => { if (t && t.id) map.set(t.id, t); });
  return map;
}

function activeLinks(state) {
  const txs = txById(state);
  return (Array.isArray(state?.noteLinks) ? state.noteLinks : [])
    .filter(l => isPlainObject(l) && l.noteId && l.txId && txs.has(l.txId));
}

function isNoteDismissed(state, noteId) {
  return (state?.noteLinkDismissals || []).some(d => d && d.noteId === noteId && !d.txId);
}

function isPairRejected(state, noteId, txId) {
  return (state?.noteLinkDismissals || []).some(d => d && d.noteId === noteId && d.txId === txId);
}

/**
 * Score every transaction against one note.
 * @returns {{ strict: object[], weak: object[] }} candidates sorted best-first
 */
export function findNoteCandidates(state, note) {
  const amounts = parseNoteAmounts(`${note?.title || ''} ${note?.text || ''}`);
  const day = noteDay(note);
  const strict = [];
  const weak = [];
  if (!amounts.length || !day) return { strict, weak };
  for (const tx of state?.transactions || []) {
    if (!isPlainObject(tx) || !tx.id || !tx.date) continue;
    if (isEnvelopeFundingTransfer(tx)) continue;
    if (isPairRejected(state, note.id, tx.id)) continue;
    const amt = r2(Math.abs(Number(tx.amount) || 0));
    if (!(amt > 0)) continue;
    const amountDiff = Math.min(...amounts.map(a => Math.abs(r2(a - amt))));
    if (amountDiff > AMOUNT_TOLERANCE + 1e-9) continue;
    const days = daysApart(day, tx.date);
    if (days > WEAK_DATE_WINDOW_DAYS) continue;
    const fit = merchantFit(note, tx);
    const cand = { tx, txId: tx.id, amountDiff, days, fit };
    if (days <= DATE_WINDOW_DAYS && fit >= MERCHANT_FIT_MIN) strict.push(cand);
    else weak.push(cand);
  }
  const order = (a, b) => (b.fit - a.fit) || (a.days - b.days) || (a.amountDiff - b.amountDiff);
  strict.sort(order);
  weak.sort(order);
  return { strict, weak };
}

/**
 * Read-only pass. Returns what would auto-link and what needs a human.
 * @returns {{ auto: {note, tx}[], review: {note, board, reason, candidates}[] }}
 */
export function computeNoteMatches(state) {
  const auto = [];
  const review = [];
  const links = activeLinks(state);
  const linkedNoteIds = new Set(links.map(l => l.noteId));
  for (const { note, board } of listStickies(state)) {
    if (!isMatchableNote(note, board)) continue;
    if (linkedNoteIds.has(note.id)) continue;
    if (isNoteDismissed(state, note.id)) continue;
    const { strict, weak } = findNoteCandidates(state, note);
    if (strict.length === 1) {
      const only = strict[0];
      const takenByOther = links.some(l => l.txId === only.txId && l.noteId !== note.id);
      const memo = String(only.tx.memo || '');
      const tooLong = (memo + memoAppendText(memo, note)).length > MEMO_MAX;
      if (!takenByOther && !tooLong) {
        auto.push({ note, board, tx: only.tx });
        continue;
      }
      review.push({ note, board, reason: takenByOther ? 'taken' : 'long', candidates: strict });
      continue;
    }
    if (strict.length > 1) {
      review.push({ note, board, reason: 'ambiguous', candidates: strict.slice(0, MAX_REVIEW_CANDIDATES) });
      continue;
    }
    if (weak.length) {
      review.push({ note, board, reason: 'weak', candidates: weak.slice(0, MAX_REVIEW_CANDIDATES) });
    }
  }
  // Two notes that both fit the same single transaction: don't guess which — review both.
  const perTx = new Map();
  auto.forEach(a => perTx.set(a.tx.id, (perTx.get(a.tx.id) || 0) + 1));
  const unique = auto.filter(a => perTx.get(a.tx.id) === 1);
  auto.filter(a => perTx.get(a.tx.id) > 1).forEach(a => {
    review.push({ note: a.note, board: a.board, reason: 'shared', candidates: findNoteCandidates(state, a.note).strict });
  });
  return { auto: unique, review };
}

function findNote(state, noteId) {
  return listStickies(state).find(x => x.note.id === noteId)?.note || null;
}

/**
 * Link one note to one transaction: record the link and append the note to the memo.
 * Idempotent — never attaches the same note to the same transaction twice.
 * @returns {{ ok: boolean, reason?: string, link?: object }}
 */
export function linkNoteToTransaction(state, noteId, txId, mode = 'manual', { now = new Date() } = {}) {
  ensureArrays(state);
  const note = findNote(state, noteId);
  const tx = (state.transactions || []).find(t => t && t.id === txId);
  if (!note) return { ok: false, reason: 'note-missing' };
  if (!tx) return { ok: false, reason: 'tx-missing' };
  const existing = state.noteLinks.find(l => l && l.noteId === noteId && l.txId === txId);
  if (existing) return { ok: true, reason: 'already-linked', link: existing };

  const memo = typeof tx.memo === 'string' ? tx.memo : '';
  const snippet = noteMemoSnippet(note);
  if (!snippet) return { ok: false, reason: 'empty-note' };
  const core = `${NOTE_MEMO_LABEL}${snippet}`;
  let appended;
  if (memo.includes(`${NOTE_MEMO_SEPARATOR}${core}`)) {
    // Already in the memo (e.g. link record lost in a sync) — adopt it, don't append again.
    appended = `${NOTE_MEMO_SEPARATOR}${core}`;
  } else if (memo === core || memo.startsWith(core)) {
    appended = core;
  } else {
    appended = memoAppendText(memo, note);
    const next = memo.trim() ? `${memo}${appended}` : appended;
    if (next.length > MEMO_MAX) return { ok: false, reason: 'memo-too-long' };
    tx.memo = next;
  }
  const link = {
    id: `nl-${noteId}-${txId}`,
    noteId,
    txId,
    linkedAt: now.toISOString(),
    mode: mode === 'auto' ? 'auto' : 'manual',
    appended,
  };
  state.noteLinks.push(link);
  // A manual link overrides an earlier dismissal of this note.
  state.noteLinkDismissals = state.noteLinkDismissals.filter(d => !(d && d.noteId === noteId && (!d.txId || d.txId === txId)));
  return { ok: true, link };
}

/**
 * Remove a link and exactly the text it appended; the original memo stays intact.
 * Records the pair so the matcher never auto-links it again.
 */
export function unlinkNote(state, linkId, { now = new Date() } = {}) {
  ensureArrays(state);
  const idx = state.noteLinks.findIndex(l => l && l.id === linkId);
  if (idx < 0) return { ok: false, reason: 'link-missing' };
  const link = state.noteLinks[idx];
  state.noteLinks.splice(idx, 1);
  let memoRestored = false;
  const tx = (state.transactions || []).find(t => t && t.id === link.txId);
  const appended = typeof link.appended === 'string' ? link.appended : '';
  if (tx && appended && typeof tx.memo === 'string') {
    if (tx.memo.endsWith(appended)) {
      tx.memo = tx.memo.slice(0, tx.memo.length - appended.length);
      memoRestored = true;
    } else if (tx.memo.includes(appended)) {
      const at = tx.memo.indexOf(appended);
      tx.memo = tx.memo.slice(0, at) + tx.memo.slice(at + appended.length);
      memoRestored = true;
    }
    // A memo that started with this note (no separator) may now begin with " · Note: …"
    if (memoRestored && link.appended && !link.appended.startsWith(NOTE_MEMO_SEPARATOR)
      && tx.memo.startsWith(NOTE_MEMO_SEPARATOR)) {
      tx.memo = tx.memo.slice(NOTE_MEMO_SEPARATOR.length);
      // keep the next link's appended text accurate
      const nextLink = state.noteLinks.find(l => l && l.txId === tx.id && tx.memo.startsWith(String(l.appended || '').replace(NOTE_MEMO_SEPARATOR, '')));
      if (nextLink && String(nextLink.appended || '').startsWith(NOTE_MEMO_SEPARATOR)) {
        nextLink.appended = nextLink.appended.slice(NOTE_MEMO_SEPARATOR.length);
      }
    }
  }
  if (!isPairRejected(state, link.noteId, link.txId)) {
    state.noteLinkDismissals.push({ noteId: link.noteId, txId: link.txId, at: now.toISOString() });
  }
  return { ok: true, memoRestored, link };
}

/** "Not a transaction note" — never auto-link or show this note again. */
export function dismissNote(state, noteId, { now = new Date() } = {}) {
  ensureArrays(state);
  if (!noteId) return { ok: false };
  if (!isNoteDismissed(state, noteId)) {
    state.noteLinkDismissals.push({ noteId, txId: null, at: now.toISOString() });
  }
  return { ok: true };
}

/**
 * Apply every strict, single-candidate match. Prunes links whose transaction was deleted.
 * Mutates only tx.memo / state.noteLinks. Returns { linked, pruned, changed }.
 */
export function applyAutoNoteLinks(state, { now = new Date() } = {}) {
  if (!isPlainObject(state)) return { linked: 0, pruned: 0, changed: false };
  ensureArrays(state);
  const txs = txById(state);
  const before = state.noteLinks.length;
  state.noteLinks = state.noteLinks.filter(l => isPlainObject(l) && l.noteId && l.txId && txs.has(l.txId));
  const pruned = before - state.noteLinks.length;
  let linked = 0;
  const { auto } = computeNoteMatches(state);
  for (const { note, tx } of auto) {
    const res = linkNoteToTransaction(state, note.id, tx.id, 'auto', { now });
    if (res.ok && res.reason !== 'already-linked') linked++;
  }
  return { linked, pruned, changed: linked > 0 || pruned > 0 };
}

/** Normalize persisted link/dismissal arrays (called from store normalizeState). */
export function normalizeNoteLinkState(state) {
  if (!isPlainObject(state)) return state;
  const str = v => (typeof v === 'string' && v.length <= 200 ? v : null);
  state.noteLinks = (Array.isArray(state.noteLinks) ? state.noteLinks : [])
    .filter(l => isPlainObject(l) && str(l.noteId) && str(l.txId))
    .map(l => ({
      id: str(l.id) || `nl-${l.noteId}-${l.txId}`,
      noteId: l.noteId,
      txId: l.txId,
      linkedAt: str(l.linkedAt),
      mode: l.mode === 'auto' ? 'auto' : 'manual',
      appended: typeof l.appended === 'string' ? l.appended.slice(0, MEMO_MAX) : '',
    }));
  state.noteLinkDismissals = (Array.isArray(state.noteLinkDismissals) ? state.noteLinkDismissals : [])
    .filter(d => isPlainObject(d) && str(d.noteId))
    .map(d => ({ noteId: d.noteId, txId: str(d.txId), at: str(d.at) }));
  return state;
}

/** Linked notes with their note + transaction, newest first (for the Unlink list). */
export function listNoteLinks(state) {
  const txs = txById(state);
  const notes = new Map(listStickies(state).map(x => [x.note.id, x.note]));
  return activeLinks(state)
    .map(link => ({ link, note: notes.get(link.noteId) || null, tx: txs.get(link.txId) }))
    .sort((a, b) => String(b.link.linkedAt || '').localeCompare(String(a.link.linkedAt || '')));
}
