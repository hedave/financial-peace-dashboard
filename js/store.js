import {
  createDefaultState,
  DEFAULT_CATEGORIES,
  SINKING_FUND_DEFAULTS,
  BUILT_IN_CATEGORY_NAMES,
} from './defaults.js';
import {
  getCurrentMonth, isInMonth, todayISO, generateId,
  getPreviousMonth, getRecentMonths, addOneMonthToDate, formatLocalISODate,
  addMonths,
} from './utils.js';
import {
  normalizeImportRow, resolveCategoryId,
  isImportDuplicateTransaction,
  clusterDuplicateTransactions,
  findBestPendingMatch,
  isTransactionPending,
  descriptionSimilarity,
} from './csv-import.js';
import { findMatchingRule, applyRuleToTransaction } from './category-rules.js';
import { findBillForTransaction, findAutoPayBillForTransaction } from './bill-matcher.js';
import {
  normalizePaySchedule,
  getScheduledChecksForMonth,
  getSourceIncomeForMonth as sumSourceIncomeForMonth,
  getUpcomingChecks,
  getChecksForYear,
  getDefaultPerCheckAmount,
  matchCheckToTransaction,
  resolveCheckStatus,
  resolveIncomeSource,
  syncPaycheckFromImport,
  transactionMatchesIncomeSource,
} from './pay-schedule.js';
import {
  applyDefaultMatchTerms,
  ensureBonusIncomeSource,
  migrateLegacyIncomeSourceNames,
  isBonusIncomeSource,
  BONUS_INCOME_NAME,
} from './income-sources.js';
import {
  isCloudConfigured,
  isBlankBudgetState,
  getSession,
  loadRemoteState,
  pushState,
  schedulePush,
} from './cloud-sync.js';
import { findReconciliationCandidates } from './reconcile-match.js';

const STORAGE_KEY = 'financial-peace-dashboard';

function isFundedEnvelopeTransfer(tx) {
  return tx
    && tx.type === 'transfer'
    && /^Funded envelope:/i.test(String(tx.description || ''));
}

function isRecurringBill(bill) {
  return !!(bill && bill.recurring !== false);
}

/**
 * After a payment: record last paid; recurring bills roll to next cycle as unpaid.
 * Mutates bill in place.
 */
function completeBillPaymentCycle(bill, paidDate, paidAmount) {
  const when = paidDate || todayISO();
  const amt = Number(paidAmount) || Number(bill.amount) || 0;
  bill.lastPaidDate = when;
  bill.lastPaidAmount = amt;

  if (!isRecurringBill(bill)) {
    bill.status = 'paid';
    bill.paidDate = when;
    bill.paidAmount = amt;
    return;
  }

  const baseDue = bill.dueDate || when;
  bill.dueDate = addOneMonthToDate(baseDue);
  bill.status = 'pending';
  delete bill.paidDate;
  delete bill.paidAmount;
}

/**
 * Month-start safety net: recurring bills still marked paid (pre-fix data) roll forward.
 * Unpaid past-due bills stay overdue so a missed cycle remains visible.
 */
function rollRecurringBillsForNewMonth(bills, currentMonth) {
  (bills || []).forEach(bill => {
    if (!isRecurringBill(bill)) return;
    if (bill.status !== 'paid') return;

    if (bill.paidDate) {
      bill.lastPaidDate = bill.paidDate;
      if (bill.paidAmount != null) bill.lastPaidAmount = bill.paidAmount;
    }
    const base = bill.dueDate || bill.lastPaidDate || bill.paidDate || todayISO();
    bill.dueDate = addOneMonthToDate(base);
    bill.status = 'pending';
    delete bill.paidDate;
    delete bill.paidAmount;

    // Catch up if app wasn't opened for multiple months
    let guard = 0;
    while (
      bill.dueDate
      && String(bill.dueDate).slice(0, 7) < currentMonth
      && guard < 36
    ) {
      bill.dueDate = addOneMonthToDate(bill.dueDate);
      guard++;
    }
  });
}

function ensureDefaultCategories(state) {
  state.categories = (state.categories || []).filter(
    c => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim()
  ).map(c => ({
    parentId: null,
    isSinkingFund: false,
    monthlyBudget: 0,
    carryOver: 0,
    goalAmount: 0,
    note: '',
    allowGifts: false,
    ...c,
    id: c.id || generateId(),
    name: c.name.trim(),
    goalAmount: Number(c.goalAmount) > 0 ? Number(c.goalAmount) : 0,
    note: typeof c.note === 'string' ? c.note : (c.note ? String(c.note) : ''),
    allowGifts: c.allowGifts === true,
  }));

  const sinkingNames = new Set(SINKING_FUND_DEFAULTS.map(c => c.name.toLowerCase()));
  const existing = new Set(state.categories.map(c => c.name.toLowerCase()));
  const removed = new Set((state.removedDefaultCategories || []).map(name => name.toLowerCase()));

  [...DEFAULT_CATEGORIES, ...SINKING_FUND_DEFAULTS].forEach(def => {
    const key = def.name.toLowerCase();
    if (existing.has(key)) return;
    if (removed.has(key)) return;
    state.categories.push({
      id: generateId(),
      name: def.name,
      icon: def.icon,
      parentId: null,
      isSinkingFund: sinkingNames.has(def.name.toLowerCase()),
      monthlyBudget: 0,
      carryOver: 0,
      goalAmount: 0,
      note: '',
      allowGifts: false,
    });
    existing.add(def.name.toLowerCase());
  });

  // Keep Mortgage at the top — it's a primary bill for most families
  const mortgageIdx = state.categories.findIndex(c => c.name.toLowerCase() === 'mortgage');
  if (mortgageIdx > 0) {
    const [mortgage] = state.categories.splice(mortgageIdx, 1);
    state.categories.unshift(mortgage);
  }

  return state;
}

function normalizeState(state) {
  const defaults = createDefaultState();
  if (!Array.isArray(state.bills)) state.bills = [];
  (state.bills || []).forEach(b => {
    if (!b || typeof b !== 'object') return;
    if (typeof b.recurring !== 'boolean') b.recurring = true;
  });
  // Migrate pre-fix paid recurring bills → next cycle (idempotent once pending)
  rollRecurringBillsForNewMonth(state.bills, getCurrentMonth());
  if (!Array.isArray(state.debts)) state.debts = [];
  if (!Array.isArray(state.transactions)) state.transactions = [];
  if (!Array.isArray(state.categories)) state.categories = [...defaults.categories];
  if (!Array.isArray(state.incomeSources)) state.incomeSources = defaults.incomeSources;
  if (!Array.isArray(state.archivedDebts)) state.archivedDebts = [];
  if (!Array.isArray(state.celebrations)) state.celebrations = [];
  if (typeof state.notes !== 'string') state.notes = '';
  if (state.notesUpdatedAt !== null && typeof state.notesUpdatedAt !== 'string') state.notesUpdatedAt = null;
  if (!Array.isArray(state.noteBoards)) state.noteBoards = [];
  // Migrate legacy single notes blob into first sticky on a default board
  if ((!state.noteBoards.length) && state.notes && String(state.notes).trim()) {
    state.noteBoards = [{
      id: generateId(),
      title: 'General',
      stickies: [{
        id: generateId(),
        title: 'Notes',
        text: state.notes,
        color: 'yellow',
        updatedAt: state.notesUpdatedAt || new Date().toISOString(),
      }],
    }];
  }
  if (!state.noteBoards.length) {
    state.noteBoards = [{
      id: generateId(),
      title: 'General',
      stickies: [],
    }];
  }
  state.noteBoards.forEach(board => {
    if (!board.id) board.id = generateId();
    if (!board.title) board.title = 'Board';
    if (!Array.isArray(board.stickies)) board.stickies = [];
    board.stickies.forEach(n => {
      if (!n.id) n.id = generateId();
      if (typeof n.text !== 'string') n.text = '';
      if (typeof n.title !== 'string') n.title = '';
      if (!n.color) n.color = 'yellow';
    });
  });
  if (!Array.isArray(state.removedDefaultCategories)) state.removedDefaultCategories = [];
  if (!Array.isArray(state.categoryRules)) state.categoryRules = [];
  if (!state.monthBudgetSnapshots || typeof state.monthBudgetSnapshots !== 'object') {
    state.monthBudgetSnapshots = {};
  }
  if (!state.monthEnvelopeMoves || typeof state.monthEnvelopeMoves !== 'object') {
    state.monthEnvelopeMoves = {};
  }
  if (!Array.isArray(state.monthCloseLog)) state.monthCloseLog = [];
  if (!state.reconciliation || typeof state.reconciliation !== 'object') {
    state.reconciliation = { bankBalance: null, asOfDate: null };
  }
  if (!state.balances || typeof state.balances !== 'object') state.balances = defaults.balances;
  if (!Array.isArray(state.balances.savings)) state.balances.savings = [];
  if (!state.settings || typeof state.settings !== 'object') state.settings = { ...defaults.settings };
  if (!state.settings.palette) state.settings.palette = 'forest';
  if (typeof state.settings.largeText !== 'boolean') state.settings.largeText = false;
  if (typeof state.settings.reduceMotion !== 'boolean') state.settings.reduceMotion = false;
  if (state.settings.lastBackupAt != null && typeof state.settings.lastBackupAt !== 'string') {
    state.settings.lastBackupAt = null;
  }
  if (state.settings.surplusCashBuffer == null || !Number.isFinite(Number(state.settings.surplusCashBuffer))) {
    state.settings.surplusCashBuffer = 50;
  }
  if (state.settings.familySize == null || !Number.isFinite(Number(state.settings.familySize))) {
    state.settings.familySize = 7;
  }
  if (!Array.isArray(state.settings.favoriteCategoryIds)) {
    state.settings.favoriteCategoryIds = [];
  }
  if (state.settings.lastExpenseCategoryId != null && typeof state.settings.lastExpenseCategoryId !== 'string') {
    state.settings.lastExpenseCategoryId = null;
  }
  if (state.settings.dismissMonthChecklist != null && typeof state.settings.dismissMonthChecklist !== 'string') {
    state.settings.dismissMonthChecklist = null;
  }
  if (!state.settings.advisorAliases || typeof state.settings.advisorAliases !== 'object') {
    state.settings.advisorAliases = { dining: null, vacation: null, christmas: null };
  } else {
    const a = state.settings.advisorAliases;
    if (!('dining' in a)) a.dining = null;
    if (!('vacation' in a)) a.vacation = null;
    if (!('christmas' in a)) a.christmas = null;
  }
  state.incomeSources = ensureBonusIncomeSource(state.incomeSources);
  migrateLegacyIncomeSourceNames(state.incomeSources);
  (state.incomeSources || []).forEach(src => {
    src.paySchedule = normalizePaySchedule(src.paySchedule);
    if (!Array.isArray(src.matchTerms)) src.matchTerms = [];
    applyDefaultMatchTerms(src);
  });
  ensureDefaultCategories(state);
  const bonusSrc = (state.incomeSources || []).find(s => s?.type === 'bonus');
  (state.transactions || []).forEach(tx => {
    // Existing data: treat as bank-cleared so balances don't jump
    if (tx.clearingStatus !== 'pending' && tx.clearingStatus !== 'cleared') {
      tx.clearingStatus = 'cleared';
    }
    if (tx.type !== 'income') return;
    // Re-resolve missing source, or Bonus that is clearly a scheduled paycheck
    const linked = (state.incomeSources || []).find(s => s.id === tx.incomeSourceId);
    const isBonusTagged = !linked || linked.type === 'bonus'
      || (bonusSrc && tx.incomeSourceId === bonusSrc.id);
    if (tx.incomeSourceId && !isBonusTagged) return;
    const source = resolveIncomeSource(tx.description, state.incomeSources, {
      date: tx.date,
      amount: tx.amount,
    });
    if (source) tx.incomeSourceId = source.id;
  });
  return state;
}

class Store {
  constructor() {
    this.state = this.loadLocal();
    this.listeners = new Set();
    this.cloudReady = false;
    this.processMonthRollover();
  }

  loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeState({ ...createDefaultState(), ...JSON.parse(raw) });
    } catch (e) {
      console.warn('Failed to load state', e);
    }
    return createDefaultState();
  }

  writeLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  async initCloud() {
    if (!isCloudConfigured()) {
      this.cloudReady = true;
      return { configured: false, signedIn: false };
    }
    const session = await getSession();
    if (!session) {
      this.cloudReady = true;
      return { configured: true, signedIn: false };
    }
    await this.pullFromCloud();
    this.cloudReady = true;
    return { configured: true, signedIn: true };
  }

  hasMeaningfulLocalData() {
    return !isBlankBudgetState(this.state);
  }

  async forcePullFromCloud() {
    const remote = await loadRemoteState();
    if (!remote?.state || typeof remote.state !== 'object') {
      throw new Error('No budget found in the cloud. Sync from your live site first (Settings → Sync Now).');
    }
    const remoteTime = new Date(remote.updated_at || 0).getTime();
    this.state = normalizeState({
      ...createDefaultState(),
      ...remote.state,
      _cloudUpdatedAt: remoteTime,
    });
    this.processMonthRollover();
    this.writeLocal();
    this.notify();
    return true;
  }

  async pullFromCloud() {
    const remote = await loadRemoteState();
    if (!remote?.state || typeof remote.state !== 'object') return { hadRemote: false, applied: false };

    const remoteTime = new Date(remote.updated_at || 0).getTime();
    const localRaw = localStorage.getItem(STORAGE_KEY);
    let useRemote = !localRaw;
    if (localRaw) {
      try {
        const local = JSON.parse(localRaw);
        const localTime = Number(local._cloudUpdatedAt) || 0;
        const localIsBlank = isBlankBudgetState(local);
        const remoteIsBlank = isBlankBudgetState(remote.state);
        if (localIsBlank && !remoteIsBlank) useRemote = true;
        else if (!localIsBlank && remoteIsBlank) useRemote = false;
        else useRemote = remoteTime >= localTime;
      } catch {
        useRemote = true;
      }
    }

    if (useRemote) {
      const merged = { ...remote.state, _cloudUpdatedAt: remoteTime };
      this.state = normalizeState({ ...createDefaultState(), ...merged });
      this.processMonthRollover();
      this.writeLocal();
      this.notify();
      return { hadRemote: true, applied: true };
    }
    return { hadRemote: true, applied: false };
  }

  async pushToCloud({ force = false } = {}) {
    if (!isCloudConfigured() || !(await getSession())) return false;
    if (!force && isBlankBudgetState(this.state)) {
      const remote = await loadRemoteState();
      if (remote?.state && !isBlankBudgetState(remote.state)) {
        console.warn('Skipped pushing blank local state over cloud budget');
        return false;
      }
    }
    const payload = { ...this.state };
    const ok = await pushState(payload);
    if (ok) {
      this.state._cloudUpdatedAt = Date.now();
      this.writeLocal();
    }
    return ok;
  }

  save() {
    try {
      this.writeLocal();
    } catch (e) {
      console.error('Failed to write to localStorage', e);
      throw new Error('Could not save data. Your browser storage may be full or disabled.');
    }
    if (isCloudConfigured()) {
      schedulePush(() => this.pushToCloud());
    }
    try {
      this.notify();
    } catch (e) {
      console.error('UI refresh failed after save', e);
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    this.listeners.forEach(fn => fn(this.state));
  }

  getState() {
    return this.state;
  }

  update(fn) {
    try {
      normalizeState(this.state);
      fn(this.state);
      normalizeState(this.state);
      this.save();
    } catch (e) {
      console.error('Store update failed', e);
      throw e;
    }
  }

  reset() {
    this.state = createDefaultState();
    this.save();
  }

  saveSilently() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.error('Failed to write to localStorage', e);
      throw new Error('Could not save data. Your browser storage may be full or disabled.');
    }
  }

  // --- Notes (legacy single blob + sticky boards) ---
  getNotes() {
    return this.state.notes || '';
  }

  getNotesUpdatedAt() {
    return this.state.notesUpdatedAt || null;
  }

  setNotes(content) {
    this.state.notes = content;
    this.state.notesUpdatedAt = new Date().toISOString();
    this.saveSilently();
  }

  clearNotes() {
    this.state.notes = '';
    this.state.notesUpdatedAt = null;
    this.save();
  }

  getNoteBoards() {
    return this.state.noteBoards || [];
  }

  addNoteBoard(title = 'New page') {
    const board = {
      id: generateId(),
      title: String(title || 'New page').trim() || 'New page',
      stickies: [],
    };
    this.update(s => {
      if (!Array.isArray(s.noteBoards)) s.noteBoards = [];
      s.noteBoards.push(board);
    });
    return board.id;
  }

  renameNoteBoard(boardId, title) {
    this.update(s => {
      const b = (s.noteBoards || []).find(x => x.id === boardId);
      if (b) b.title = String(title || 'Page').trim() || 'Page';
    });
  }

  deleteNoteBoard(boardId) {
    this.update(s => {
      s.noteBoards = (s.noteBoards || []).filter(b => b.id !== boardId);
      if (!s.noteBoards.length) {
        s.noteBoards = [{ id: generateId(), title: 'General', stickies: [] }];
      }
    });
  }

  addStickyNote(boardId, { title = '', text = '', color = 'yellow' } = {}) {
    const note = {
      id: generateId(),
      title: String(title || ''),
      text: String(text || ''),
      color: color || 'yellow',
      updatedAt: new Date().toISOString(),
    };
    this.update(s => {
      const b = (s.noteBoards || []).find(x => x.id === boardId);
      if (!b) return;
      if (!Array.isArray(b.stickies)) b.stickies = [];
      b.stickies.unshift(note);
    });
    return note.id;
  }

  /** Silent sticky update for typing (avoids full app re-render). */
  patchStickyNote(boardId, noteId, patch = {}) {
    const b = (this.state.noteBoards || []).find(x => x.id === boardId);
    const n = b?.stickies?.find(x => x.id === noteId);
    if (!n) return;
    if (patch.title !== undefined) n.title = String(patch.title);
    if (patch.text !== undefined) n.text = String(patch.text);
    if (patch.color !== undefined) n.color = patch.color;
    n.updatedAt = new Date().toISOString();
    this.syncLegacyNotesFromStickies();
    this.saveSilently();
  }

  deleteStickyNote(boardId, noteId) {
    this.update(s => {
      const b = (s.noteBoards || []).find(x => x.id === boardId);
      if (!b || !Array.isArray(b.stickies)) return;
      b.stickies = b.stickies.filter(n => n.id !== noteId);
    });
  }

  syncLegacyNotesFromStickies() {
    const boards = this.state.noteBoards || [];
    const texts = [];
    boards.forEach(b => {
      (b.stickies || []).forEach(n => {
        const body = [n.title, n.text].filter(Boolean).join('\n');
        if (body.trim()) texts.push(body.trim());
      });
    });
    this.state.notes = texts.join('\n\n———\n\n');
    this.state.notesUpdatedAt = new Date().toISOString();
  }

  // --- Month rollover ---
  processMonthRollover() {
    const current = getCurrentMonth();
    if (this.state.lastMonthProcessed === current) return;

    let cursor = this.state.lastMonthProcessed;
    if (cursor && cursor !== current) {
      // Walk each skipped month so June isn't skipped when May → July
      let guard = 0;
      while (cursor && cursor < current && guard < 36) {
        this.saveMonthBudgetSnapshot(cursor, false);
        this.state.categories.forEach(cat => {
          // remaining = budget + prior carry + that month's envelope moves − spent.
          // Bake the whole remaining into carry for the next month (moves are not
          // re-applied later — getEnvelopeMoveDelta is month-scoped). Do NOT add
          // remaining on top of old carry again.
          const remaining = this.getCategoryRemaining(cat.id, cursor);
          cat.carryOver = Math.round(remaining * 100) / 100;
        });
        cursor = addMonths(cursor, 1);
        guard++;
      }
      rollRecurringBillsForNewMonth(this.state.bills, current);
    }
    this.state.lastMonthProcessed = current;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  // --- Income ---
  /** Planned income for a month — sum of pay-calendar dates & amounts (falls back to source.amount) */
  getSourceIncomeForMonth(source, month = getCurrentMonth()) {
    return sumSourceIncomeForMonth(source, month);
  }

  getTotalIncome(month = getCurrentMonth()) {
    return this.state.incomeSources
      .filter(s => !isBonusIncomeSource(s))
      .reduce((sum, s) => sum + sumSourceIncomeForMonth(s, month), 0);
  }

  syncSourceAmountFromSchedule(source, month = getCurrentMonth()) {
    if (!source || isBonusIncomeSource(source)) return;
    source.amount = sumSourceIncomeForMonth(source, month);
  }

  getBonusIncomeSource() {
    return this.state.incomeSources.find(isBonusIncomeSource) || null;
  }

  getBonusIncomeLogged(month = getCurrentMonth()) {
    const bonus = this.getBonusIncomeSource();
    if (!bonus) return 0;
    return this.getTransactionsForMonth(month)
      .filter(t => t.type === 'income'
        && t.incomeSourceId === bonus.id
        // Gift/earmark already boosted envelope carry — don't also inflate To Allocate
        && !t.earmarkedEnvelope)
      .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  }

  getAllocatableIncome(month = getCurrentMonth()) {
    return this.getTotalIncome(month) + this.getBonusIncomeLogged(month);
  }

  // --- Transactions ---
  getTransactionsForMonth(month = getCurrentMonth()) {
    return this.state.transactions.filter(t => isInMonth(t.date, month));
  }

  isSplitTransaction(tx) {
    return Array.isArray(tx?.splits) && tx.splits.length > 0;
  }

  normalizeSplits(splits) {
    if (!Array.isArray(splits)) return [];
    return splits
      .map(s => ({
        categoryId: s.categoryId || null,
        amount: Math.abs(Number(s.amount)) || 0,
      }))
      .filter(s => s.categoryId && s.amount > 0);
  }

  getSplitTotal(tx) {
    return (tx.splits || []).reduce((s, sp) => s + (Math.abs(Number(sp.amount)) || 0), 0);
  }

  splitsAreValid(totalAmount, splits) {
    const normalized = this.normalizeSplits(splits);
    if (!normalized.length) return false;
    const sum = normalized.reduce((s, sp) => s + sp.amount, 0);
    return Math.abs(sum - Math.abs(Number(totalAmount))) < 0.01;
  }

  getCategorySpent(categoryId, month = getCurrentMonth()) {
    return this.getCategoryTransactions(categoryId, { month, range: 'month' })
      .filter(t => t.type === 'expense' || t.type === 'debt_payment')
      .reduce((sum, t) => sum + (Number(t.envelopeAmount) || 0), 0);
  }

  /**
   * Transactions that spent from an envelope.
   * range: 'month' | '30d' | 'all'
   * Each item includes envelopeAmount (portion attributed to this category).
   */
  getCategoryTransactions(categoryId, opts = {}) {
    if (!categoryId) return [];
    const range = opts.range || (typeof opts === 'string' ? 'month' : 'month');
    // Back-compat: second arg was month string
    const month = typeof opts === 'string' ? opts : (opts.month || getCurrentMonth());

    let pool;
    if (range === 'all') {
      pool = [...(this.state.transactions || [])];
    } else if (range === '30d') {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const iso = formatLocalISODate(cutoff);
      pool = (this.state.transactions || []).filter(t => (t.date || '') >= iso);
    } else {
      pool = this.getTransactionsForMonth(month);
    }

    return pool
      .filter(t => {
        if (t.type === 'expense' || t.type === 'debt_payment') return true;
        // Gifts / earmarked income tied to this envelope
        if (t.type === 'income' && t.categoryId === categoryId) return true;
        return false;
      })
      .map(t => {
        if (this.isSplitTransaction(t)) {
          const split = t.splits.find(s => s.categoryId === categoryId);
          if (!split) return null;
          return { ...t, envelopeAmount: Math.abs(Number(split.amount)) || 0 };
        }
        if (t.categoryId === categoryId) {
          return { ...t, envelopeAmount: Math.abs(Number(t.amount)) || 0 };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.id).localeCompare(String(a.id)));
  }

  getTopEnvelopesBySpend(limit = 5, month = getCurrentMonth()) {
    return (this.state.categories || [])
      .filter(c => !c.parentId)
      .map(c => ({
        category: c,
        spent: this.getCategorySpent(c.id, month),
        budgeted: Number(c.monthlyBudget) || 0,
        remaining: this.getCategoryRemaining(c.id, month),
        health: this.getEnvelopeHealth(c.id, month),
      }))
      .filter(row => row.spent > 0)
      .sort((a, b) => b.spent - a.spent)
      .slice(0, limit);
  }

  getPendingTransactions() {
    return (this.state.transactions || [])
      .filter(t => t.clearingStatus === 'pending')
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.id).localeCompare(String(a.id)));
  }

  getBillTransactions(billId) {
    if (!billId) return [];
    return (this.state.transactions || [])
      .filter(t => t.billId === billId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  getDebtTransactions(debtId) {
    if (!debtId) return [];
    return (this.state.transactions || [])
      .filter(t => t.type === 'debt_payment' && t.debtId === debtId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  getDebtsForCategory(categoryId) {
    return (this.state.debts || [])
      .filter(d => !d.archived && (Number(d.balance) || 0) > 0 && d.categoryId === categoryId);
  }

  getBillsForCategory(categoryId) {
    return (this.state.bills || [])
      .filter(b => b.status !== 'paid' && b.categoryId === categoryId);
  }

  isDebtMinInBudget(debt) {
    const min = Number(debt.minPayment) || 0;
    if (!min || !debt.categoryId) return false;
    const cat = this.state.categories.find(c => c.id === debt.categoryId);
    return !!(cat && Number(cat.monthlyBudget) > 0);
  }

  getDebtPaidThisMonth(debtId, month = getCurrentMonth()) {
    return this.getTransactionsForMonth(month)
      .filter(t => t.type === 'debt_payment' && t.debtId === debtId)
      .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  }

  getTotalDebtPaid(month = getCurrentMonth()) {
    return this.getTransactionsForMonth(month)
      .filter(t => t.type === 'debt_payment')
      .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  }

  getMinDebtPaymentsOutsideBudget() {
    // On-hold debts (e.g. deferred student loans) don't claim budget mins
    return this.getSnowballDebts().reduce((s, d) => {
      if (this.isDebtMinInBudget(d)) return s;
      return s + (Number(d.minPayment) || 0);
    }, 0);
  }

  getRemainingMinDebtPaymentsOutsideBudget(month = getCurrentMonth()) {
    return this.getSnowballDebts().reduce((s, d) => {
      if (this.isDebtMinInBudget(d)) return s;
      const min = Number(d.minPayment) || 0;
      if (!min) return s;
      const paid = this.getDebtPaidThisMonth(d.id, month);
      return s + Math.max(0, min - paid);
    }, 0);
  }

  /** Income for surplus: paychecks logged this month, or planned monthly income if none yet */
  getEffectiveMonthlyIncome(month = getCurrentMonth()) {
    const logged = this.getTotalIncomeLogged(month);
    if (logged > 0) return logged;
    return this.getTotalIncome(month);
  }

  usesLoggedIncomeForSurplus(month = getCurrentMonth()) {
    return this.getTotalIncomeLogged(month) > 0;
  }

  /**
   * Net $ moved into this envelope for the month (from month-only envelope transfers).
   * Positive = received from other envelopes; negative = given away.
   */
  getEnvelopeMoveDelta(categoryId, month = getCurrentMonth()) {
    const moves = this.state.monthEnvelopeMoves?.[month];
    if (!Array.isArray(moves) || !moves.length) return 0;
    let net = 0;
    moves.forEach(m => {
      if (!m || typeof m !== 'object') return;
      const amt = Math.abs(Number(m.amount) || 0);
      if (!(amt > 0)) return;
      if (m.toId === categoryId) net += amt;
      if (m.fromId === categoryId) net -= amt;
    });
    return Math.round(net * 100) / 100;
  }

  getEnvelopeMoves(month = getCurrentMonth()) {
    const moves = this.state.monthEnvelopeMoves?.[month];
    return Array.isArray(moves) ? [...moves] : [];
  }

  /**
   * Move room from one envelope to another for this month only.
   * Does not change monthlyBudget (plan stays the same next month).
   * Checking is untouched — envelopes are labels on the same cash.
   */
  transferBetweenEnvelopes(fromId, toId, amount, { month = getCurrentMonth(), note = '' } = {}) {
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (!(amt > 0) || !fromId || !toId || fromId === toId) return null;
    const from = this.state.categories.find(c => c.id === fromId);
    const to = this.state.categories.find(c => c.id === toId);
    if (!from || !to) return null;
    const available = this.getCategoryRemaining(fromId, month);
    if (available + 0.001 < amt) return null;

    let move = null;
    this.update(s => {
      if (!s.monthEnvelopeMoves || typeof s.monthEnvelopeMoves !== 'object') {
        s.monthEnvelopeMoves = {};
      }
      if (!Array.isArray(s.monthEnvelopeMoves[month])) {
        s.monthEnvelopeMoves[month] = [];
      }
      move = {
        id: generateId(),
        fromId,
        toId,
        amount: amt,
        note: String(note || '').trim(),
        at: new Date().toISOString(),
      };
      s.monthEnvelopeMoves[month].push(move);
    });
    return move;
  }

  /** Undo a single month-only envelope move. */
  reverseEnvelopeTransfer(moveId, month = getCurrentMonth()) {
    let ok = false;
    this.update(s => {
      const list = s.monthEnvelopeMoves?.[month];
      if (!Array.isArray(list)) return;
      const next = list.filter(m => m.id !== moveId);
      if (next.length === list.length) return;
      s.monthEnvelopeMoves[month] = next;
      ok = true;
    });
    return ok;
  }

  /**
   * Budgeted amount for an envelope in a given month.
   * Current month = live monthlyBudget; past months use snapshot when available.
   */
  getCategoryBudgeted(categoryId, month = getCurrentMonth()) {
    if (month === getCurrentMonth()) {
      const cat = this.state.categories.find(c => c.id === categoryId);
      return Number(cat?.monthlyBudget) || 0;
    }
    return Number(this.getBudgetForMonth(categoryId, month)) || 0;
  }

  getCategoryRemaining(categoryId, month = getCurrentMonth()) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return 0;
    const budgeted = this.getCategoryBudgeted(categoryId, month);
    // Carry-over only applies to the live (current) month
    const isCurrent = month === getCurrentMonth();
    const carry = isCurrent ? (Number(cat.carryOver) || 0) : 0;
    const move = this.getEnvelopeMoveDelta(categoryId, month);
    const spent = this.getCategorySpent(categoryId, month);
    return Math.round((budgeted + carry + move - spent) * 100) / 100;
  }

  /** Available pool for progress bars (budget + carry + month moves). */
  getCategoryPool(categoryId, month = getCurrentMonth()) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return 0;
    const budgeted = this.getCategoryBudgeted(categoryId, month);
    const isCurrent = month === getCurrentMonth();
    const carry = isCurrent ? (Number(cat.carryOver) || 0) : 0;
    const move = this.getEnvelopeMoveDelta(categoryId, month);
    return Math.round((budgeted + carry + move) * 100) / 100;
  }

  getTotalBudgeted(month = getCurrentMonth()) {
    return (this.state.categories || [])
      .filter(c => !c.parentId)
      .reduce((s, c) => s + this.getCategoryBudgeted(c.id, month), 0);
  }

  /** Whether we have a saved budget snapshot for this month (past months). */
  hasMonthBudgetSnapshot(month) {
    const snap = this.state.monthBudgetSnapshots?.[month];
    return !!(snap && typeof snap === 'object' && Object.keys(snap).length);
  }

  getTotalSpent(month = getCurrentMonth()) {
    return this.getTransactionsForMonth(month)
      .filter(t => t.type === 'expense')
      .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  }

  getTotalIncomeLogged(month = getCurrentMonth()) {
    return this.getTransactionsForMonth(month)
      .filter(t => t.type === 'income')
      .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
  }

  getAllocatedToEnvelopes() {
    return this.state.categories.reduce((s, c) => {
      const remaining = this.getCategoryRemaining(c.id);
      const spent = this.getCategorySpent(c.id);
      return s + spent + Math.max(0, remaining);
    }, 0);
  }

  /** Income minus envelope budgets — same number as Budget "To Allocate" (may be negative if over-budgeted) */
  getUnallocatedFunds(month = getCurrentMonth()) {
    const income = this.getAllocatableIncome(month);
    const budgeted = this.getTotalBudgeted(month);
    return income - budgeted;
  }

  getToAllocate() {
    return this.getUnallocatedFunds();
  }

  /** Envelope remaining still “spoken for” this month (not free for snowball). */
  getStillAssignedEnvelopeCash(month = getCurrentMonth()) {
    return Math.round(
      (this.state.categories || [])
        .filter(c => c && !c.parentId)
        .reduce((s, c) => s + Math.max(0, this.getCategoryRemaining(c.id, month)), 0) * 100,
    ) / 100;
  }

  getCashFlowSurplus(month = getCurrentMonth()) {
    const income = this.getEffectiveMonthlyIncome(month);
    const totalSpent = this.getTotalSpent(month);
    const debtPaid = this.getTotalDebtPaid(month);
    const remainingMins = this.getRemainingMinDebtPaymentsOutsideBudget(month);
    // Money still sitting in envelopes is already assigned — not free for snowball mid-month
    const stillAssigned = this.getStillAssignedEnvelopeCash(month);
    return income - totalSpent - debtPaid - remainingMins - stillAssigned;
  }

  /**
   * Today-only free cash after bills before next pay + cushion (+ debt mins
   * outside envelopes). Used for “can I snowball this amount *today*?” runway.
   */
  getBankSurplusForSnowball(month = getCurrentMonth()) {
    const { freeCash } = this.getPayBridgeReserve(month);
    const remainingMins = this.getRemainingMinDebtPaymentsOutsideBudget(month);
    return Math.max(0, Math.round((freeCash - remainingMins) * 100) / 100);
  }

  /** Zero-based leftover: monthly income not assigned to envelopes (matches Budget "To Allocate") */
  getPlannedSnowballSurplus() {
    return Math.max(0, this.getToAllocate());
  }

  /**
   * Month-end snowball forecast: cash after remaining income lands, unpaid bills
   * and debt mins are paid, and the envelope plan is spent (still remaining).
   * Leave cushion. This is what you can throw at debt the last week of the month.
   */
  getMonthEndSnowballForecast(month = getCurrentMonth()) {
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const checking = r2(this.state.balances?.checking);
    const buffer = this.getSurplusCashBuffer();

    // Income still expected this month (checks not yet received)
    let incomeLeft = 0;
    const payStatus = this.getPaycheckStatus(month);
    payStatus.forEach(p => {
      (p.checks || []).forEach(c => {
        if (c.status === 'received') return;
        const amt = Number(c.amount) > 0 ? Number(c.amount) : (Number(p.perCheck) || 0);
        incomeLeft += amt;
      });
    });
    // Fallback when calendar empty: planned monthly income − already logged
    if (incomeLeft < 0.005) {
      const planned = this.getTotalIncome(month);
      const logged = this.getTotalIncomeLogged(month);
      incomeLeft = Math.max(0, planned - logged);
    }
    incomeLeft = r2(incomeLeft);

    // Unpaid bills due this month or earlier (same board as Bills → This month)
    const unpaidBills = (this.state.bills || []).filter(b => {
      if (!b || b.status === 'paid') return false;
      const due = String(b.dueDate || '').slice(0, 10);
      if (!due) return true;
      return due.slice(0, 7) <= month;
    });
    const billsLeft = r2(unpaidBills.reduce((s, b) => s + (Math.abs(Number(b.amount)) || 0), 0));
    const undatedBillCount = unpaidBills.filter(b => !b.dueDate).length;

    const debtMinsLeft = r2(this.getRemainingMinDebtPaymentsOutsideBudget(month));
    const envelopeLeft = this.getStillAssignedEnvelopeCash(month);

    const grossIn = r2(checking + incomeLeft);
    const livingAndObligations = r2(billsLeft + debtMinsLeft + envelopeLeft);
    // After income + after funding the plan + bills/mins, leave cushion
    const projected = r2(grossIn - livingAndObligations - buffer);
    const safe = Math.max(0, projected);

    return {
      month,
      checking,
      incomeLeft,
      billsLeft,
      debtMinsLeft,
      envelopeLeft,
      buffer,
      undatedBillCount,
      grossIn,
      livingAndObligations,
      projected,
      safe,
      toAllocate: r2(this.getToAllocate()),
    };
  }

  /**
   * Primary “safe snowball” number = month-end forecast (plan the last-week attack).
   * Today’s free cash is still available via getBankSurplusForSnowball / runway.
   */
  getUncappedSurplusForSnowball(month = getCurrentMonth()) {
    return this.getMonthEndSnowballForecast(month).safe;
  }

  /** Cash cushion kept after bills / snowball (Settings → surplusCashBuffer, default $50). */
  getSurplusCashBuffer() {
    const n = Number(this.state.settings?.surplusCashBuffer);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
    return 50;
  }

  /**
   * Cash reserved so bills due on/before the next paycheck don’t wipe checking.
   * freeCash = max(0, checking − bills − cushion).
   * Safe snowball extra ≤ freeCash.
   */
  getPayBridgeReserve(month = getCurrentMonth()) {
    const today = todayISO();
    const checking = Math.round((Number(this.state.balances?.checking) || 0) * 100) / 100;
    const buffer = this.getSurplusCashBuffer();
    const payStatus = this.getPaycheckStatus(month);

    const receivedKeys = new Set();
    payStatus.forEach(p => {
      (p.checks || []).forEach(c => {
        if (c.status === 'received' && c.date) {
          receivedKeys.add(`${p.id}|${String(c.date).slice(0, 10)}`);
        }
      });
    });

    const upcoming = [];
    payStatus.forEach(p => {
      (p.checks || []).forEach(c => {
        if (!c.date || c.status === 'received') return;
        upcoming.push({
          sourceId: p.id,
          date: String(c.date).slice(0, 10),
          amount: Number(c.amount) > 0 ? Number(c.amount) : (Number(p.perCheck) || 0),
        });
      });
      (p.upcoming || []).forEach(c => {
        if (!c.date) return;
        const date = String(c.date).slice(0, 10);
        if (date < today) return;
        if (receivedKeys.has(`${p.id}|${date}`)) return;
        upcoming.push({
          sourceId: p.id,
          date,
          amount: Number(c.amount) > 0 ? Number(c.amount) : (Number(p.perCheck) || 0),
        });
      });
    });

    const seen = new Set();
    const unique = upcoming.filter(c => {
      const key = `${c.sourceId}|${c.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.date.localeCompare(b.date));

    const nextPayDate = unique[0]?.date || null;
    const nextPayAmount = unique[0]
      ? Math.round(
        unique.filter(c => c.date === unique[0].date)
          .reduce((s, c) => s + (Number(c.amount) || 0), 0) * 100,
      ) / 100
      : 0;
    // No pay calendar: still protect near-term unpaid bills (14 days)
    const horizon = nextPayDate || (() => {
      const d = new Date(today + 'T12:00:00');
      d.setDate(d.getDate() + 14);
      return formatLocalISODate(d);
    })();

    const bills = (this.state.bills || [])
      .filter(b => {
        if (!b || b.status === 'paid') return false;
        const due = String(b.dueDate || '').slice(0, 10);
        if (!due) return true; // undated obligation — keep cash
        return due <= horizon;
      })
      .map(b => ({
        id: b.id,
        name: b.name,
        amount: Math.round((Number(b.amount) || 0) * 100) / 100,
        dueDate: b.dueDate ? String(b.dueDate).slice(0, 10) : null,
        undated: !b.dueDate,
      }))
      .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));

    const billsTotal = Math.round(
      bills.reduce((s, b) => s + (Number(b.amount) || 0), 0) * 100,
    ) / 100;

    // After snowball + bills, leave cushion in checking
    const reserved = Math.round((billsTotal + buffer) * 100) / 100;
    const freeCash = Math.max(0, Math.round((checking - reserved) * 100) / 100);

    const undatedBillCount = bills.filter(b => b.undated).length;

    return {
      checking,
      buffer,
      nextPayDate,
      nextPayAmount,
      horizon,
      billsTotal,
      billCount: bills.length,
      undatedBillCount,
      bills,
      reserved,
      freeCash,
      hasNextPay: !!nextPayDate,
    };
  }

  getSurplusForSnowball(month = getCurrentMonth()) {
    // Month-end forecast (not “send everything today”)
    return this.getMonthEndSnowballForecast(month).safe;
  }

  /** Cap / runway / forecast breakdown for UI notes. */
  getSurplusCapInfo(month = getCurrentMonth()) {
    const forecast = this.getMonthEndSnowballForecast(month);
    const reserve = this.getPayBridgeReserve(month);
    const bankToday = this.getBankSurplusForSnowball(month);
    const stillAssigned = forecast.envelopeLeft;
    const safe = forecast.safe;
    // “Raw” = forecast before cushion already applied inside forecast; use gross path
    const raw = Math.max(0, Math.round((forecast.grossIn - forecast.livingAndObligations) * 100) / 100);
    const capped = raw > safe + 0.005; // cushion held back
    return {
      raw,
      safe,
      capped,
      heldBack: Math.max(0, Math.round((raw - safe) * 100) / 100),
      stillAssigned,
      bankAvailable: bankToday,
      bankToday,
      forecast,
      toAllocate: forecast.toAllocate,
      planBlocksBank: forecast.toAllocate < -0.005,
      ...reserve,
      // Prefer forecast free-cash story for “safe”
      freeCash: bankToday,
    };
  }

  /**
   * Checking timeline if we send `snowballAmount` (defaults to safe surplus) to debt.
   */
  getCashRunway(snowballAmount = null, month = getCurrentMonth()) {
    const cap = this.getSurplusCapInfo(month);
    const surplus = snowballAmount != null
      ? Math.max(0, Math.round(Number(snowballAmount) * 100) / 100)
      : cap.safe;
    const afterSnowball = Math.round((cap.checking - surplus) * 100) / 100;
    const afterBills = Math.round((afterSnowball - cap.billsTotal) * 100) / 100;
    const afterNextPay = cap.nextPayAmount > 0
      ? Math.round((afterBills + cap.nextPayAmount) * 100) / 100
      : null;
    return {
      ...cap,
      surplus,
      afterSnowball,
      afterBills,
      afterNextPay,
      tight: afterBills < cap.buffer + 0.02,
      negative: afterBills < -0.02,
    };
  }

  getSurplusBasis(month = getCurrentMonth()) {
    const surplus = this.getSurplusForSnowball(month);
    if (surplus <= 0) return 'none';
    return 'month_end';
  }

  /** Soft warnings: undated bills, missing next pay, etc. */
  getBillScheduleWarnings() {
    const unpaid = (this.state.bills || []).filter(b => b && b.status !== 'paid');
    const undated = unpaid.filter(b => !b.dueDate);
    const cap = this.getPayBridgeReserve();
    const warnings = [];
    if (undated.length) {
      warnings.push({
        id: 'undated',
        severity: 'warn',
        label: `${undated.length} unpaid bill(s) have no due date — cash is held for them until dated`,
        count: undated.length,
      });
    }
    if (!cap.hasNextPay) {
      warnings.push({
        id: 'no_pay',
        severity: 'info',
        label: 'No upcoming paycheck on the calendar — runway uses a 14-day bill window',
      });
    }
    return warnings;
  }

  // --- Review inbox, rules, bills, health, paychecks, month close ---
  transactionNeedsReview(tx) {
    if (tx.type !== 'expense') return false;
    if (this.isSplitTransaction(tx)) return tx.splits.some(s => !s.categoryId);
    return !tx.categoryId;
  }

  getUncategorizedTransactions(month = getCurrentMonth()) {
    return this.getTransactionsForMonth(month).filter(t => this.transactionNeedsReview(t));
  }

  getPendingBillMatches(month = getCurrentMonth()) {
    const unpaid = (this.state.bills || []).filter(b => b.status !== 'paid');
    return this.getTransactionsForMonth(month)
      .filter(t => t.type === 'expense' && !t.billId)
      .map(t => {
        const bill = findBillForTransaction(t, unpaid);
        return bill ? { transaction: t, bill } : null;
      })
      .filter(Boolean);
  }

  getDuplicateTransactionMeta(month = null) {
    const meta = new Map();
    this.getDuplicateTransactionGroups(month).forEach(items => {
      items.forEach(tx => meta.set(tx.id, items.length));
    });
    return meta;
  }

  getDuplicateTransactionIds(month = null) {
    return new Set(this.getDuplicateTransactionMeta(month).keys());
  }

  getDuplicateTransactions(month = null) {
    const ids = this.getDuplicateTransactionIds(month);
    const txs = month
      ? this.getTransactionsForMonth(month)
      : (this.state.transactions || []);
    return txs.filter(t => ids.has(t.id));
  }

  getDuplicateTransactionGroups(month = null) {
    const txs = month
      ? this.getTransactionsForMonth(month)
      : (this.state.transactions || []);
    return clusterDuplicateTransactions(txs);
  }

  /** User confirmed these are legitimate (not double-posts). Stops review warnings. */
  markTransactionsUnique(ids) {
    const idSet = new Set((ids || []).filter(Boolean));
    if (!idSet.size) return 0;
    let n = 0;
    this.update(s => {
      s.transactions.forEach(t => {
        if (idSet.has(t.id)) {
          t.duplicateOk = true;
          n++;
        }
      });
    });
    return n;
  }

  getReviewInbox(month = getCurrentMonth()) {
    const uncategorized = this.getUncategorizedTransactions(month);
    const billMatches = this.getPendingBillMatches(month);
    const duplicates = this.getDuplicateTransactions(month);
    const pending = this.getPendingTransactions();
    // Unique txs — one row can sit in multiple queues (e.g. uncategorized + duplicate)
    const uniqueIds = new Set();
    uncategorized.forEach(t => uniqueIds.add(t.id));
    billMatches.forEach(m => { if (m.transaction?.id) uniqueIds.add(m.transaction.id); });
    duplicates.forEach(t => uniqueIds.add(t.id));
    pending.forEach(t => uniqueIds.add(t.id));
    return {
      uncategorized,
      billMatches,
      duplicates,
      pending,
      totalCount: uniqueIds.size,
    };
  }

  getEnvelopeHealth(categoryId, month = getCurrentMonth()) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return 'none';
    const pool = this.getCategoryPool(categoryId, month);
    if (pool <= 0) {
      const remaining = this.getCategoryRemaining(categoryId, month);
      return remaining < -0.005 ? 'over' : 'none';
    }
    const spent = this.getCategorySpent(categoryId, month);
    const remaining = this.getCategoryRemaining(categoryId, month);
    if (remaining < 0) return 'over';
    const pct = spent / pool;
    if (pct >= 1) return 'depleted';
    if (pct >= 0.8) return 'warning';
    return 'ok';
  }

  getEnvelopeHealthLabel(health) {
    return {
      none: '',
      ok: '',
      warning: '80%+ used',
      depleted: 'At limit',
      over: 'Over budget',
    }[health] || '';
  }

  /** Soft cap (regular envelope) or savings goal (sinking fund). 0 = none. */
  getCategoryGoal(categoryId) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    return cat ? Math.max(0, Number(cat.goalAmount) || 0) : 0;
  }

  /** True when budgeted amount is over the soft cap/goal. */
  isOverSoftCap(categoryId) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return false;
    const goal = Number(cat.goalAmount) || 0;
    if (goal <= 0) return false;
    return (Number(cat.monthlyBudget) || 0) > goal + 0.005;
  }

  /**
   * Progress toward soft cap / sinking goal.
   * funded = monthlyBudget (assigned this month plan).
   * For sinking funds, also show pool (budget + carry) as "saved".
   */
  getGoalProgress(categoryId) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return null;
    const goal = Number(cat.goalAmount) || 0;
    if (goal <= 0) return null;
    const budgeted = Number(cat.monthlyBudget) || 0;
    // Include month-only envelope moves so “saved” tracks remaining after rob-Peter moves
    const pool = this.getCategoryPool(categoryId);
    const over = budgeted > goal + 0.005;
    const pct = Math.min(100, Math.round((Math.max(0, pool) / goal) * 100));
    return {
      goal,
      budgeted,
      pool,
      over,
      pct,
      isSinking: !!cat.isSinkingFund,
    };
  }

  getEnvelopesOverSoftCap() {
    return (this.state.categories || [])
      .filter(c => !c.parentId && this.isOverSoftCap(c.id));
  }

  addCategoryRule({ pattern, type = 'category', categoryId = null, categoryIds = [] }) {
    const key = String(pattern || '').toLowerCase().trim();
    if (!key) return null;
    const rule = {
      id: generateId(),
      pattern: key,
      type,
      categoryId: type === 'category' ? categoryId : null,
      categoryIds: type === 'split' ? categoryIds.filter(Boolean) : [],
      createdAt: todayISO(),
    };
    this.update(s => {
      s.categoryRules = (s.categoryRules || []).filter(r => r.pattern !== key);
      s.categoryRules.push(rule);
    });
    return rule;
  }

  removeCategoryRule(id) {
    this.update(s => {
      s.categoryRules = (s.categoryRules || []).filter(r => r.id !== id);
    });
  }

  applyRulesToTransaction(tx, state = this.state) {
    if (tx.type !== 'expense' || tx.categoryId || this.isSplitTransaction(tx)) return false;
    const rule = findMatchingRule(tx.description, state.categoryRules || []);
    if (!rule) return false;
    return applyRuleToTransaction(tx, rule);
  }

  applyRulesToUncategorized(month = getCurrentMonth()) {
    let count = 0;
    this.update(s => {
      s.transactions.forEach(tx => {
        if (!isInMonth(tx.date, month)) return;
        if (!this.transactionNeedsReview(tx)) return;
        const copy = { ...tx };
        if (this.applyRulesToTransaction(copy, s)) {
          Object.assign(tx, {
            categoryId: copy.categoryId || null,
            splits: copy.splits,
            importCategory: copy.importCategory,
          });
          if (copy.categoryId || copy.splits) count++;
        }
      });
    });
    return count;
  }

  bulkCategorizeTransactions(ids, categoryId) {
    this.update(s => {
      ids.forEach(id => {
        const tx = s.transactions.find(t => t.id === id);
        if (!tx || tx.type !== 'expense') return;
        tx.categoryId = categoryId || null;
        tx.importCategory = null;
        delete tx.splits;
      });
    });
  }

  linkTransactionToBill(txId, billId) {
    this.update(s => {
      const tx = s.transactions.find(t => t.id === txId);
      const bill = s.bills.find(b => b.id === billId);
      if (!tx || !bill || bill.status === 'paid') return;
      tx.billId = billId;
      const paidAmt = Math.abs(Number(tx.amount)) || Number(bill.amount);
      const paidDate = tx.date || todayISO();
      completeBillPaymentCycle(bill, paidDate, paidAmt);
    });
  }

  /**
   * Strong auto-pay match: link tx → bill and advance recurring cycle.
   * Safe to call inside an existing update() with state `s`, or alone.
   * @param {Set<string>} [alreadyPaidBillIds] — bills already completed in this import batch
   * @returns {boolean}
   */
  applyAutoPayBillIfMatched(tx, s = this.state, stats = null, alreadyPaidBillIds = null) {
    if (!tx || tx.type !== 'expense' || tx.billId) return false;
    const bill = findAutoPayBillForTransaction(tx, s.bills || []);
    if (!bill || bill.status === 'paid') return false;
    // One auto-pay completion per bill per import — prevents double-advance when
    // two similar charges appear on the same statement
    if (alreadyPaidBillIds?.has(bill.id)) return false;
    tx.billId = bill.id;
    if (!tx.categoryId && bill.categoryId) tx.categoryId = bill.categoryId;
    const paidAmt = Math.abs(Number(tx.amount)) || Number(bill.amount) || 0;
    const paidDate = tx.date || todayISO();
    completeBillPaymentCycle(bill, paidDate, paidAmt);
    alreadyPaidBillIds?.add(bill.id);
    if (stats) {
      stats.billMatches = (stats.billMatches || 0) + 1;
      stats.autoPayBills = (stats.autoPayBills || 0) + 1;
    }
    return true;
  }

  isDaveRamseyMode() {
    return !!this.state.settings?.daveRamseyMode;
  }

  /**
   * Soft check: would this expense amount put the envelope under $0 remaining?
   * @param {string|null} categoryId
   * @param {number} amount
   * @param {{ excludeTxId?: string, splits?: array }} [opts]
   */
  wouldOverspendEnvelope(categoryId, amount, opts = {}) {
    if (!categoryId && !opts.splits?.length) return null;
    if (opts.splits?.length) {
      for (const sp of opts.splits) {
        if (!sp.categoryId) continue;
        const hit = this.wouldOverspendEnvelope(sp.categoryId, sp.amount, { excludeTxId: opts.excludeTxId });
        if (hit) return hit;
      }
      return null;
    }
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return null;
    let remaining = this.getCategoryRemaining(categoryId);
    if (opts.excludeTxId) {
      const old = this.state.transactions.find(t => t.id === opts.excludeTxId);
      if (old) {
        if (this.isSplitTransaction(old)) {
          const sp = (old.splits || []).find(x => x.categoryId === categoryId);
          if (sp) remaining += Math.abs(Number(sp.amount)) || 0;
        } else if (old.categoryId === categoryId) {
          remaining += Math.abs(Number(old.amount)) || 0;
        }
      }
    }
    const spend = Math.abs(Number(amount)) || 0;
    if (remaining - spend >= -0.005) return null;
    return {
      categoryId,
      categoryName: cat.name,
      remaining,
      amount: spend,
      overBy: Math.round((spend - remaining) * 100) / 100,
    };
  }

  getBillsPaidInMonth(month = getCurrentMonth()) {
    return (this.state.bills || [])
      .filter(b => {
        const d = b.lastPaidDate || (b.status === 'paid' ? b.paidDate : null);
        return d && String(d).startsWith(month);
      })
      .sort((a, b) => {
        const da = a.lastPaidDate || a.paidDate || '';
        const db = b.lastPaidDate || b.paidDate || '';
        return db.localeCompare(da);
      });
  }

  linkAllBillMatches(month = getCurrentMonth()) {
    const matches = this.getPendingBillMatches(month);
    matches.forEach(({ transaction, bill }) => {
      this.linkTransactionToBill(transaction.id, bill.id);
    });
    return matches.length;
  }

  saveMonthBudgetSnapshot(month = getCurrentMonth(), persist = true) {
    const snapshot = {};
    this.state.categories.forEach(cat => {
      snapshot[cat.id] = Number(cat.monthlyBudget) || 0;
    });
    this.state.monthBudgetSnapshots[month] = snapshot;
    if (persist) this.saveSilently();
  }

  copyBudgetFromMonth(fromMonth) {
    const snapshot = this.state.monthBudgetSnapshots[fromMonth];
    if (!snapshot) return false;
    this.update(s => {
      s.categories.forEach(cat => {
        if (snapshot[cat.id] != null) cat.monthlyBudget = snapshot[cat.id];
      });
    });
    return true;
  }

  getBudgetForMonth(categoryId, month = getCurrentMonth()) {
    // Live plan for the open month — snapshots are frozen history for past months
    if (month === getCurrentMonth()) {
      const cat = this.state.categories.find(c => c.id === categoryId);
      return Number(cat?.monthlyBudget) || 0;
    }
    const snap = this.state.monthBudgetSnapshots?.[month];
    if (snap && snap[categoryId] != null) return Number(snap[categoryId]) || 0;
    const cat = this.state.categories.find(c => c.id === categoryId);
    return Number(cat?.monthlyBudget) || 0;
  }

  incomeMatchesSource(tx, source) {
    return transactionMatchesIncomeSource(tx, source);
  }

  applyImportedIncome(s, tx) {
    const source = resolveIncomeSource(tx.description, s.incomeSources, {
      date: tx.date,
      amount: tx.amount,
    });
    if (!source) return false;
    tx.incomeSourceId = source.id;
    const src = s.incomeSources.find(i => i.id === source.id);
    if (!src) return false;
    if (isBonusIncomeSource(src)) return true;
    const { paySchedule, monthlyAmount } = syncPaycheckFromImport(src, tx.date, tx.amount);
    src.paySchedule = paySchedule;
    src.amount = monthlyAmount;
    return true;
  }

  getIncomePerCheck(source) {
    return getDefaultPerCheckAmount(source);
  }

  setPaySchedule(sourceId, paySchedule) {
    this.update(s => {
      const src = s.incomeSources.find(i => i.id === sourceId);
      if (!src) return;
      src.paySchedule = normalizePaySchedule(paySchedule);
      this.syncSourceAmountFromSchedule(src);
    });
  }

  addPayCheck(sourceId, date, amount = null) {
    const iso = String(date).slice(0, 10);
    this.update(s => {
      const src = s.incomeSources.find(i => i.id === sourceId);
      if (!src) return;
      const sched = normalizePaySchedule(src.paySchedule);
      sched.mode = 'dates';
      sched.checks = sched.checks.filter(c => c.date !== iso);
      sched.checks.push({ date: iso, amount: amount != null ? Number(amount) : null });
      sched.checks.sort((a, b) => a.date.localeCompare(b.date));
      src.paySchedule = sched;
      this.syncSourceAmountFromSchedule(src);
    });
  }

  removePayCheck(sourceId, date) {
    const iso = String(date).slice(0, 10);
    this.update(s => {
      const src = s.incomeSources.find(i => i.id === sourceId);
      if (!src) return;
      const sched = normalizePaySchedule(src.paySchedule);
      sched.checks = sched.checks.filter(c => c.date !== iso);
      src.paySchedule = sched;
      this.syncSourceAmountFromSchedule(src);
    });
  }

  getPaycheckStatus(month = getCurrentMonth()) {
    const monthTx = this.getTransactionsForMonth(month).filter(t => t.type === 'income');
    const allIncomeTx = (this.state.transactions || []).filter(t => t.type === 'income');

    return (this.state.incomeSources || []).filter(s => !isBonusIncomeSource(s)).map(source => {
      const scheduled = getScheduledChecksForMonth(source, month);
      const usedTx = new Set();

      const checks = scheduled.map(check => {
        const tx = matchCheckToTransaction(check, monthTx.filter(t => !usedTx.has(t.id)), source)
          || matchCheckToTransaction(check, allIncomeTx.filter(t => !usedTx.has(t.id) && t.date?.startsWith(month)), source);
        if (tx) usedTx.add(tx.id);
        return {
          ...check,
          status: resolveCheckStatus(check, tx),
          transactionId: tx?.id || null,
          receivedAmount: tx ? Math.abs(Number(tx.amount)) : 0,
        };
      });

      const received = checks.reduce((s, c) => s + (c.receivedAmount || 0), 0);
      const expectedFromChecks = checks.reduce((s, c) => s + c.amount, 0);
      const expected = expectedFromChecks > 0 ? expectedFromChecks : Number(source.amount) || 0;
      const checksReceived = checks.filter(c => c.status === 'received').length;

      let status = 'pending';
      if (checks.length && checksReceived === checks.length) status = 'complete';
      else if (expected > 0 && received >= expected * 0.98) status = 'complete';
      else if (received > 0 || checksReceived > 0) status = 'partial';

      const sched = normalizePaySchedule(source.paySchedule);
      const upcoming = getUpcomingChecks(source, { limit: 4 });

      return {
        id: source.id,
        name: source.name,
        type: source.type,
        expected,
        received,
        checksExpected: checks.length,
        checksReceived,
        checks,
        upcoming,
        scheduleMode: sched.mode,
        status,
        perCheck: this.getIncomePerCheck(source),
      };
    });
  }

  getPayCalendarYears(source) {
    const sched = normalizePaySchedule(source.paySchedule);
    const years = new Set(sched.checks.map(c => c.date.slice(0, 4)));
    const currentYear = new Date().getFullYear();
    years.add(String(currentYear));
    years.add(String(currentYear + 1));
    return [...years].sort();
  }

  getMonthCloseStatus(month = getCurrentMonth()) {
    const inbox = this.getReviewInbox(month);
    const alreadyClosed = (this.state.monthCloseLog || []).some(e => e.month === month);
    const overCap = this.getEnvelopesOverSoftCap();
    return {
      month,
      alreadyClosed,
      uncategorized: inbox.uncategorized.length,
      billMatches: inbox.billMatches.length,
      toAllocate: this.getToAllocate(),
      surplus: this.getSurplusForSnowball(month),
      overCapCount: overCap.length,
      steps: [
        { id: 'review', label: 'Review uncategorized transactions', done: inbox.uncategorized.length === 0, count: inbox.uncategorized.length },
        { id: 'bills', label: 'Link bills to bank transactions', done: inbox.billMatches.length === 0, count: inbox.billMatches.length },
        { id: 'allocate', label: 'Zero-based budget (To Allocate = $0)', done: Math.abs(this.getToAllocate()) < 0.01, count: this.getToAllocate() },
        { id: 'caps', label: 'Review envelopes over soft cap / goal', done: overCap.length === 0, count: overCap.length },
        { id: 'surplus', label: 'Allocate surplus to debt snowball', done: this.getSurplusForSnowball(month) <= 0 || !this.getSnowballDebts().length, count: this.getSurplusForSnowball(month) },
      ],
    };
  }

  closeMonth(month = getCurrentMonth()) {
    this.saveMonthBudgetSnapshot(month, false);
    this.update(s => {
      if (!s.monthCloseLog.some(e => e.month === month)) {
        s.monthCloseLog.unshift({ month, closedAt: new Date().toISOString() });
      }
    });
  }

  setReconciliation(bankBalance, asOfDate = todayISO()) {
    this.update(s => {
      s.reconciliation = {
        bankBalance: Number(bankBalance),
        asOfDate,
      };
    });
  }

  getReconciliationStatus() {
    const logged = Number(this.state.balances.checking) || 0;
    const bank = this.state.reconciliation?.bankBalance;
    if (bank == null || Number.isNaN(Number(bank))) {
      return { logged, bankBalance: null, gap: null, matched: null, asOfDate: null };
    }
    const bankBalance = Number(bank);
    const gap = Math.round((bankBalance - logged) * 100) / 100;
    return {
      logged,
      bankBalance,
      gap,
      matched: Math.abs(gap) < 0.02,
      asOfDate: this.state.reconciliation.asOfDate,
    };
  }

  findReconciliationCandidates(gap, asOfDate = this.state.reconciliation?.asOfDate || todayISO()) {
    return findReconciliationCandidates(
      this.state.transactions,
      gap,
      asOfDate,
      (type, amount, status) => this.getCheckingDelta(type, amount, status),
    );
  }

  getReconciliationMatches() {
    const status = this.getReconciliationStatus();
    if (status.matched || status.gap == null) {
      return { ...status, candidates: [] };
    }
    return {
      ...status,
      candidates: this.findReconciliationCandidates(status.gap, status.asOfDate),
    };
  }

  getMonthlyTrends(monthCount = 6) {
    const months = getRecentMonths(monthCount);
    return months.map(month => {
      const byCategory = {};
      this.state.categories.forEach(cat => {
        const spent = this.getCategorySpent(cat.id, month);
        if (spent > 0) byCategory[cat.name] = spent;
      });
      return {
        month,
        income: this.getTotalIncomeLogged(month),
        spent: this.getTotalSpent(month),
        budgeted: this.state.categories.reduce(
          (s, c) => s + this.getBudgetForMonth(c.id, month), 0,
        ),
        debtPaid: this.getTotalDebtPaid(month),
        byCategory,
      };
    });
  }

  getCategoryTrend(categoryId, monthCount = 6) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return [];
    return getRecentMonths(monthCount).map(month => ({
      month,
      spent: this.getCategorySpent(categoryId, month),
      budgeted: this.getBudgetForMonth(categoryId, month),
    }));
  }

  // --- Debts ---
  /** Non-archived with a balance (includes on-hold). Sorted smallest → largest. */
  getActiveDebts() {
    return [...this.state.debts]
      .filter(d => !d.archived && (Number(d.balance) || 0) > 0)
      .sort((a, b) => (Number(a.balance) || 0) - (Number(b.balance) || 0));
  }

  /**
   * Debts in the snowball attack list (excludes on-hold).
   * Use for target, surplus extra, and payoff ETA while e.g. student loans are deferred in school.
   */
  getSnowballDebts() {
    return this.getActiveDebts().filter(d => !d.paused);
  }

  getPausedDebts() {
    return this.getActiveDebts().filter(d => !!d.paused);
  }

  setDebtPaused(id, paused = true) {
    this.update(s => {
      const d = s.debts.find(x => x.id === id);
      if (!d) return;
      d.paused = !!paused;
      if (paused) d.pausedAt = todayISO();
      else delete d.pausedAt;
    });
  }

  getSnowballTarget() {
    const debts = this.getSnowballDebts();
    return debts[0] || null;
  }

  getTotalDebt() {
    return this.getActiveDebts().reduce((s, d) => s + (Number(d.balance) || 0), 0);
  }

  /** Balance only on debts currently in the snowball (excludes on-hold). */
  getSnowballDebtTotal() {
    return this.getSnowballDebts().reduce((s, d) => s + (Number(d.balance) || 0), 0);
  }

  getSnowballPayment(debt) {
    if (!debt || debt.paused) return Number(debt?.minPayment) || 0;
    const debts = this.getSnowballDebts();
    const idx = debts.findIndex(d => d.id === debt.id);
    if (idx < 0) return Number(debt.minPayment) || 0;
    if (idx === 0) return (Number(debt.minPayment) || 0) + this.getSurplusForSnowball();
    return Number(debt.minPayment) || 0;
  }

  /**
   * Rough months to clear the *snowball* list (on-hold debts are not simulated).
   * Total owed may still include student loans on hold.
   */
  estimateMonthsToDebtFree() {
    const debts = this.getSnowballDebts();
    if (!debts.length) return 0;
    let months = 0;
    const surplus = this.getSurplusForSnowball();
    const sim = debts.map(d => ({ balance: Number(d.balance) || 0, min: Number(d.minPayment) || 0 }));
    let safety = 600;
    while (sim.some(d => d.balance > 0.005) && safety-- > 0) {
      months++;
      let extra = surplus;
      for (const d of sim) {
        if (d.balance <= 0.005) continue;
        // Min + cascading extra from debts paid off earlier this simulated month
        const available = d.min + extra;
        const pay = Math.min(d.balance, available);
        d.balance = Math.round((d.balance - pay) * 100) / 100;
        extra = Math.round((available - pay) * 100) / 100;
        if (d.balance > 0.005) {
          extra = 0;
          break;
        }
        // Paid off — leftover extra continues to the next debt this month
      }
    }
    return months;
  }

  // --- Baby Step ---
  detectBabyStep() {
    const ef = Number(this.state.balances.emergencyFund) || 0;
    const totalDebt = this.getTotalDebt();
    const monthlyExpenses = this.getTotalBudgeted() || 3000;

    if (totalDebt > 0) {
      if (ef < 1000) return 1;
      return 2;
    }
    if (ef < monthlyExpenses * 3) return 3;
    return Math.max(this.state.babyStep, 3);
  }

  getEmergencyFundTarget() {
    const step = this.detectBabyStep();
    if (step === 1) return 1000;
    const monthly = this.getTotalBudgeted() || 3000;
    return monthly * 6;
  }

  // --- Actions ---
  /** Checking impact for a cleared transaction. Pending never moves checking. */
  getCheckingDelta(type, amount, clearingStatus = 'cleared') {
    if (clearingStatus === 'pending') return 0;
    const num = Math.abs(Number(amount)) || 0;
    if (type === 'income') return num;
    if (type === 'expense' || type === 'debt_payment' || type === 'transfer') return -num;
    return 0;
  }

  applyCheckingDelta(state, delta) {
    if (!delta) return;
    state.balances.checking = (Number(state.balances.checking) || 0) + delta;
  }

  isPending(tx) {
    return isTransactionPending(tx);
  }

  adjustDebtForPayment(state, debtId, paymentDelta) {
    if (!debtId || !paymentDelta) return;
    const debt = state.debts.find(d => d.id === debtId);
    if (!debt) return;
    debt.balance = Math.max(0, (Number(debt.balance) || 0) - paymentDelta);
  }

  /** Reverse gift/earmark carry-over when deleting or changing an earmarked income row. */
  reverseEarmarkCarry(state, tx, sign = -1) {
    if (!tx || tx.type !== 'income' || !tx.earmarkedEnvelope || !tx.categoryId) return;
    const cat = state.categories.find(c => c.id === tx.categoryId);
    if (!cat) return;
    const amt = Math.abs(Number(tx.amount) || 0);
    if (!amt) return;
    cat.carryOver = Math.round(((Number(cat.carryOver) || 0) + sign * amt) * 100) / 100;
  }

  /** Remove a transaction and reverse checking / debt / earmark impact. */
  deleteTransaction(id) {
    let removed = false;
    let snapshot = null;
    this.update(s => {
      const tx = s.transactions.find(x => x.id === id);
      if (!tx) return;
      snapshot = JSON.parse(JSON.stringify(tx));
      const status = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
      this.applyCheckingDelta(s, -this.getCheckingDelta(tx.type, tx.amount, status));
      if (tx.type === 'debt_payment' && tx.debtId) {
        this.adjustDebtForPayment(s, tx.debtId, -Math.abs(Number(tx.amount) || 0));
      }
      this.reverseEarmarkCarry(s, tx, -1);
      s.transactions = s.transactions.filter(x => x.id !== id);
      removed = true;
    });
    if (removed && snapshot) {
      this._lastUndo = { type: 'restore_tx', tx: snapshot, at: Date.now() };
    }
    return removed;
  }

  /** Re-insert a previously deleted transaction (undo). */
  restoreDeletedTransaction(txSnapshot) {
    if (!txSnapshot?.id) return false;
    let ok = false;
    this.update(s => {
      if (s.transactions.some(t => t.id === txSnapshot.id)) return;
      const tx = JSON.parse(JSON.stringify(txSnapshot));
      s.transactions.unshift(tx);
      const status = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
      this.applyCheckingDelta(s, this.getCheckingDelta(tx.type, tx.amount, status));
      if (tx.type === 'debt_payment' && tx.debtId) {
        this.adjustDebtForPayment(s, tx.debtId, Math.abs(Number(tx.amount) || 0));
      }
      if (tx.earmarkedEnvelope && tx.type === 'income' && tx.categoryId) {
        this.reverseEarmarkCarry(s, tx, +1);
      }
      ok = true;
    });
    if (ok) this._lastUndo = null;
    return ok;
  }

  undoLastAction() {
    const u = this._lastUndo;
    if (!u || (Date.now() - (u.at || 0)) > 60000) {
      this._lastUndo = null;
      return { ok: false, reason: 'expired' };
    }
    if (u.type === 'restore_tx') {
      const ok = this.restoreDeletedTransaction(u.tx);
      return { ok, type: 'restore_tx' };
    }
    if (u.type === 'snowball') {
      const ok = this.undoSnowballAllocate(u);
      return { ok, type: 'snowball' };
    }
    return { ok: false, reason: 'unknown' };
  }

  undoSnowballAllocate(payload) {
    if (!payload?.txId || !(payload.pay > 0)) return false;
    let ok = false;
    this.update(s => {
      const tx = s.transactions.find(t => t.id === payload.txId);
      if (tx) {
        const status = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
        this.applyCheckingDelta(s, -this.getCheckingDelta(tx.type, tx.amount, status));
        s.transactions = s.transactions.filter(t => t.id !== payload.txId);
      } else {
        // Tx gone — still reverse checking if we recorded pay
        s.balances.checking = (Number(s.balances.checking) || 0) + payload.pay;
      }
      const debt = s.debts.find(d => d.id === payload.debtId);
      if (debt) {
        debt.balance = (Number(debt.balance) || 0) + payload.pay;
        debt.archived = false;
        delete debt.paidOffDate;
      }
      if (payload.categoryId && payload.budgetBump) {
        const cat = s.categories.find(c => c.id === payload.categoryId);
        if (cat) {
          cat.monthlyBudget = Math.max(0, (Number(cat.monthlyBudget) || 0) - payload.budgetBump);
        }
      }
      ok = true;
    });
    if (ok) this._lastUndo = null;
    return ok;
  }

  removeCategory(id) {
    this.update(s => {
      const cat = s.categories.find(c => c.id === id);
      if (!cat) return;

      const nameKey = cat.name.toLowerCase();
      if (BUILT_IN_CATEGORY_NAMES.has(nameKey)) {
        if (!s.removedDefaultCategories.includes(nameKey)) {
          s.removedDefaultCategories.push(nameKey);
        }
      }

      s.categories = s.categories.filter(c => c.id !== id);
      s.transactions.forEach(t => {
        if (t.categoryId === id) t.categoryId = null;
        if (t.splits) {
          t.splits.forEach(sp => { if (sp.categoryId === id) sp.categoryId = null; });
        }
      });
      s.bills.forEach(b => { if (b.categoryId === id) b.categoryId = null; });
      s.debts.forEach(d => { if (d.categoryId === id) d.categoryId = null; });
    });
  }

  /**
   * Manual expense/income default to pending (no checking impact) unless
   * postToChecking / clearingStatus: 'cleared'. Debt payments & transfers default cleared.
   */
  addTransaction({
    date, amount, type, categoryId, description, billId, debtId, splits,
    clearingStatus, postToChecking = false, incomeSourceId = null,
    memo = '',
    /** When true (income): also add amount to envelope carryOver (gift / earmarked). */
    earmarkToEnvelope = false,
  }) {
    const num = Math.abs(Number(amount));
    if (!num) return null;
    const normalizedSplits = this.normalizeSplits(splits);
    const useSplits = normalizedSplits.length > 0 && type === 'expense';
    const wantsPending = type === 'expense' || type === 'income';
    const status = clearingStatus
      || (postToChecking ? 'cleared' : null)
      || (wantsPending ? 'pending' : 'cleared');
    const memoText = typeof memo === 'string' ? memo.trim() : '';

    let newId = null;
    this.update(s => {
      const newTx = {
        id: generateId(),
        date: date || todayISO(),
        amount: num,
        type,
        categoryId: useSplits ? null : (categoryId || null),
        description: description || '',
        memo: memoText,
        billId: billId || null,
        debtId: debtId || null,
        clearingStatus: status,
        ...(incomeSourceId ? { incomeSourceId } : {}),
        ...(useSplits ? { splits: normalizedSplits } : {}),
        ...(earmarkToEnvelope && type === 'income' && categoryId ? { earmarkedEnvelope: true } : {}),
      };
      if (type === 'income') {
        if (status === 'cleared') this.applyImportedIncome(s, newTx);
        if (!newTx.incomeSourceId) {
          const src = resolveIncomeSource(newTx.description, s.incomeSources, {
            date: newTx.date,
            amount: newTx.amount,
          });
          if (src) newTx.incomeSourceId = src.id;
        }
      }
      s.transactions.unshift(newTx);
      this.applyCheckingDelta(s, this.getCheckingDelta(type, num, status));
      if (type === 'debt_payment' && debtId) {
        this.adjustDebtForPayment(s, debtId, num);
      }
      // Gift / earmarked: raise envelope available via carry-over (does not change monthly plan)
      if (earmarkToEnvelope && type === 'income' && categoryId) {
        const cat = s.categories.find(c => c.id === categoryId);
        if (cat) {
          cat.carryOver = Math.round(((Number(cat.carryOver) || 0) + num) * 100) / 100;
        }
      }
      newId = newTx.id;
    });
    return newId;
  }

  /** Envelopes that have a non-empty note (for dashboard attention). */
  getEnvelopesWithNotes() {
    return (this.state.categories || [])
      .filter(c => !c.parentId && String(c.note || '').trim());
  }

  setEnvelopeNote(categoryId, note) {
    const text = typeof note === 'string' ? note.trim() : '';
    this.update(s => {
      const c = s.categories.find(x => x.id === categoryId);
      if (c) c.note = text;
    });
  }

  /**
   * Log gift/earmarked money: income (checking if cleared) + add to envelope carry-over.
   * Net To Allocate unchanged when cleared (income + virtual fund cancel out).
   */
  addGiftToEnvelope({
    amount, categoryId, description = '', memo = '', date, postToChecking = true,
  } = {}) {
    const num = Math.abs(Number(amount));
    if (!num || !categoryId) return null;
    const cat = this.state.categories.find(c => c.id === categoryId);
    const desc = (description || '').trim()
      || (cat ? `Gift → ${cat.name}` : 'Gift / earmarked');
    return this.addTransaction({
      date: date || todayISO(),
      amount: num,
      type: 'income',
      categoryId,
      description: desc,
      memo: memo || '',
      clearingStatus: postToChecking ? 'cleared' : 'pending',
      earmarkToEnvelope: true,
    });
  }

  updateTransaction(id, updates) {
    this.update(s => {
      const tx = s.transactions.find(x => x.id === id);
      if (!tx) return;

      const oldType = tx.type;
      const oldAmount = Math.abs(Number(tx.amount)) || 0;
      const oldStatus = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
      const oldCategoryId = tx.categoryId;
      const wasEarmarked = !!(tx.earmarkedEnvelope && oldType === 'income' && oldCategoryId);
      const newType = updates.type ?? tx.type;
      const newAmount = updates.amount !== undefined ? Math.abs(Number(updates.amount)) : oldAmount;
      const newStatus = updates.clearingStatus !== undefined
        ? (updates.clearingStatus === 'pending' ? 'pending' : 'cleared')
        : oldStatus;

      // Undo prior earmark before amount/category changes
      if (wasEarmarked) this.reverseEarmarkCarry(s, tx, -1);

      const oldDelta = this.getCheckingDelta(oldType, oldAmount, oldStatus);
      const newDelta = this.getCheckingDelta(newType, newAmount, newStatus);
      this.applyCheckingDelta(s, -oldDelta + newDelta);

      if (oldType === 'debt_payment' && tx.debtId) {
        this.adjustDebtForPayment(s, tx.debtId, -oldAmount);
      }
      if (newType === 'debt_payment' && tx.debtId) {
        this.adjustDebtForPayment(s, tx.debtId, newAmount);
      }

      if (updates.date !== undefined) tx.date = updates.date;
      if (updates.amount !== undefined) tx.amount = newAmount;
      if (updates.type !== undefined) tx.type = newType;
      if (updates.description !== undefined) tx.description = updates.description || '';
      if (updates.memo !== undefined) tx.memo = String(updates.memo || '').trim();
      if (updates.clearingStatus !== undefined) tx.clearingStatus = newStatus;
      if (updates.splits !== undefined) {
        const normalizedSplits = this.normalizeSplits(updates.splits);
        if (normalizedSplits.length) {
          tx.splits = normalizedSplits;
          tx.categoryId = null;
          tx.importCategory = null;
        } else {
          delete tx.splits;
        }
      }
      if (updates.categoryId !== undefined) {
        tx.categoryId = updates.categoryId || null;
        if (updates.categoryId) {
          tx.importCategory = null;
          delete tx.splits;
        }
      }
      if (updates.debtId !== undefined) tx.debtId = updates.debtId || null;
      if (updates.incomeSourceId !== undefined) {
        tx.incomeSourceId = updates.incomeSourceId || null;
      }

      // Drop earmark flag if no longer income-with-envelope
      if (tx.type !== 'income' || !tx.categoryId) {
        delete tx.earmarkedEnvelope;
      }

      // Re-apply earmark carry if still gift-earmarked
      if (tx.earmarkedEnvelope && tx.type === 'income' && tx.categoryId) {
        this.reverseEarmarkCarry(s, tx, +1);
      }

      // Income linkage when first cleared
      if (newType === 'income' && newStatus === 'cleared' && oldStatus === 'pending') {
        this.applyImportedIncome(s, tx);
      }
      // Manual source pick wins; otherwise auto-link when still unset
      if (newType === 'income' && !tx.incomeSourceId) {
        const src = resolveIncomeSource(tx.description, s.incomeSources, {
          date: tx.date,
          amount: tx.amount,
        });
        if (src) tx.incomeSourceId = src.id;
      }
      // When user labels a planned source on a cleared deposit, sync pay schedule
      if (
        newType === 'income'
        && updates.incomeSourceId
        && tx.incomeSourceId
        && newStatus === 'cleared'
      ) {
        const src = s.incomeSources.find(i => i.id === tx.incomeSourceId);
        if (src && !isBonusIncomeSource(src)) {
          const { paySchedule, monthlyAmount } = syncPaycheckFromImport(src, tx.date, tx.amount);
          src.paySchedule = paySchedule;
          src.amount = monthlyAmount;
        }
      }
    });
  }

  /**
   * Assign dollars a job in an envelope (virtual). Does NOT move bank checking —
   * money stays in the account; only monthlyBudget / To Allocate change.
   */
  fundEnvelope(categoryId, amount) {
    const num = Number(amount);
    if (num <= 0) return;
    this.update(s => {
      const cat = s.categories.find(c => c.id === categoryId);
      if (!cat) return;
      cat.monthlyBudget = (Number(cat.monthlyBudget) || 0) + num;
    });
  }

  /**
   * Zero carry-over on one envelope (forgive prior-month overspend or drop leftover).
   * Does not change monthlyBudget, spending history, or checking.
   */
  resetEnvelopeCarryOver(categoryId) {
    let prev = null;
    this.update(s => {
      const cat = s.categories.find(c => c.id === categoryId);
      if (!cat) return;
      prev = Number(cat.carryOver) || 0;
      cat.carryOver = 0;
    });
    return prev;
  }

  /**
   * Clear all negative carry-overs (start this month without “owing” last month).
   * @returns {number} how many envelopes were cleared
   */
  clearNegativeCarryOvers() {
    let n = 0;
    this.update(s => {
      (s.categories || []).forEach(cat => {
        if (!cat || cat.parentId) return;
        const c = Number(cat.carryOver) || 0;
        if (c < -0.005) {
          cat.carryOver = 0;
          n++;
        }
      });
    });
    return n;
  }

  countNegativeCarryOvers() {
    return (this.state.categories || []).filter(c => !c.parentId && (Number(c.carryOver) || 0) < -0.005).length;
  }

  allocateSurplusToDebt(amount) {
    const target = this.getSnowballTarget();
    if (!target) return null;
    const num = Number(amount) || this.getSurplusForSnowball();
    if (!(num > 0)) return null;
    let resultMeta = null;
    this.update(s => {
      const debt = s.debts.find(d => d.id === target.id);
      if (!debt || debt.paused) return;
      const pay = Math.min(num, Number(debt.balance) || 0);
      if (!(pay > 0)) return;
      debt.balance = Math.max(0, (Number(debt.balance) || 0) - pay);
      s.balances.checking = (Number(s.balances.checking) || 0) - pay;
      let budgetBump = 0;
      // Give those dollars a budget job so To Allocate / surplus don't stay free to re-spend
      if (debt.categoryId) {
        const cat = s.categories.find(c => c.id === debt.categoryId);
        if (cat) {
          budgetBump = pay;
          cat.monthlyBudget = Math.round(((Number(cat.monthlyBudget) || 0) + pay) * 100) / 100;
        }
      }
      const txId = generateId();
      s.transactions.unshift({
        id: txId,
        date: todayISO(),
        amount: pay,
        type: 'debt_payment',
        categoryId: debt.categoryId || null,
        debtId: debt.id,
        description: `Snowball payment to ${debt.name}`,
        clearingStatus: 'cleared',
      });
      resultMeta = {
        name: debt.name,
        pay,
        txId,
        debtId: debt.id,
        categoryId: debt.categoryId || null,
        budgetBump,
      };
      if (debt.balance <= 0) {
        debt.balance = 0;
        debt.archived = true;
        debt.paidOffDate = todayISO();
        s.archivedDebts.push({ ...debt });
        // Next snowball target excludes on-hold debts
        const next = s.debts
          .filter(d => !d.archived && !d.paused && Number(d.balance) > 0)
          .sort((a, b) => Number(a.balance) - Number(b.balance))[0];
        const heldLeft = s.debts.some(d => !d.archived && d.paused && Number(d.balance) > 0);
        s.celebrations.unshift({
          id: generateId(),
          type: 'debt_paid',
          message: `🎉 ${debt.name} is PAID OFF!${
            next
              ? ` Next target: ${next.name}`
              : heldLeft
                ? ' Snowball list clear — you still have debts on hold.'
                : ' You are DEBT FREE!'
          }`,
          date: todayISO(),
          debtName: debt.name,
        });
      }
    });
    if (resultMeta) {
      this._lastUndo = {
        type: 'snowball',
        ...resultMeta,
        at: Date.now(),
      };
      return { name: resultMeta.name, pay: resultMeta.pay, id: resultMeta.debtId };
    }
    return null;
  }

  /**
   * Replace entire app state from a JSON backup (after normalize).
   * Prefer this over Object.assign merge which leaves stale keys.
   */
  replaceStateFromBackup(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid backup');
    }
    const next = normalizeState({
      ...createDefaultState(),
      ...data,
    });
    // Never inherit cloud cursor from an old export (forces a clean re-push)
    delete next._cloudUpdatedAt;
    this.state = next;
    this.writeLocal();
    this.notify();
    return this.state;
  }

  payOffDebt(debtId, manual = true) {
    this.update(s => {
      const debt = s.debts.find(d => d.id === debtId);
      if (!debt) return;
      debt.balance = 0;
      debt.archived = true;
      debt.paused = false;
      debt.paidOffDate = todayISO();
      s.archivedDebts.push({ ...debt });
      const next = s.debts
        .filter(d => !d.archived && !d.paused && Number(d.balance) > 0)
        .sort((a, b) => Number(a.balance) - Number(b.balance))[0];
      const heldLeft = s.debts.some(d => !d.archived && d.paused && Number(d.balance) > 0);
      s.celebrations.unshift({
        id: generateId(),
        type: 'debt_paid',
        message: `🎉 ${debt.name} is PAID OFF! ${
          next
            ? `Next target: ${next.name}`
            : heldLeft
              ? 'Snowball list clear — you still have debts on hold.'
              : 'You are DEBT FREE!'
        }`,
        date: todayISO(),
        debtName: debt.name,
      });
      if (manual) {
        s.transactions.unshift({
          id: generateId(),
          date: todayISO(),
          amount: 0,
          type: 'celebration',
          debtId,
          description: `${debt.name} paid off!`,
        });
      }
    });
  }

  /**
   * @param {{ alreadyInBank?: boolean }} opts
   * alreadyInBank (default true): payment already hit checking via CSV — do not deduct again.
   */
  markBillPaid(billId, amount, date, { alreadyInBank = true } = {}) {
    const bill = this.state.bills.find(b => b.id === billId);
    if (!bill) return;
    const paid = Number(amount) || Number(bill.amount);
    const paidDate = date || todayISO();
    this.update(s => {
      const b = s.bills.find(x => x.id === billId);
      if (!b) return;
      const clearingStatus = alreadyInBank ? 'pending' : 'cleared';
      s.transactions.unshift({
        id: generateId(),
        date: paidDate,
        amount: paid,
        type: 'expense',
        categoryId: b.categoryId,
        billId,
        description: `Bill paid: ${b.name}`,
        clearingStatus,
      });
      // Only reduce checking when money left the bank outside the CSV path (e.g. cash)
      if (!alreadyInBank) {
        s.balances.checking = (Number(s.balances.checking) || 0) - paid;
      }
      // Recurring → next cycle unpaid; one-time stays paid
      completeBillPaymentCycle(b, paidDate, paid);
    });
  }

  /**
   * Find prior envelope expenses that could be a return of this income amount.
   * Returns candidates newest-first; skips expenses already linked to a refund.
   */
  findReturnCandidates(incomeTx, { lookbackDays = 60 } = {}) {
    if (!incomeTx || incomeTx.type !== 'income') return [];
    const amt = Math.round(Math.abs(Number(incomeTx.amount) || 0) * 100);
    if (!amt) return [];

    const incomeDate = String(incomeTx.date || todayISO()).slice(0, 10);
    const start = new Date(incomeDate + 'T12:00:00');
    start.setDate(start.getDate() - lookbackDays);
    const startIso = formatLocalISODate(start);

    const refundedExpenseIds = new Set(
      (this.state.transactions || [])
        .filter(t => t.type === 'income' && t.refundOfTxId)
        .map(t => t.refundOfTxId),
    );

    const candidates = [];
    (this.state.transactions || []).forEach(t => {
      if (t.type !== 'expense' && t.type !== 'debt_payment') return;
      if (t.id === incomeTx.id) return;
      if (refundedExpenseIds.has(t.id)) return;
      const d = String(t.date || '').slice(0, 10);
      if (d > incomeDate || d < startIso) return;

      if (this.isSplitTransaction(t)) {
        (t.splits || []).forEach((sp, idx) => {
          if (!sp.categoryId) return;
          if (Math.round(Math.abs(Number(sp.amount) || 0) * 100) !== amt) return;
          candidates.push({
            expense: t,
            categoryId: sp.categoryId,
            amount: Math.abs(Number(sp.amount)) || 0,
            splitIndex: idx,
          });
        });
        return;
      }
      if (!t.categoryId) return;
      if (Math.round(Math.abs(Number(t.amount) || 0) * 100) !== amt) return;
      candidates.push({
        expense: t,
        categoryId: t.categoryId,
        amount: Math.abs(Number(t.amount)) || 0,
        splitIndex: null,
      });
    });

    return candidates.sort((a, b) =>
      (b.expense.date || '').localeCompare(a.expense.date || '')
      || String(b.expense.id).localeCompare(String(a.expense.id)),
    );
  }

  /**
   * Restore envelope availability after a return (bonus income).
   * Adds to carryOver so remaining goes back up without erasing the original purchase.
   */
  applyReturnToEnvelope(incomeTxId, expenseTxId, categoryId, amount) {
    const num = Math.abs(Number(amount)) || 0;
    if (!incomeTxId || !expenseTxId || !categoryId || !num) return null;

    let result = null;
    this.update(s => {
      const income = s.transactions.find(t => t.id === incomeTxId);
      const expense = s.transactions.find(t => t.id === expenseTxId);
      const cat = s.categories.find(c => c.id === categoryId);
      if (!income || !expense || !cat) return;
      if (income.refundOfTxId) return;

      income.refundOfTxId = expenseTxId;
      expense.refundedByTxId = incomeTxId;
      cat.carryOver = (Number(cat.carryOver) || 0) + num;
      result = { categoryId, categoryName: cat.name, amount: num };
    });
    return result;
  }

  /**
   * After bonus income is recorded, try to match a return to an envelope expense.
   * @returns {{ auto: object } | { candidates: array } | null }
   */
  tryMatchBonusReturn(incomeTxId) {
    const income = this.state.transactions.find(t => t.id === incomeTxId);
    if (!income || income.type !== 'income') return null;

    const bonus = this.getBonusIncomeSource();
    const isBonus = bonus && income.incomeSourceId === bonus.id;
    if (!isBonus) return null;
    if (income.refundOfTxId) return null;

    const candidates = this.findReturnCandidates(income);
    if (!candidates.length) return null;
    if (candidates.length === 1) {
      const c = candidates[0];
      const applied = this.applyReturnToEnvelope(income.id, c.expense.id, c.categoryId, c.amount);
      return applied ? { auto: applied, expense: c.expense } : null;
    }

    // Prefer stronger description match (e.g. Amazon return ↔ Amazon purchase)
    const scored = candidates.map(c => ({
      ...c,
      sim: descriptionSimilarity(income.description, c.expense.description),
    })).sort((a, b) => b.sim - a.sim || (b.expense.date || '').localeCompare(a.expense.date || ''));

    if (scored[0].sim >= 0.4 && scored[0].sim - (scored[1]?.sim || 0) >= 0.12) {
      const c = scored[0];
      const applied = this.applyReturnToEnvelope(income.id, c.expense.id, c.categoryId, c.amount);
      return applied ? { auto: applied, expense: c.expense } : null;
    }

    return { candidates: scored };
  }

  /** Count old "Funded envelope: …" transfer rows that wrongly reduced checking. */
  countFundedEnvelopeTransfers() {
    return (this.state.transactions || []).filter(isFundedEnvelopeTransfer).length;
  }

  /**
   * Delete fake fund-envelope transfers and reverse their checking impact.
   * (Old bug: allocate treated as cash withdrawal.)
   */
  cleanupFundedEnvelopeTransfers() {
    let n = 0;
    this.update(s => {
      const keep = [];
      s.transactions.forEach(tx => {
        if (isFundedEnvelopeTransfer(tx)) {
          const status = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
          this.applyCheckingDelta(s, -this.getCheckingDelta(tx.type, tx.amount, status));
          n++;
        } else {
          keep.push(tx);
        }
      });
      s.transactions = keep;
    });
    return n;
  }

  importTransactions(rows, { includePending = true } = {}) {
    const stats = {
      count: 0, income: 0, expense: 0, categorized: 0, ruleApplied: 0,
      billMatches: 0, autoPayBills: 0, incomeLinked: 0, skipped: 0, duplicates: 0,
      matchedPending: 0, parsed: rows.length,
      expenseAmount: 0, incomeAmount: 0,
      incomeIdsForReturnMatch: [],
    };
    const autoPaidBillIds = new Set();
    this.update(s => {
      rows.forEach(row => {
        const tx = normalizeImportRow(row, { includePending });
        if (!tx) {
          stats.skipped++;
          return;
        }

        const candidate = {
          date: tx.date,
          amount: tx.amount,
          type: tx.type,
          description: tx.description,
        };

        // Match a pending manual log → clear in place (no second row)
        const pendingMatch = findBestPendingMatch(s.transactions, candidate);
        if (pendingMatch) {
          pendingMatch.clearingStatus = 'cleared';
          if (tx.date) pendingMatch.date = tx.date;
          if (tx.description) {
            // Keep user's category/splits; prefer bank description for the log
            pendingMatch.description = tx.description;
          }
          if (tx.bankCategory && !pendingMatch.categoryId && !this.isSplitTransaction(pendingMatch)) {
            pendingMatch.importCategory = tx.bankCategory;
            const resolved = resolveCategoryId(
              tx.bankCategory,
              tx.description,
              s.categories,
              tx.type,
            );
            if (resolved) pendingMatch.categoryId = resolved;
          }
          this.applyCheckingDelta(
            s,
            this.getCheckingDelta(pendingMatch.type, pendingMatch.amount, 'cleared'),
          );
          if (pendingMatch.type === 'income') {
            this.applyImportedIncome(s, pendingMatch);
            stats.incomeLinked++;
            stats.income++;
            stats.incomeAmount += Math.abs(Number(pendingMatch.amount) || 0);
            stats.incomeIdsForReturnMatch.push(pendingMatch.id);
          } else if (pendingMatch.type === 'expense') {
            stats.expense++;
            stats.expenseAmount += Math.abs(Number(pendingMatch.amount) || 0);
            if (pendingMatch.categoryId || this.isSplitTransaction(pendingMatch)) stats.categorized++;
            if (!this.applyAutoPayBillIfMatched(pendingMatch, s, stats, autoPaidBillIds)) {
              if (findBillForTransaction(pendingMatch, s.bills)) stats.billMatches++;
            }
          }
          stats.matchedPending++;
          stats.count++;
          return;
        }

        // Skip only strong duplicates (exact row or same-day same amount).
        // Cross-day same merchant/amount (e.g. two kids, same game) still imports.
        const nonPending = s.transactions.filter(t => !isTransactionPending(t));
        if (isImportDuplicateTransaction(nonPending, candidate)) {
          stats.duplicates++;
          return;
        }

        let categoryId = resolveCategoryId(
          tx.bankCategory,
          tx.description,
          s.categories,
          tx.type,
        );

        const newTx = {
          id: generateId(),
          date: tx.date,
          amount: tx.amount,
          type: tx.type,
          categoryId,
          description: tx.description,
          importCategory: tx.bankCategory || null,
          clearingStatus: 'cleared',
        };

        if (tx.type === 'expense' && !categoryId) {
          if (this.applyRulesToTransaction(newTx, s)) {
            stats.ruleApplied++;
            if (newTx.categoryId || newTx.splits) stats.categorized++;
          }
        }

        if (tx.type === 'income' && this.applyImportedIncome(s, newTx)) {
          stats.incomeLinked++;
        }

        s.transactions.push(newTx);

        if (tx.type === 'expense') {
          s.balances.checking -= tx.amount;
          stats.expense++;
          stats.expenseAmount += Math.abs(Number(tx.amount) || 0);
          if (newTx.categoryId || this.isSplitTransaction(newTx)) stats.categorized++;
          if (!this.applyAutoPayBillIfMatched(newTx, s, stats, autoPaidBillIds)) {
            if (findBillForTransaction(newTx, s.bills)) stats.billMatches++;
          }
        } else {
          s.balances.checking += tx.amount;
          stats.income++;
          stats.incomeAmount += Math.abs(Number(tx.amount) || 0);
          stats.incomeIdsForReturnMatch.push(newTx.id);
        }
        stats.count++;
      });
    });
    return stats;
  }

  getUpcomingBills(days = 14) {
    const month = getCurrentMonth();
    return this.state.bills
      .filter(b => b.status !== 'paid')
      // Dashboard glance: this month + overdue, not far-future next cycles
      .filter(b => {
        const due = String(b.dueDate || '').slice(0, 10);
        if (!due) return true;
        const dueM = due.slice(0, 7);
        return dueM <= month;
      })
      .map(b => ({ ...b, daysLeft: daysUntil(b.dueDate) }))
      .filter(b => Number.isFinite(b.daysLeft) && b.daysLeft <= days)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }

  getLatestCelebration() {
    return this.state.celebrations[0] || null;
  }

  completeSetup(data) {
    this.update(s => {
      Object.assign(s, data);
      s.setupComplete = true;
      s.babyStep = s.babyStep || 1;
      s.lastMonthProcessed = getCurrentMonth();
      const snap = {};
      s.categories.forEach(cat => { snap[cat.id] = Number(cat.monthlyBudget) || 0; });
      s.monthBudgetSnapshots[getCurrentMonth()] = snap;
    });
  }
}

function daysUntil(dateStr) {
  const today = new Date(todayISO() + 'T12:00:00');
  const target = new Date(dateStr + 'T12:00:00');
  return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}

export const store = new Store();