/**
 * Sticky archive + month/year booklets. Pure functions over app state (no DOM).
 *
 * Data lives on the sticky itself, inside noteBoards[].stickies[], so the
 * notes-only login can archive/unarchive through update_household_notes:
 *   archived:   boolean        (true = filed in the archive, hidden from the board)
 *   archivedAt: ISO string|null (when it was archived; null when not archived)
 * The sticky never leaves its board array, so Unarchive returns it to the
 * original board. Title, text, color, createdAt, updatedAt and createdBy are
 * never touched (the note matcher keys off createdAt/updatedAt).
 */
import { formatLocalISODate } from './utils.js';

export const ARCHIVED_AT_MAX = 40;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const UNDATED_KEY = 'undated';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Strict ISO timestamp (what Date#toISOString produces, or with an offset). */
export function isIsoTimestamp(v) {
  return typeof v === 'string' && v.length <= ARCHIVED_AT_MAX && ISO_RE.test(v)
    && !Number.isNaN(new Date(v).getTime());
}

export function isArchived(note) {
  return !!note && note.archived === true;
}

/** Clamp archive fields on one sticky (called from normalizeState). */
export function normalizeStickyArchive(n) {
  if (!isPlainObject(n)) return n;
  n.archived = n.archived === true;
  n.archivedAt = n.archived && isIsoTimestamp(n.archivedAt) ? n.archivedAt : null;
  return n;
}

function boards(state) {
  return Array.isArray(state?.noteBoards) ? state.noteBoards : [];
}

/** Find a sticky anywhere; returns { note, board } or null. */
export function findSticky(state, noteId) {
  for (const board of boards(state)) {
    if (!isPlainObject(board) || !Array.isArray(board.stickies)) continue;
    const note = board.stickies.find(n => isPlainObject(n) && n.id === noteId);
    if (note) return { note, board };
  }
  return null;
}

/** Board view: stickies that are not archived. */
export function activeStickies(board) {
  return (Array.isArray(board?.stickies) ? board.stickies : []).filter(n => isPlainObject(n) && !isArchived(n));
}

export function countArchived(state) {
  let n = 0;
  boards(state).forEach(b => { (b?.stickies || []).forEach(s => { if (isArchived(s)) n++; }); });
  return n;
}

/** Archive one sticky. Only `archived` / `archivedAt` change. */
export function archiveSticky(state, noteId, { now = new Date() } = {}) {
  const hit = findSticky(state, noteId);
  if (!hit) return { ok: false, reason: 'note-missing' };
  if (isArchived(hit.note)) return { ok: true, reason: 'already-archived', boardId: hit.board.id };
  hit.note.archived = true;
  hit.note.archivedAt = now.toISOString();
  return { ok: true, boardId: hit.board.id };
}

/**
 * Unarchive: the sticky never left its board array, so it reappears on its original
 * board. (If that board was deleted, deleteBoardKeepingArchive already moved it to the
 * fallback page — see below — and it comes back there.)
 */
export function unarchiveSticky(state, noteId) {
  const hit = findSticky(state, noteId);
  if (!hit) return { ok: false, reason: 'note-missing' };
  hit.note.archived = false;
  hit.note.archivedAt = null;
  return { ok: true, boardId: hit.board.id, boardTitle: hit.board.title || 'Page' };
}

/**
 * Delete a page but NEVER its archived notes' text: archived stickies move (still
 * archived) to the first remaining page; a "General" page is created if none is left.
 * Unarchive then returns them to that fallback page.
 * @param {() => string} makeId
 * @returns {{ moved: number, fallbackBoardId: string|null }}
 */
export function deleteBoardKeepingArchive(state, boardId, makeId) {
  const list = boards(state);
  const doomed = list.find(b => b && b.id === boardId);
  if (!doomed) return { moved: 0, fallbackBoardId: null };
  const keep = (Array.isArray(doomed.stickies) ? doomed.stickies : []).filter(isArchived);
  state.noteBoards = list.filter(b => b && b.id !== boardId);
  if (!state.noteBoards.length) {
    state.noteBoards = [{ id: makeId(), title: 'General', stickies: [] }];
  }
  const fallback = state.noteBoards[0];
  if (!Array.isArray(fallback.stickies)) fallback.stickies = [];
  if (keep.length) fallback.stickies.push(...keep);
  return { moved: keep.length, fallbackBoardId: fallback.id };
}

/** Month bucket (local) from createdAt, else archivedAt; null if neither parses. */
export function bookletKey(note) {
  for (const iso of [note?.createdAt, note?.archivedAt]) {
    if (!iso || typeof iso !== 'string') continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    return formatLocalISODate(d).slice(0, 7);
  }
  return null;
}

export function bookletLabel(key) {
  if (!key || key === UNDATED_KEY) return { month: 'Undated', year: '', label: 'Undated' };
  const [y, m] = key.split('-').map(Number);
  const month = MONTHS[(m || 1) - 1] || 'Month';
  return { month, year: String(y), label: `${month} ${y}` };
}

function noteSortTime(note) {
  const t = new Date(note?.createdAt || note?.archivedAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Archived stickies grouped into booklets, newest month first ("Undated" last).
 * Notes inside a booklet read oldest → newest, like a diary.
 * @returns {{ key, month, year, label, count, color, notes: { note, boardId, boardTitle }[] }[]}
 */
export function groupArchivedBooklets(state) {
  const map = new Map();
  boards(state).forEach(board => {
    (Array.isArray(board?.stickies) ? board.stickies : []).forEach(note => {
      if (!isPlainObject(note) || !isArchived(note)) return;
      const key = bookletKey(note) || UNDATED_KEY;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ note, boardId: board.id, boardTitle: String(board.title || 'Page') });
    });
  });
  const out = [...map.entries()].map(([key, notes]) => {
    notes.sort((a, b) => (noteSortTime(a.note) - noteSortTime(b.note)) || String(a.note.id).localeCompare(String(b.note.id)));
    const colors = new Map();
    notes.forEach(({ note }) => colors.set(note.color || 'yellow', (colors.get(note.color || 'yellow') || 0) + 1));
    const color = [...colors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'yellow';
    return { key, ...bookletLabel(key), count: notes.length, color, notes };
  });
  out.sort((a, b) => {
    if (a.key === UNDATED_KEY) return 1;
    if (b.key === UNDATED_KEY) return -1;
    return b.key.localeCompare(a.key);
  });
  return out;
}

/** 32-bit FNV-1a — tiny, stable string hash (same input → same number, every render/device). */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const TILT_MIN_DEG = 1;
export const TILT_MAX_DEG = 4;
export const TILT_MAX_OFFSET_PX = 4;

/**
 * How askew a sticky sits on its stack, derived only from its id:
 * angle ±[1°, 4°] (never flat), x/y offset within ±4px. Stable across renders.
 * @returns {{ angle: number, dx: number, dy: number }}
 */
export function stickyTilt(id) {
  const h = hashString(`tilt:${id}`);
  const span = TILT_MAX_DEG - TILT_MIN_DEG;
  const mag = TILT_MIN_DEG + ((h % 1000) / 999) * span;
  const sign = (h >>> 10) & 1 ? 1 : -1;
  const off = (bits) => (((h >>> bits) % (TILT_MAX_OFFSET_PX * 2 + 1)) - TILT_MAX_OFFSET_PX);
  return {
    angle: Math.round(sign * mag * 100) / 100,
    dx: off(12),
    dy: off(20),
  };
}
