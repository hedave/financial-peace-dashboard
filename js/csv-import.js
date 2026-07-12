import { todayISO } from './utils.js';

/** Parse currency strings: $1,234.56, (50.00), -50.00 */
export function parseMoneyValue(str) {
  if (str == null || str === '') return 0;
  let s = String(str).trim();
  if (!s || s === '-' || s === '—') return 0;

  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith('+')) s = s.slice(1);

  const n = parseFloat(s);
  if (isNaN(n) || n === 0) return 0;
  return negative ? -n : n;
}

/** Normalize dates from common bank export formats to YYYY-MM-DD */
export function parseImportDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^"|"$/g, '');

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }

  const mdyShort = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mdyShort) {
    const yy = Number(mdyShort[3]);
    const year = yy > 50 ? 1900 + yy : 2000 + yy;
    return `${year}-${mdyShort[1].padStart(2, '0')}-${mdyShort[2].padStart(2, '0')}`;
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function fieldMap(row) {
  const map = new Map();
  Object.entries(row).forEach(([key, value]) => {
    map.set(key.toLowerCase().trim(), value);
  });
  return map;
}

function getField(map, ...aliases) {
  for (const alias of aliases) {
    const exact = map.get(alias.toLowerCase());
    if (exact !== undefined && exact !== null && String(exact).trim() !== '') {
      return String(exact).trim();
    }
  }
  for (const alias of aliases) {
    for (const [key, value] of map.entries()) {
      if (key.includes(alias.toLowerCase()) && value !== undefined && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
  }
  return '';
}

/** USAA / Chase / common bank labels → envelope category names */
const BANK_TO_ENVELOPE = [
  [/^(income|deposit|payroll|salary|wages|credit|refund|interest)/, null],
  [/^(transfer|credit card payment)/, null],
  [/mortgage|home loan|housing|rent|hoa/, 'Mortgage'],
  [/groc/, 'Groceries'],
  [/restaurant|dining|food and drink|food & drink|fast food|coffee|cafe/, 'Eating Out / Fast Food'],
  [/gas|fuel|automotive|auto|transportation|parking|toll/, 'Gas & Transportation'],
  [/utilit|electric|water bill|sewer|trash|internet|cable|phone/, 'Utilities'],
  [/insurance/, 'Insurance'],
  [/health|medical|pharmacy|dental|doctor|hospital/, 'Medical / Health'],
  [/entertain|recreation|movie|music|streaming/, 'Entertainment'],
  [/subscription|software|digital/, 'Subscriptions'],
  [/cloth|apparel/, 'Clothing'],
  [/home improv|hardware|furniture|garden/, 'Home Improvement'],
  [/education|school|tuition|book/, 'Education'],
  [/gift|donat|tithe|charit/, 'Giving / Tithe'],
  [/personal care|salon|barber|spa/, 'Personal Care'],
  [/kid|child|family/, 'Kids Activities'],
  [/travel|hotel|airline|vacation/, 'Vacation'],
  [/christmas|holiday/, 'Christmas'],
  [/car maint|auto repair|oil change/, 'Car Maintenance'],
  [/shop|retail|merchandise|amazon|target|walmart(?!.*groc)/, 'Household / Misc'],
  [/fee|atm|service charge|bank fee/, 'Household / Misc'],
  [/household|misc|general|other/, 'Household / Misc'],
];

const DESC_TO_ENVELOPE = [
  [/sam'?s club|samsclub|sams club|costco|walmart|kroger|aldi|publix|safeway|food lion|heb |trader joe|whole foods|bj'?s wholesale|bjs |sprouts|winndixie|winn dixie|grocery/i, 'Groceries'],
  [/mcdonald|burger king|wendy|taco bell|chipotle|starbucks|dunkin|pizza hut|domino|restaurant|doordash|grubhub|uber eats|panera|subway|wendy's/i, 'Eating Out / Fast Food'],
  [/shell|chevron|exxon|mobil|bp |speedway|circle k|gas station|love's|pilot |fuel/i, 'Gas & Transportation'],
  [/netflix|spotify|hulu|disney\+|apple\.com\/bill|google \*|amazon prime/i, 'Subscriptions'],
  [/cvs|walgreens|pharmacy|medical|hospital|urgent care|doctor/i, 'Medical / Health'],
  [/home depot|lowe'?s|menards|ace hardware/i, 'Home Improvement'],
];

function normalizeLabel(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9\s&/]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findEnvelopeByName(userCategories, name) {
  if (!name) return null;
  const exact = userCategories.find(c => c.name === name);
  if (exact) return exact.id;
  const norm = normalizeLabel(name);
  const fuzzy = userCategories.find(c => normalizeLabel(c.name) === norm);
  return fuzzy?.id || null;
}

function mapBankLabelToEnvelope(bankCategory, userCategories) {
  const norm = normalizeLabel(bankCategory);
  if (!norm) return null;

  for (const [pattern, envelopeName] of BANK_TO_ENVELOPE) {
    if (pattern.test(norm)) {
      if (envelopeName === null) return null;
      return findEnvelopeByName(userCategories, envelopeName);
    }
  }

  // Direct / partial match against user's envelope names
  for (const cat of userCategories) {
    const catNorm = normalizeLabel(cat.name);
    if (catNorm === norm || norm.includes(catNorm) || catNorm.includes(norm)) {
      return cat.id;
    }
  }

  return null;
}

function mapDescriptionToEnvelope(description, userCategories) {
  for (const [pattern, envelopeName] of DESC_TO_ENVELOPE) {
    if (pattern.test(description)) {
      return findEnvelopeByName(userCategories, envelopeName);
    }
  }
  return null;
}

/**
 * Match a bank CSV category (and optionally description) to a user envelope.
 * Income/transfer rows return null.
 */
export function resolveCategoryId(bankCategory, description, userCategories, txType) {
  if (txType !== 'expense') return null;

  // Merchant names beat bank labels — USAA often tags Sam's Club, Costco, etc. as "Food & Dining"
  const fromDesc = mapDescriptionToEnvelope(description, userCategories);
  if (fromDesc) return fromDesc;

  const fromBank = mapBankLabelToEnvelope(bankCategory, userCategories);
  if (fromBank) return fromBank;

  return null;
}

/**
 * Convert a raw CSV row into a normalized transaction.
 * Supports USAA (signed Amount), separate Debits/Credits columns, Chase, etc.
 * Returns null if the row should be skipped.
 */
export function normalizeImportRow(row, { includePending = true } = {}) {
  const map = fieldMap(row);

  const dateRaw = getField(map, 'date', 'posted date', 'post date', 'posting date', 'transaction date', 'trans date');
  const date = parseImportDate(dateRaw) || todayISO();

  const description = getField(
    map,
    'description',
    'transaction description',
    'memo',
    'payee',
    'name',
    'details',
    'merchant',
  ) || getField(map, 'original description');

  const bankCategory = getField(
    map,
    'category',
    'category name',
    'transaction category',
    'spending category',
    'usaa category',
  );

  const status = getField(map, 'status').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return null;
  if (!includePending && (status === 'pending' || status.startsWith('pending '))) return null;

  // Statement exports with separate debit & credit columns
  const debitRaw = getField(map, 'debits', 'debit', 'withdrawal', 'withdrawals', 'money out');
  const creditRaw = getField(map, 'credits', 'credit', 'deposit', 'deposits', 'money in');
  const debit = Math.abs(parseMoneyValue(debitRaw));
  const credit = Math.abs(parseMoneyValue(creditRaw));

  const base = { description, bankCategory };

  if (debit > 0 || credit > 0) {
    if (credit > 0 && debit === 0) {
      return { date, amount: credit, type: 'income', ...base };
    }
    if (debit > 0 && credit === 0) {
      return { date, amount: debit, type: 'expense', ...base };
    }
    if (debit > 0 && credit > 0) {
      return { date, amount: debit, type: 'expense', ...base };
    }
  }

  // Signed amount column: positive = income, negative = expense (USAA, Chase, etc.)
  const amountRaw = getField(map, 'amount', 'transaction amount', 'amt');
  if (amountRaw) {
    const signed = parseMoneyValue(amountRaw);
    if (signed === 0) return null;

    return {
      date,
      amount: Math.abs(signed),
      type: signed < 0 ? 'expense' : 'income',
      ...base,
    };
  }

  return null;
}

export const DUPLICATE_DATE_WINDOW_DAYS = 7;

const DESC_NOISE = /\b(pos|debit|credit|purchase|withdrawal|chk|card|pending|visa|mastercard|amex|usaa|ach|web|id|ref|transaction|payment|auth)\b/gi;
const STORE_NUMBER = /#?\s*\d{3,}\b/g;

function daysBetween(dateA, dateB) {
  const a = new Date(String(dateA).slice(0, 10) + 'T12:00:00');
  const b = new Date(String(dateB).slice(0, 10) + 'T12:00:00');
  return Math.abs(Math.round((a - b) / (1000 * 60 * 60 * 24)));
}

function descriptionTokens(str) {
  return new Set(
    normalizeMerchantDescription(str).split(' ').filter(t => t.length > 1),
  );
}

/** Strip bank noise so "SAM'S CLUB #4823" and "POS DEBIT SAMS CLUB" match */
export function normalizeMerchantDescription(description) {
  let s = String(description || '').toLowerCase();
  s = s.replace(/[''`]/g, '');
  s = s.replace(STORE_NUMBER, ' ');
  s = s.replace(DESC_NOISE, ' ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function descriptionSimilarity(a, b) {
  const na = normalizeMerchantDescription(a);
  const nb = normalizeMerchantDescription(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 6 && longer.includes(shorter)) return 0.9;

  const ta = descriptionTokens(na);
  const tb = descriptionTokens(nb);
  if (!ta.size || !tb.size) return 0;

  let overlap = 0;
  ta.forEach(token => { if (tb.has(token)) overlap++; });
  const union = ta.size + tb.size - overlap;
  return overlap / union;
}

export function areDescriptionsSimilar(a, b, threshold = 0.55) {
  return descriptionSimilarity(a, b) >= threshold;
}

/** Unique key for exact duplicate detection across imports */
export function transactionFingerprint({ date, type, amount, description }) {
  const desc = String(description || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const amt = (Math.round(Math.abs(Number(amount) || 0) * 100) / 100).toFixed(2);
  return `${date}|${type}|${amt}|${desc}`;
}

export function isDuplicateTransaction(existing, tx) {
  const fp = transactionFingerprint(tx);
  return existing.some(t => transactionFingerprint(t) === fp);
}

/** Same calendar day + same dollar amount (used to flag likely duplicates in the log) */
export function amountDateKey({ date, amount, type = null }) {
  const d = String(date || '').slice(0, 10);
  const amt = Math.round(Math.abs(Number(amount) || 0) * 100);
  if (type) return `${d}|${amt}|${type}`;
  return `${d}|${amt}`;
}

export function isAmountDateDuplicate(existing, tx) {
  const key = amountDateKey({ ...tx, type: tx.type });
  return existing.some(t => amountDateKey(t) === key);
}

export function areLikelyDuplicatePair(a, b, {
  dateWindowDays = DUPLICATE_DATE_WINDOW_DAYS,
  crossDaySimilarity = 0.55,
} = {}) {
  if (!a || !b || a.id === b.id) return false;
  if (a.type !== b.type) return false;

  const amtA = Math.round(Math.abs(Number(a.amount) || 0) * 100);
  const amtB = Math.round(Math.abs(Number(b.amount) || 0) * 100);
  if (!amtA || amtA !== amtB) return false;

  const dayDiff = daysBetween(a.date, b.date);
  // Same calendar day + same amount: likely re-import or double-post
  if (dayDiff === 0) return true;
  if (dayDiff > dateWindowDays) return false;

  // Cross-day same amount + similar merchant: flag for review only
  // (two kids buying the same $12.83 game a few days apart is legitimate)
  return areDescriptionsSimilar(a.description, b.description, crossDaySimilarity);
}

/** Soft match for Review UI / banners — includes cross-day similar merchants. */
export function isLikelyDuplicateTransaction(existing, tx, options = {}) {
  if (isDuplicateTransaction(existing, tx) || isAmountDateDuplicate(existing, tx)) return true;
  const candidate = { ...tx, type: tx.type };
  return existing.some(t => areLikelyDuplicatePair(t, candidate, options));
}

/**
 * Hard match for CSV import skip only.
 * Same purchase on a different day (common: family, subscriptions, rebuys)
 * must NOT be blocked — only exact rows or same-day amount+type.
 */
export function isImportDuplicateTransaction(existing, tx) {
  if (isDuplicateTransaction(existing, tx)) return true;

  const amt = Math.round(Math.abs(Number(tx.amount) || 0) * 100);
  if (!amt) return false;
  const day = String(tx.date || '').slice(0, 10);
  const type = tx.type;

  return (existing || []).some(t => {
    if (t.type !== type) return false;
    if (Math.round(Math.abs(Number(t.amount) || 0) * 100) !== amt) return false;
    if (String(t.date || '').slice(0, 10) !== day) return false;
    // Same day + same amount: treat as re-import of the same bank row
    // unless descriptions clearly differ (two different purchases same day)
    const na = normalizeMerchantDescription(t.description);
    const nb = normalizeMerchantDescription(tx.description);
    if (!na || !nb) return true;
    if (na === nb) return true;
    // Distinct merchants same day same $ — allow both
    if (descriptionSimilarity(t.description, tx.description) < 0.35) return false;
    return true;
  });
}

export function isTransactionPending(tx) {
  return tx && tx.clearingStatus === 'pending';
}

/**
 * Find the best pending manual transaction that matches an import row.
 * Prefers higher description similarity, then closer dates.
 */
export function findBestPendingMatch(transactions, candidate, options = {}) {
  const {
    dateWindowDays = DUPLICATE_DATE_WINDOW_DAYS,
    minSimilarity = 0.35,
  } = options;

  const pending = (transactions || []).filter(isTransactionPending);
  if (!pending.length || !candidate) return null;

  const amt = Math.round(Math.abs(Number(candidate.amount) || 0) * 100);
  if (!amt) return null;

  let best = null;
  let bestScore = -1;

  pending.forEach(tx => {
    if (tx.type !== candidate.type) return;
    const txAmt = Math.round(Math.abs(Number(tx.amount) || 0) * 100);
    if (txAmt !== amt) return;

    const dayDiff = daysBetween(tx.date, candidate.date);
    if (dayDiff > dateWindowDays) return;

    const sim = descriptionSimilarity(tx.description, candidate.description);
    // Same day: allow weaker description (amount is strong signal)
    // Cross-day: require minSimilarity
    if (dayDiff > 0 && sim < minSimilarity) return;
    if (dayDiff === 0 && sim < 0.15 && normalizeMerchantDescription(tx.description)
      && normalizeMerchantDescription(candidate.description)) {
      // Both have descriptions but totally different — skip unless one is empty
      const na = normalizeMerchantDescription(tx.description);
      const nb = normalizeMerchantDescription(candidate.description);
      if (na && nb && sim < 0.15) return;
    }

    // Score: similarity primary, recency secondary
    const score = sim * 10 + (dateWindowDays - dayDiff);
    if (score > bestScore) {
      bestScore = score;
      best = tx;
    }
  });

  return best;
}

export function clusterDuplicateTransactions(transactions, options = {}) {
  // User confirmed unique (e.g. two real PlayStation purchases) — never cluster again
  const txs = (transactions || []).filter(t =>
    t?.id
    && Math.abs(Number(t.amount) || 0) > 0
    && !t.duplicateOk
  );
  const buckets = new Map();

  txs.forEach(tx => {
    const key = `${tx.type}|${Math.round(Math.abs(Number(tx.amount)) * 100)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(tx);
  });

  const parent = new Map();
  const find = (id) => {
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  };
  const unite = (idA, idB) => {
    const rootA = find(idA);
    const rootB = find(idB);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  buckets.forEach(items => {
    if (items.length < 2) return;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (areLikelyDuplicatePair(items[i], items[j], options)) {
          if (!parent.has(items[i].id)) parent.set(items[i].id, items[i].id);
          if (!parent.has(items[j].id)) parent.set(items[j].id, items[j].id);
          unite(items[i].id, items[j].id);
        }
      }
    }
  });

  const groups = new Map();
  parent.forEach((_, id) => {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    const tx = txs.find(t => t.id === id);
    if (tx) groups.get(root).push(tx);
  });

  return [...groups.values()]
    .filter(items => items.length >= 2)
    .map(items => items.sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id))));
}

export function detectBankFormat(rows) {
  if (!rows.length) return 'unknown';
  const keys = Object.keys(rows[0]).map(k => k.toLowerCase());
  if (keys.some(k => k.includes('debit')) && keys.some(k => k.includes('credit'))) return 'debits-credits';
  if (keys.includes('amount')) return 'signed-amount';
  return 'generic';
}