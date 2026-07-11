import {
  createDefaultState,
  DEFAULT_CATEGORIES,
  SINKING_FUND_DEFAULTS,
  BUILT_IN_CATEGORY_NAMES,
} from './defaults.js';
import {
  getCurrentMonth, isInMonth, todayISO, generateId,
  getPreviousMonth, getRecentMonths,
} from './utils.js';
import {
  normalizeImportRow, resolveCategoryId,
  isLikelyDuplicateTransaction,
  clusterDuplicateTransactions,
  findBestPendingMatch,
  isTransactionPending,
} from './csv-import.js';
import { findMatchingRule, applyRuleToTransaction } from './category-rules.js';
import { findBillForTransaction } from './bill-matcher.js';
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

function ensureDefaultCategories(state) {
  state.categories = (state.categories || []).filter(
    c => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim()
  ).map(c => ({
    parentId: null,
    isSinkingFund: false,
    monthlyBudget: 0,
    carryOver: 0,
    ...c,
    id: c.id || generateId(),
    name: c.name.trim(),
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
  if (!Array.isArray(state.debts)) state.debts = [];
  if (!Array.isArray(state.transactions)) state.transactions = [];
  if (!Array.isArray(state.categories)) state.categories = [...defaults.categories];
  if (!Array.isArray(state.incomeSources)) state.incomeSources = defaults.incomeSources;
  if (!Array.isArray(state.archivedDebts)) state.archivedDebts = [];
  if (!Array.isArray(state.celebrations)) state.celebrations = [];
  if (typeof state.notes !== 'string') state.notes = '';
  if (state.notesUpdatedAt !== null && typeof state.notesUpdatedAt !== 'string') state.notesUpdatedAt = null;
  if (!Array.isArray(state.removedDefaultCategories)) state.removedDefaultCategories = [];
  if (!Array.isArray(state.categoryRules)) state.categoryRules = [];
  if (!state.monthBudgetSnapshots || typeof state.monthBudgetSnapshots !== 'object') {
    state.monthBudgetSnapshots = {};
  }
  if (!Array.isArray(state.monthCloseLog)) state.monthCloseLog = [];
  if (!state.reconciliation || typeof state.reconciliation !== 'object') {
    state.reconciliation = { bankBalance: null, asOfDate: null };
  }
  if (!state.balances || typeof state.balances !== 'object') state.balances = defaults.balances;
  if (!Array.isArray(state.balances.savings)) state.balances.savings = [];
  if (!state.settings || typeof state.settings !== 'object') state.settings = { ...defaults.settings };
  if (!state.settings.palette) state.settings.palette = 'forest';
  state.incomeSources = ensureBonusIncomeSource(state.incomeSources);
  migrateLegacyIncomeSourceNames(state.incomeSources);
  (state.incomeSources || []).forEach(src => {
    src.paySchedule = normalizePaySchedule(src.paySchedule);
    if (!Array.isArray(src.matchTerms)) src.matchTerms = [];
    applyDefaultMatchTerms(src);
  });
  ensureDefaultCategories(state);
  (state.transactions || []).forEach(tx => {
    // Existing data: treat as bank-cleared so balances don't jump
    if (tx.clearingStatus !== 'pending' && tx.clearingStatus !== 'cleared') {
      tx.clearingStatus = 'cleared';
    }
    if (tx.type !== 'income' || tx.incomeSourceId) return;
    const source = resolveIncomeSource(tx.description, state.incomeSources);
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

  // --- Notes ---
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

  // --- Month rollover ---
  processMonthRollover() {
    const current = getCurrentMonth();
    if (this.state.lastMonthProcessed === current) return;

    const prev = this.state.lastMonthProcessed;
    if (prev && prev !== current) {
      this.saveMonthBudgetSnapshot(prev, false);
      this.state.categories.forEach(cat => {
        const remaining = this.getCategoryRemaining(cat.id, prev);
        cat.carryOver = (cat.carryOver || 0) + remaining;
      });
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
      .filter(t => t.type === 'income' && t.incomeSourceId === bonus.id)
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
    return this.getCategoryTransactions(categoryId, month)
      .reduce((sum, t) => sum + (Number(t.envelopeAmount) || 0), 0);
  }

  /**
   * Transactions that spent from an envelope this month.
   * Each item includes envelopeAmount (portion attributed to this category).
   */
  getCategoryTransactions(categoryId, month = getCurrentMonth()) {
    if (!categoryId) return [];
    return this.getTransactionsForMonth(month)
      .filter(t => t.type === 'expense' || t.type === 'debt_payment')
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
    return this.getActiveDebts().reduce((s, d) => {
      if (this.isDebtMinInBudget(d)) return s;
      return s + (Number(d.minPayment) || 0);
    }, 0);
  }

  getRemainingMinDebtPaymentsOutsideBudget(month = getCurrentMonth()) {
    return this.getActiveDebts().reduce((s, d) => {
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

  getCategoryRemaining(categoryId, month = getCurrentMonth()) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return 0;
    const budgeted = Number(cat.monthlyBudget) || 0;
    const carry = Number(cat.carryOver) || 0;
    const spent = this.getCategorySpent(categoryId, month);
    return budgeted + carry - spent;
  }

  getTotalBudgeted() {
    return this.state.categories.reduce((s, c) => s + (Number(c.monthlyBudget) || 0), 0);
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
    const budgeted = this.getTotalBudgeted();
    return income - budgeted;
  }

  getToAllocate() {
    return this.getUnallocatedFunds();
  }

  getCashFlowSurplus(month = getCurrentMonth()) {
    const income = this.getEffectiveMonthlyIncome(month);
    const totalSpent = this.getTotalSpent(month);
    const debtPaid = this.getTotalDebtPaid(month);
    const remainingMins = this.getRemainingMinDebtPaymentsOutsideBudget(month);
    return income - totalSpent - debtPaid - remainingMins;
  }

  /** Zero-based leftover: monthly income not assigned to envelopes (matches Budget "To Allocate") */
  getPlannedSnowballSurplus() {
    return Math.max(0, this.getToAllocate());
  }

  getSurplusForSnowball(month = getCurrentMonth()) {
    const toAllocate = this.getPlannedSnowballSurplus();
    const cashAvailable = Math.max(0, this.getCashFlowSurplus(month));
    // At minimum, use unallocated envelope funds; also use extra if cash flow is higher
    return Math.max(toAllocate, cashAvailable);
  }

  getSurplusBasis(month = getCurrentMonth()) {
    const toAllocate = this.getPlannedSnowballSurplus();
    const cashAvailable = Math.max(0, this.getCashFlowSurplus(month));
    const surplus = this.getSurplusForSnowball(month);
    if (surplus <= 0) return 'none';
    if (toAllocate >= cashAvailable && toAllocate > 0) return 'unallocated';
    if (cashAvailable > toAllocate) return 'cashflow';
    return 'unallocated';
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

  getReviewInbox(month = getCurrentMonth()) {
    const uncategorized = this.getUncategorizedTransactions(month);
    const billMatches = this.getPendingBillMatches(month);
    const duplicates = this.getDuplicateTransactions(month);
    return {
      uncategorized,
      billMatches,
      duplicates,
      totalCount: uncategorized.length + billMatches.length + duplicates.length,
    };
  }

  getEnvelopeHealth(categoryId, month = getCurrentMonth()) {
    const cat = this.state.categories.find(c => c.id === categoryId);
    if (!cat) return 'none';
    const budgeted = Number(cat.monthlyBudget) || 0;
    const carry = Number(cat.carryOver) || 0;
    const pool = budgeted + carry;
    if (pool <= 0) return 'none';
    const spent = this.getCategorySpent(categoryId, month);
    const remaining = pool - spent;
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
      bill.status = 'paid';
      bill.paidDate = tx.date || todayISO();
      bill.paidAmount = Math.abs(Number(tx.amount)) || Number(bill.amount);
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
    const snap = this.state.monthBudgetSnapshots[month];
    if (snap && snap[categoryId] != null) return snap[categoryId];
    const cat = this.state.categories.find(c => c.id === categoryId);
    return Number(cat?.monthlyBudget) || 0;
  }

  incomeMatchesSource(tx, source) {
    return transactionMatchesIncomeSource(tx, source);
  }

  applyImportedIncome(s, tx) {
    const source = resolveIncomeSource(tx.description, s.incomeSources);
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
    return {
      month,
      alreadyClosed,
      uncategorized: inbox.uncategorized.length,
      billMatches: inbox.billMatches.length,
      toAllocate: this.getToAllocate(),
      surplus: this.getSurplusForSnowball(month),
      steps: [
        { id: 'review', label: 'Review uncategorized transactions', done: inbox.uncategorized.length === 0, count: inbox.uncategorized.length },
        { id: 'bills', label: 'Link bills to bank transactions', done: inbox.billMatches.length === 0, count: inbox.billMatches.length },
        { id: 'allocate', label: 'Zero-based budget (To Allocate = $0)', done: Math.abs(this.getToAllocate()) < 0.01, count: this.getToAllocate() },
        { id: 'surplus', label: 'Allocate surplus to debt snowball', done: this.getSurplusForSnowball(month) <= 0 || !this.getActiveDebts().length, count: this.getSurplusForSnowball(month) },
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
      (type, amount) => this.getCheckingDelta(type, amount),
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
  getActiveDebts() {
    return [...this.state.debts]
      .filter(d => !d.archived && (Number(d.balance) || 0) > 0)
      .sort((a, b) => (Number(a.balance) || 0) - (Number(b.balance) || 0));
  }

  getSnowballTarget() {
    const debts = this.getActiveDebts();
    return debts[0] || null;
  }

  getTotalDebt() {
    return this.getActiveDebts().reduce((s, d) => s + (Number(d.balance) || 0), 0);
  }

  getSnowballPayment(debt) {
    const debts = this.getActiveDebts();
    const idx = debts.findIndex(d => d.id === debt.id);
    let extra = this.getSurplusForSnowball();
    let payment = (Number(debt.minPayment) || 0) + extra;
    for (let i = 0; i < idx; i++) {
      payment += Number(debts[i].minPayment) || 0;
    }
    if (idx === 0) return (Number(debt.minPayment) || 0) + this.getSurplusForSnowball();
    return Number(debt.minPayment) || 0;
  }

  estimateMonthsToDebtFree() {
    const debts = this.getActiveDebts();
    if (!debts.length) return 0;
    let months = 0;
    let surplus = this.getSurplusForSnowball();
    const sim = debts.map(d => ({ balance: Number(d.balance) || 0, min: Number(d.minPayment) || 0 }));
    let safety = 600;
    while (sim.some(d => d.balance > 0) && safety-- > 0) {
      months++;
      let extra = surplus;
      for (const d of sim) {
        if (d.balance <= 0) continue;
        const pay = d.min + extra;
        d.balance = Math.max(0, d.balance - pay);
        if (d.balance === 0) extra = pay - (d.balance + pay - d.balance);
        else { extra = 0; break; }
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
    clearingStatus, postToChecking = false,
  }) {
    const num = Math.abs(Number(amount));
    if (!num) return;
    const normalizedSplits = this.normalizeSplits(splits);
    const useSplits = normalizedSplits.length > 0 && type === 'expense';
    const wantsPending = type === 'expense' || type === 'income';
    const status = clearingStatus
      || (postToChecking ? 'cleared' : null)
      || (wantsPending ? 'pending' : 'cleared');

    this.update(s => {
      const newTx = {
        id: generateId(),
        date: date || todayISO(),
        amount: num,
        type,
        categoryId: useSplits ? null : (categoryId || null),
        description: description || '',
        billId: billId || null,
        debtId: debtId || null,
        clearingStatus: status,
        ...(useSplits ? { splits: normalizedSplits } : {}),
      };
      if (type === 'income' && status === 'cleared') this.applyImportedIncome(s, newTx);
      s.transactions.unshift(newTx);
      this.applyCheckingDelta(s, this.getCheckingDelta(type, num, status));
      if (type === 'debt_payment' && debtId) {
        this.adjustDebtForPayment(s, debtId, num);
      }
    });
  }

  updateTransaction(id, updates) {
    this.update(s => {
      const tx = s.transactions.find(x => x.id === id);
      if (!tx) return;

      const oldType = tx.type;
      const oldAmount = Math.abs(Number(tx.amount)) || 0;
      const oldStatus = tx.clearingStatus === 'pending' ? 'pending' : 'cleared';
      const newType = updates.type ?? tx.type;
      const newAmount = updates.amount !== undefined ? Math.abs(Number(updates.amount)) : oldAmount;
      const newStatus = updates.clearingStatus !== undefined
        ? (updates.clearingStatus === 'pending' ? 'pending' : 'cleared')
        : oldStatus;

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

      // Income linkage when first cleared
      if (newType === 'income' && newStatus === 'cleared' && oldStatus === 'pending') {
        this.applyImportedIncome(s, tx);
      }
    });
  }

  fundEnvelope(categoryId, amount) {
    const num = Number(amount);
    if (num <= 0) return;
    this.update(s => {
      const cat = s.categories.find(c => c.id === categoryId);
      if (cat) cat.carryOver = (Number(cat.carryOver) || 0) + num;
      s.balances.checking = (Number(s.balances.checking) || 0) - num;
      s.transactions.unshift({
        id: generateId(),
        date: todayISO(),
        amount: num,
        type: 'transfer',
        categoryId,
        description: `Funded envelope: ${cat?.name}`,
        clearingStatus: 'cleared',
      });
    });
  }

  allocateSurplusToDebt(amount) {
    const target = this.getSnowballTarget();
    if (!target) return null;
    const num = Number(amount) || this.getSurplusForSnowball();
    this.update(s => {
      const debt = s.debts.find(d => d.id === target.id);
      if (!debt) return;
      const pay = Math.min(num, Number(debt.balance) || 0);
      debt.balance = Math.max(0, (Number(debt.balance) || 0) - pay);
      s.balances.checking = (Number(s.balances.checking) || 0) - pay;
      s.transactions.unshift({
        id: generateId(),
        date: todayISO(),
        amount: pay,
        type: 'debt_payment',
        categoryId: debt.categoryId || null,
        debtId: debt.id,
        description: `Snowball payment to ${debt.name}`,
        clearingStatus: 'cleared',
      });
      if (debt.balance <= 0) {
        debt.balance = 0;
        debt.archived = true;
        debt.paidOffDate = todayISO();
        s.archivedDebts.push({ ...debt });
        const next = s.debts
          .filter(d => !d.archived && Number(d.balance) > 0)
          .sort((a, b) => Number(a.balance) - Number(b.balance))[0];
        s.celebrations.unshift({
          id: generateId(),
          type: 'debt_paid',
          message: `🎉 ${debt.name} is PAID OFF!${next ? ` Next target: ${next.name}` : ' You are DEBT FREE!'}`,
          date: todayISO(),
          debtName: debt.name,
        });
      }
    });
    return target;
  }

  payOffDebt(debtId, manual = true) {
    this.update(s => {
      const debt = s.debts.find(d => d.id === debtId);
      if (!debt) return;
      debt.balance = 0;
      debt.archived = true;
      debt.paidOffDate = todayISO();
      s.archivedDebts.push({ ...debt });
      s.celebrations.unshift({
        id: generateId(),
        type: 'debt_paid',
        message: `🎉 ${debt.name} is PAID OFF! ${this.getSnowballTarget() ? `Next target: ${this.getSnowballTarget()?.name}` : 'You are DEBT FREE!'}`,
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

  markBillPaid(billId, amount, date) {
    const bill = this.state.bills.find(b => b.id === billId);
    if (!bill) return;
    const paid = Number(amount) || Number(bill.amount);
    this.update(s => {
      const b = s.bills.find(x => x.id === billId);
      b.status = 'paid';
      b.paidDate = date || todayISO();
      b.paidAmount = paid;
      s.transactions.unshift({
        id: generateId(),
        date: date || todayISO(),
        amount: paid,
        type: 'expense',
        categoryId: b.categoryId,
        billId,
        description: `Bill paid: ${b.name}`,
        clearingStatus: 'cleared',
      });
      s.balances.checking = (Number(s.balances.checking) || 0) - paid;
    });
  }

  importTransactions(rows, { includePending = true } = {}) {
    const stats = {
      count: 0, income: 0, expense: 0, categorized: 0, ruleApplied: 0,
      billMatches: 0, incomeLinked: 0, skipped: 0, duplicates: 0,
      matchedPending: 0, parsed: rows.length,
    };
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
          } else if (pendingMatch.type === 'expense') {
            stats.expense++;
            if (pendingMatch.categoryId || this.isSplitTransaction(pendingMatch)) stats.categorized++;
            if (findBillForTransaction(pendingMatch, s.bills)) stats.billMatches++;
          }
          stats.matchedPending++;
          stats.count++;
          return;
        }

        // Skip if already present among cleared (or any non-pending) txs
        const nonPending = s.transactions.filter(t => !isTransactionPending(t));
        if (isLikelyDuplicateTransaction(nonPending, candidate)) {
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
          if (newTx.categoryId || this.isSplitTransaction(newTx)) stats.categorized++;
          if (findBillForTransaction(newTx, s.bills)) stats.billMatches++;
        } else {
          s.balances.checking += tx.amount;
          stats.income++;
        }
        stats.count++;
      });
    });
    return stats;
  }

  getUpcomingBills(days = 14) {
    return this.state.bills
      .filter(b => b.status !== 'paid')
      .map(b => ({ ...b, daysLeft: daysUntil(b.dueDate) }))
      .filter(b => b.daysLeft <= days)
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