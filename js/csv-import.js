import { todayISO, formatLocalISODate, parseCSV } from './utils.js';
import { normalizeIngestSplits } from './ingest-normalize.js';

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

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_DATE_RE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/gi;

/** Normalize dates from common bank export formats to YYYY-MM-DD (local calendar). */
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

  MONTH_DATE_RE.lastIndex = 0;
  const mon = MONTH_DATE_RE.exec(s);
  if (mon) {
    const m = MONTH_NAMES[mon[1].toLowerCase()];
    if (m) {
      return `${mon[3]}-${String(m).padStart(2, '0')}-${String(mon[2]).padStart(2, '0')}`;
    }
  }

  // MMDDYY or MMDD suffix from USAA merchant lines (e.g. 071426, 0713)
  const md = s.match(/\b(0[1-9]|1[0-2])([0-3]\d)(\d{2})?\b/);
  if (md) {
    const month = md[1];
    const day = md[2];
    let year = md[3] ? 2000 + Number(md[3]) : new Date().getFullYear();
    if (md[3] && Number(md[3]) > 70) year = 1900 + Number(md[3]);
    // Prefer recent year if only MMDD
    if (!md[3]) {
      const now = new Date();
      year = now.getFullYear();
      const candidate = new Date(year, Number(month) - 1, Number(day));
      if (candidate.getTime() - now.getTime() > 180 * 86400000) year -= 1;
    }
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return formatLocalISODate(parsed);
  }

  return null;
}

/** True when text looks like a normal bank CSV (headers with Date + Amount). */
export function looksLikeStandardBankCsv(text) {
  const head = String(text || '').slice(0, 800).toLowerCase();
  const hasDate = /\bdate\b/.test(head);
  const hasAmount = /\bamount\b/.test(head) || /\bdebit\b/.test(head) || /\bcredit\b/.test(head);
  const hasDesc = /\bdescription\b/.test(head) || /\bmemo\b/.test(head) || /\bpayee\b/.test(head);
  // Standard USAA export: Date,Description,Original Description,Category,Amount,Status
  if (hasDate && hasAmount && hasDesc && head.includes(',')) {
    // Funky paste often has "Date Amount" jammed without Description column of real rows
    if (/date\s*,\s*description/.test(head) || /date,description/i.test(head)) return true;
    if (/date\s*,\s*amount/.test(head) && !/description/.test(head)) return false;
  }
  return hasDate && hasAmount && hasDesc && /date\s*,/i.test(String(text || '').slice(0, 200));
}

/** Bank labels seen in USAA CSV + mobile web paste (longest match first when stripping). */
const USAA_CATS = [
  'Electronics & Software',
  'Credit Card Payment',
  'Gifts & Donations',
  'Movies & DVDs',
  'Food & Dining',
  'Auto Payment',
  'Gas & Transportation',
  'Sporting Goods',
  'Category Pending',
  'Fast Food',
  'Shopping',
  'Hobbies',
  'Groceries',
  'Utilities',
  'Insurance',
  'Pharmacy',
  'Medical',
  'Dentist',
  'Entertainment',
  'Clothing',
  'Financial',
  'Paycheck',
  'Charity',
  'Travel',
  'Transfer',
  'Income',
  'Gas',
].sort((a, b) => b.length - a.length);

const MONEY_TOKEN_RE = /-?\$[\d,]+\.\d{2}/g;
// No leading \b — USAA mobile jams "BalanceAug 03, 2026" with no space/boundary
const MOBILE_DATE_RE = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s+(\d{4})(?!\d)/gi;

/** True when text looks like USAA mobile web “select all” paste (not a real CSV). */
export function looksLikeUsaaMobileWebPaste(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  const dateHits = (s.match(new RegExp(MOBILE_DATE_RE.source, 'gi')) || []).length;
  // Explicit mobile chrome / header
  if (/mobile\.usaa\.com/i.test(s) && dateHits >= 1) return true;
  if (/amount\s*current\s*balance|amountcurrent\s*balance/i.test(s) && dateHits >= 1) return true;
  // Jammed rows: "Aug 03, 2026…-$90.00$5,559.17" without CSV commas as structure
  const moneyPairs = (s.match(/-?\$[\d,]+\.\d{2}\$[\d,]+\.\d{2}/g) || []).length;
  if (dateHits >= 2 && moneyPairs >= 2 && !looksLikeStandardBankCsv(s)) return true;
  return false;
}

/** Strip trailing USAA bank category labels (may run twice after other cleanups). */
function stripTrailingUsaaCategory(text) {
  let d = String(text || '').trim();
  for (const cat of USAA_CATS) {
    if (cat === 'Category Pending') continue;
    const re = new RegExp(`${escapeRegExp(cat)}\\s*$`, 'i');
    if (re.test(d)) {
      d = d.replace(re, '').trim();
      break;
    }
  }
  return d;
}

/**
 * Clean USAA mobile-web description: drop pending labels, bank categories,
 * card masks, and obvious TitleCase+SCREAMING doubles.
 */
function cleanMobileWebDescription(raw) {
  let d = String(raw || '')
    .replace(/…/g, ' ')
    .replace(/\u2026/g, ' ')
    // Drop redacted account stars (codes like U0P3 stay; category strip cleans the rest)
    .replace(/\*+/g, ' ')
    .replace(/pending\s*category\s*pending/gi, ' ')
    .replace(/category\s*pending/gi, ' ')
    .replace(/\bpending\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  d = stripTrailingUsaaCategory(d);

  // "CinemarkCINEMARK 1142…" → drop redundant Title Case prefix, keep rest of line
  // Only when the CAPS block *starts with* the same merchant (not later in the line).
  const jam = d.match(/^([A-Za-z][A-Za-z0-9 .,'&/-]{1,30}?)([A-Z]{3,}[\s\S]*)$/);
  if (jam) {
    const pretty = jam[1].replace(/[\s.'/-]/g, '').toLowerCase();
    const restHead = jam[2].slice(0, 48).replace(/[\s.'/*-]/g, '').toLowerCase();
    const keyLen = Math.min(pretty.length, 10);
    if (pretty.length >= 3 && restHead.startsWith(pretty.slice(0, keyLen))) {
      d = jam[2].trim();
    }
  }

  d = stripTrailingUsaaCategory(d);
  d = d.replace(/\s+/g, ' ').trim();
  // Collapse exact "WORD WORD" duplicates
  d = d.replace(/\b([A-Za-z0-9*&.'-]{3,})\s+\1\b/gi, '$1');
  return d || 'Unknown';
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMobileCategory(preAmount) {
  const s = String(preAmount || '');
  if (/pending/i.test(s)) {
    return { category: 'Category Pending', status: 'Pending' };
  }
  for (const cat of USAA_CATS) {
    if (cat === 'Category Pending') continue;
    const re = new RegExp(`${escapeRegExp(cat)}\\s*$`, 'i');
    if (re.test(s)) {
      return { category: cat, status: 'Posted' };
    }
  }
  return { category: '', status: 'Posted' };
}

/**
 * Parse USAA mobile website copy/paste (select-all transaction list).
 * Handles jammed rows without newlines, pending-before-desc, running balances.
 * Returns row objects compatible with normalizeImportRow.
 */
export function parseUsaaMobileWebPaste(text) {
  let raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return [];

  // Drop browser/chrome noise from multi-page selects
  raw = raw
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*(AM|PM)\b/gi, ' ')
    .replace(/\bPage\s+\d+\s+of\s+\d+\b/gi, ' ')
    .replace(/Date\s*Description\s*Category\s*Amount\s*Current\s*Balance/gi, ' ')
    .replace(/Amount\s*Current\s*Balance|AmountCurrent\s*Balance/gi, ' ')
    .replace(/Current\s*Balance/gi, ' ');

  const dateRe = new RegExp(MOBILE_DATE_RE.source, 'gi');
  const hits = [];
  let m;
  while ((m = dateRe.exec(raw)) !== null) {
    hits.push({
      index: m.index,
      end: m.index + m[0].length,
      date: parseImportDate(m[0]),
      rawDate: m[0],
    });
  }
  if (!hits.length) return [];

  const rows = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (!hit.date) continue;
    const bodyStart = hit.end;
    const bodyEnd = i + 1 < hits.length ? hits[i + 1].index : raw.length;
    let body = raw.slice(bodyStart, bodyEnd).trim();
    if (!body) continue;

    // Collect money tokens in order
    const monies = [];
    const moneyRe = new RegExp(MONEY_TOKEN_RE.source, 'g');
    let mm;
    while ((mm = moneyRe.exec(body)) !== null) {
      monies.push({
        raw: mm[0],
        index: mm.index,
        end: mm.index + mm[0].length,
        value: parseMoneyValue(mm[0]),
      });
    }
    if (monies.length < 1) continue;

    // Last money = running balance (skip as amount). Tx amount is second-to-last when present.
    let amountTok;
    let balanceTok = null;
    if (monies.length >= 2) {
      balanceTok = monies[monies.length - 1];
      amountTok = monies[monies.length - 2];
      // Balance is almost always unsigned positive; if second-to-last is also unsigned
      // and last is larger, still treat as amount+balance (income rows).
    } else {
      amountTok = monies[0];
    }

    if (!amountTok || amountTok.value === 0) continue;

    const beforeAmt = body.slice(0, amountTok.index);
    const betweenAmtBal = balanceTok
      ? body.slice(amountTok.end, balanceTok.index)
      : body.slice(amountTok.end);

    const { category, status } = extractMobileCategory(beforeAmt);

    // Description: text before amount, plus any merchant stuck between amount and balance
    let descParts = [beforeAmt];
    if (betweenAmtBal && /[A-Za-z]/.test(betweenAmtBal)) {
      descParts.push(betweenAmtBal);
    }
    let description = cleanMobileWebDescription(descParts.join(' '));

    // If description is still junk, try only the between-amount fragment (pending layout)
    if (isJunkDesc(description) && betweenAmtBal) {
      description = cleanMobileWebDescription(betweenAmtBal);
    }

    rows.push({
      Date: hit.date,
      Description: description,
      'Original Description': description,
      Category: category || '',
      Amount: amountTok.value.toFixed(2),
      Status: status || 'Posted',
    });
  }

  return rows;
}

function cleanFunkyLine(line) {
  let s = String(line || '').replace(/^\uFEFF/, '').trim();
  s = s.replace(/,+\s*$/, '');
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  // Fix common mojibake ellipsis from bad encodings
  s = s.replace(/\uFFFD/g, '').replace(/…/g, '').trim();
  return s;
}

function isBalanceOnlyLine(s) {
  return /^\$[\d,]+\.\d{2}$/.test(s);
}

function isJunkDesc(desc) {
  if (!desc) return true;
  const d = String(desc)
    .replace(/description|category|pending/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (d.length < 2) return true;
  // Card mask only
  if (/^\*+\d{3,}$/.test(d)) return true;
  if (/^NC$/i.test(d)) return true;
  return false;
}

function extractAmountFromLine(s) {
  const m = String(s).match(
    /(-\s*\$?\s*[\d,]+\.\d{2}|\+\s*\$?\s*[\d,]+\.\d{2}|\$\s*[\d,]+\.\d{2}|-?\s*[\d,]+\.\d{2})\s*$/,
  );
  if (!m) return { amount: null, rest: s };
  const raw = m[1];
  const rest = s.slice(0, m.index).trim();
  const cleaned = raw.replace(/[$,\s]/g, '');
  const amount = parseFloat(cleaned);
  if (isNaN(amount) || amount === 0) return { amount: null, rest: s };
  return { amount, rest };
}

function stripCategoryAndStatus(rest) {
  let r = rest;
  let category = '';
  let status = '';
  const sorted = [...USAA_CATS].sort((a, b) => b.length - a.length);
  for (const c of sorted) {
    if (r.endsWith(c)) {
      category = c;
      r = r.slice(0, -c.length).trim();
      break;
    }
  }
  if (/category\s*pending|pending/i.test(r) && !category) {
    category = 'Category Pending';
    r = r
      .replace(/pending\s*category\s*pending/gi, ' ')
      .replace(/category\s*pending/gi, ' ')
      .replace(/\bpending\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    status = 'Pending';
  }
  if (category === 'Category Pending') status = 'Pending';
  r = r.replace(/^description\s*/i, '').trim();
  return { text: r, category, status };
}

function extractLastDate(s) {
  let last = null;
  let after = s;
  MONTH_DATE_RE.lastIndex = 0;
  let m;
  // Reset for global
  const re = new RegExp(MONTH_DATE_RE.source, 'gi');
  while ((m = re.exec(s)) !== null) {
    last = parseImportDate(m[0]);
    after = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
    // continue to find last date in jammed multi-date lines
  }
  // rebuild after by removing all dates
  after = s.replace(new RegExp(MONTH_DATE_RE.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
  return { date: last, after };
}

function dateFromMerchantCode(desc, fallbackYear) {
  // 071426 → Jul 14 2026; 071326 → Jul 13
  const m = String(desc || '').match(/\b(0[1-9]|1[0-2])([0-3]\d)(\d{2})?\b/);
  if (!m) return null;
  return parseImportDate(m[0].length === 4 ? m[0] : m[0]);
}

/**
 * Parse mangled USAA app paste / "Blank.csv" style exports where columns are
 * scrambled across lines (Date Amount header, trailing commas, balances mixed in).
 * Returns row objects compatible with normalizeImportRow / standard USAA CSV shape.
 */
export function parseUsaaAppPasteCsv(text) {
  const rawLines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = rawLines.map(cleanFunkyLine).filter(Boolean);

  const rows = [];
  let lastDate = null;
  let lastDesc = null;

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    const low = s.toLowerCase();
    if (isBalanceOnlyLine(s) || low === 'current balance' || low.startsWith('date amount')) {
      continue;
    }

    const { amount, rest } = extractAmountFromLine(s);
    if (amount != null) {
      if (isBalanceOnlyLine(s)) continue;

      let { text: rest2, category, status } = stripCategoryAndStatus(rest);
      const dated = extractLastDate(rest2);
      if (dated.date) {
        lastDate = dated.date;
        rest2 = dated.after;
      }

      let desc = rest2;
      if (isJunkDesc(desc)) desc = '';

      // Prefer prior merchant label (e.g. CITI CARD ONLINE PAYMENT before amount)
      if (!desc && lastDesc && !isJunkDesc(lastDesc)) {
        desc = lastDesc;
      }

      // Look ahead for merchant line if still empty
      if (!desc) {
        for (let j = i + 1; j < lines.length; j++) {
          const ns = lines[j];
          if (isBalanceOnlyLine(ns) || ns.toLowerCase() === 'current balance') continue;
          const na = extractAmountFromLine(ns);
          if (na.amount != null) break;
          const nd = extractLastDate(ns);
          if (nd.date) {
            lastDate = nd.date;
            if (nd.after && !isJunkDesc(nd.after)) {
              desc = nd.after;
              lastDesc = desc;
              i = j;
            }
            break;
          }
          if (ns && !isJunkDesc(ns)) {
            desc = ns;
            lastDesc = desc;
            i = j;
            break;
          }
        }
      }

      if (!desc) desc = lastDesc || 'Unknown';
      if (!isJunkDesc(desc)) lastDesc = desc;

      let date = lastDate || '';
      const codeDate = dateFromMerchantCode(desc);
      // Merchant MMDD codes often more accurate than scrambled multi-date headers
      if (codeDate) {
        date = codeDate;
        lastDate = codeDate;
      }
      if (!date) date = todayISO();

      // Skip pure running-balance positives with no real merchant
      if (amount > 0 && isJunkDesc(desc) && /^\$/.test(s)) continue;

      rows.push({
        Date: date,
        Description: desc.trim(),
        'Original Description': desc.trim(),
        Category: category || '',
        Amount: amount.toFixed(2),
        Status: status || (/pending/i.test(s) ? 'Pending' : 'Posted'),
      });
      continue;
    }

    // No amount: carry date / description forward
    const nd = extractLastDate(s);
    if (nd.date) {
      lastDate = nd.date;
      if (nd.after && !isJunkDesc(nd.after) && nd.after.toLowerCase() !== 'current balance') {
        lastDesc = nd.after;
      }
    } else if (s && s.toLowerCase() !== 'current balance' && !isBalanceOnlyLine(s) && !isJunkDesc(s)) {
      lastDesc = s;
    }
  }

  return rows;
}

/**
 * Parse any bank CSV: standard USAA/Chase export, mobile web paste, or mangled app paste.
 * Returns array of row objects for importTransactions / normalizeImportRow.
 */
export function parseBankCsvText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];

  // USAA mobile site select-all (before CSV heuristics — no real columns)
  if (looksLikeUsaaMobileWebPaste(raw)) {
    const mobile = parseUsaaMobileWebPaste(raw);
    if (mobile.length) return mobile;
  }

  // Prefer standard when headers look complete
  if (looksLikeStandardBankCsv(raw)) {
    const rows = parseCSV(raw);
    // Guard: if almost no usable amounts, fall through to funky parser
    const usable = rows.filter(r => {
      const vals = Object.values(r || {}).join(' ');
      return /[\d,]+\.\d{2}/.test(vals);
    });
    if (usable.length >= 1) return rows;
  }

  // Try mobile paste even if detector was unsure
  const mobileFallback = parseUsaaMobileWebPaste(raw);
  if (mobileFallback.length >= 2) return mobileFallback;

  // "Date Amount" paste / Blank.csv style
  const funky = parseUsaaAppPasteCsv(raw);
  if (funky.length) return funky;

  // Last resort: standard parseCSV anyway
  return parseCSV(raw);
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
  // Loan / auto-pay labels are not gas — leave uncategorized for rules / Review
  [/auto payment|automatic payment|auto loan|car payment|loan payment/, null],
  [/mortgage|home loan|housing|rent|hoa/, 'Mortgage'],
  [/groc/, 'Groceries'],
  [/restaurant|dining|food and drink|food & drink|fast food|coffee|cafe/, 'Eating Out / Fast Food'],
  [/gas|fuel|transportation|parking|toll/, 'Gas & Transportation'],
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

function pickExactField(map, keys) {
  for (const key of keys) {
    const value = map.get(String(key).toLowerCase());
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

/**
 * Match an ingest/import envelope hint (name or id) to a user envelope.
 * Exact id, then case-insensitive name. No bank-label or merchant heuristics.
 */
export function resolveRequestedEnvelope(hint, userCategories) {
  const raw = String(hint || '').trim();
  if (!raw || !Array.isArray(userCategories) || !userCategories.length) return null;

  const byId = userCategories.find(c => c && c.id && String(c.id) === raw);
  if (byId) return byId.id;

  const key = raw.toLowerCase();
  const byName = userCategories.find(c =>
    c && !c.parentId && String(c.name || '').trim().toLowerCase() === key,
  );
  if (byName) return byName.id;

  const norm = normalizeLabel(raw);
  if (!norm) return null;
  const byNorm = userCategories.find(c =>
    c && !c.parentId && normalizeLabel(c.name) === norm,
  );
  return byNorm?.id || null;
}

/**
 * Resolve ingest split lines to envelope ids. All lines must resolve and
 * cover the transaction total. Otherwise return null (caller may fall back).
 */
export function resolveRequestedSplits(parts, userCategories, totalAmount) {
  if (!Array.isArray(parts) || parts.length < 2 || !Array.isArray(userCategories)) return null;
  const total = Math.round(Math.abs(Number(totalAmount) || 0) * 100) / 100;
  if (!(total > 0)) return null;
  const out = [];
  for (const part of parts) {
    if (!part) return null;
    const id = resolveRequestedEnvelope(
      part.envelope || part.category || part.categoryId || part.Envelope,
      userCategories,
    );
    const amount = Math.round(Math.abs(Number(part.amount) || 0) * 100) / 100;
    if (!id || !(amount > 0)) return null;
    out.push({ categoryId: id, amount });
  }
  const sum = Math.round(out.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  if (Math.abs(sum - total) >= 0.01) return null;
  return out;
}

function pickRequestedSplits(row, map, totalAmount) {
  const raw = row?.splits || row?.Splits || row?.split
    || map.get('splits') || map.get('split');
  if (!raw) return null;
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return null; }
  }
  return normalizeIngestSplits(list, totalAmount);
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
 *
 * An explicit envelope/category that matches a user envelope (name or id)
 * wins over merchant maps, so ingest envelope "dad" on a Walmart row stays Dad.
 */
export function resolveCategoryId(bankCategory, description, userCategories, txType) {
  if (txType !== 'expense') return null;

  const requested = resolveRequestedEnvelope(bankCategory, userCategories);
  if (requested) return requested;

  // Merchant names beat generic bank labels — USAA often tags Sam's Club as "Food & Dining"
  const fromDesc = mapDescriptionToEnvelope(description, userCategories);
  if (fromDesc) return fromDesc;

  const fromBank = mapBankLabelToEnvelope(bankCategory, userCategories);
  if (fromBank) return fromBank;

  return null;
}

/**
 * USAA last-4 / ACH mask (***********1442) or Amazon-style *ORDERID.
 * Two Venmo PAYMENT rows same day same $ are distinct when these differ.
 */
export function extractBankRef(description) {
  const s = String(description || '');
  const masked = s.match(/\*{3,}([A-Za-z0-9]{3,})\b/);
  if (masked) return masked[1].toLowerCase();
  const starred = s.match(/\*([A-Za-z0-9]{6,})\b/);
  if (starred) return starred[1].toLowerCase();
  return '';
}

export function bankRefsConflict(a, b) {
  const ra = extractBankRef(a);
  const rb = extractBankRef(b);
  return Boolean(ra && rb && ra !== rb);
}

function appendBankRef(description, original) {
  const pretty = String(description || '').trim();
  const orig = String(original || '').trim();
  const origRef = extractBankRef(orig);
  if (!origRef || extractBankRef(pretty) === origRef) return pretty;
  const starChunk = orig.match(/\*{3,}[A-Za-z0-9]{3,}|\*[A-Za-z0-9]{6,}/);
  return `${pretty} ${starChunk ? starChunk[0] : origRef}`.trim();
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

  const pretty = getField(
    map,
    'description',
    'transaction description',
    'memo',
    'payee',
    'name',
    'details',
    'merchant',
  );
  const original = getField(map, 'original description');
  const description = appendBankRef(pretty || original, original);

  const categoryField = getField(
    map,
    'category',
    'category name',
    'transaction category',
    'spending category',
    'usaa category',
  );

  const requestedEnvelope = pickExactField(map, [
    'envelope',
    'envelopeid',
    'envelope_id',
    'envelope id',
    'envelopename',
    'envelope_name',
    'envelope name',
    'categoryid',
    'category_id',
    'category id',
  ]);

  // Envelope/id from ingest wins as the category hint so store.importTransactions
  // (which reads tx.bankCategory) applies it even without a store.js change.
  const bankCategory = requestedEnvelope || categoryField;

  const status = getField(map, 'status').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return null;
  const pending = status === 'pending' || status.startsWith('pending ');
  if (!includePending && pending) return null;

  // Statement exports with separate debit & credit columns
  const debitRaw = getField(map, 'debits', 'debit', 'withdrawal', 'withdrawals', 'money out');
  const creditRaw = getField(map, 'credits', 'credit', 'deposit', 'deposits', 'money in');
  const debit = Math.abs(parseMoneyValue(debitRaw));
  const credit = Math.abs(parseMoneyValue(creditRaw));

  let amount = 0;
  let type = 'expense';
  if (debit > 0 || credit > 0) {
    if (credit > 0 && debit === 0) {
      amount = credit;
      type = 'income';
    } else {
      amount = debit || 0;
      type = 'expense';
    }
  } else {
    const amountRaw = getField(map, 'amount', 'transaction amount', 'amt');
    if (!amountRaw) return null;
    const signed = parseMoneyValue(amountRaw);
    if (signed === 0) return null;
    amount = Math.abs(signed);
    type = signed < 0 ? 'expense' : 'income';
  }

  const requestedSplits = type === 'expense' ? pickRequestedSplits(row, map, amount) : null;
  const base = {
    description,
    bankCategory,
    pending,
    requestedEnvelope: requestedEnvelope || null,
    requestedSplits,
  };

  return { date, amount, type, ...base };
}

export const DUPLICATE_DATE_WINDOW_DAYS = 7;

const OUTFLOW_TYPES = new Set(['expense', 'debt_payment', 'transfer']);

/** Bank-generic labels after lowercase / hyphen collapse (not merchant-stripped). */
const TRANSFER_PAYMENT_LABELS = [
  'icpayment',
  'dda debit',
  'dda',
  'ach',
  'zelle',
  'transfer',
  'credit card payment',
  'citi credit card payment',
  'citi credit',
  'online payment',
  'web payment',
  'card payment',
];

export function isOutflowType(type) {
  return OUTFLOW_TYPES.has(type);
}

/** Work-trip ACH (GSA / Federal Travel Payments). Surplus after the card payoff goes to Dad. */
export function looksLikeFederalTravelPayment(description) {
  const raw = String(description || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bfederal\s+travel\b/.test(raw)) return true;
  const n = normalizeMerchantDescription(description);
  return /\bfederal\s+travel\b/.test(n);
}

export function looksLikeBankTransferLabel(description) {
  const raw = String(description || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, '');
  if (compact === 'icpayment' || compact === 'ddadebit' || compact === 'dda') return true;
  const phrases = TRANSFER_PAYMENT_LABELS.filter(l => l.includes(' '));
  if (phrases.some(p => raw.includes(p))) return true;
  const tokens = new Set(raw.split(' '));
  if (tokens.has('icpayment') || tokens.has('zelle') || tokens.has('ach') || tokens.has('transfer')) return true;
  return false;
}

/** Prefer posted merchant names over pending WAL-MART #4428 082626 noise. */
export function pickClearerDescription(existing, incoming, { preferIncoming = false } = {}) {
  const a = String(existing || '').trim();
  const b = String(incoming || '').trim();
  if (preferIncoming && b) return extractBankRef(b) || !extractBankRef(a) ? b : a;
  if (!a) return b;
  if (!b) return a;
  // Keep ***********1442 so two same-day Venmos stay distinguishable after posting.
  const refA = extractBankRef(a);
  const refB = extractBankRef(b);
  if (refA && !refB) return a;
  if (refB && !refA) return b;
  const ugly = (s) => /\b\d{6}\b/.test(s) || /#\s*\d{3,}/.test(s);
  if (ugly(a) && !ugly(b)) return b;
  if (ugly(b) && !ugly(a)) return a;
  const na = normalizeMerchantDescription(a);
  const nb = normalizeMerchantDescription(b);
  if (nb.length > na.length + 2) return b;
  if (na.length > nb.length + 2) return a;
  return a;
}

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
  // Collapse common Amazon / marketplace variants before tokenizing
  s = s.replace(/\bamzn\b/g, 'amazon');
  s = s.replace(/\bamazon\.?com\b/g, 'amazon');
  s = s.replace(/\bmktpl\b|\bmktplace\b|\bmarketplace\b/g, 'marketplace');
  s = s.replace(/\bwal-?mart\b/g, 'walmart');
  s = s.replace(/\bmc donald/g, 'mcdonald');
  // USPS pending "USPS PO 36248…" vs posted "US Postal Service"
  s = s.replace(/\bunited\s+states\s+postal\s+(service|svc)\b/g, 'usps');
  s = s.replace(/\bu\.?\s*s\.?\s+postal\s+(service|svc)\b/g, 'usps');
  s = s.replace(/\busps\s+po\b/g, 'usps');
  s = s.replace(STORE_NUMBER, ' ');
  // Order / auth codes (AMAZON MKTPL*XP57B2H33)
  s = s.replace(/\*[a-z0-9]+\b/g, ' ');
  s = s.replace(/\b[a-z]*\d{3,}[a-z0-9]*\b/g, ' ');
  s = s.replace(DESC_NOISE, ' ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Brands too short for the 5-letter rule but still a real merchant. */
const SHORT_BRANDS = new Set([
  'citi', 'cvs', 'aldi', 'nike', 'amex', 'usaa', 'ikea', 'att', 'pnc',
  'bbt', 'discover', 'kfc', 'hbo', 'lowes', 'usps',
]);

function isWeakMerchantToken(t, weak) {
  if (!t || weak.has(t)) return true;
  if (SHORT_BRANDS.has(t)) return false;
  return t.length < 5;
}

/** Shared “real” merchant word (amazon, walmart, …) — ignores city/state noise */
export function shareStrongMerchantToken(a, b) {
  const ta = descriptionTokens(a);
  const tb = descriptionTokens(b);
  if (!ta.size || !tb.size) return false;
  const weak = new Set([
    'com', 'www', 'bill', 'billwa', 'online', 'store', 'inc', 'llc', 'usa',
    'us', 'wa', 'nc', 'ca', 'tx', 'ny', 'fl', 'ar', 'oh', 'pa', 'the', 'and',
  ]);
  for (const t of ta) {
    if (isWeakMerchantToken(t, weak)) continue;
    if (tb.has(t)) return true;
    // HUDSONNEWS vs HUDSON NEWS — jammed vs spaced merchant
    for (const u of tb) {
      if (isWeakMerchantToken(u, weak)) continue;
      if (t.includes(u) || u.includes(t)) return true;
    }
  }
  const ca = [...ta].join('');
  const cb = [...tb].join('');
  if (ca.length >= 6 && cb.length >= 6) {
    if (ca === cb) return true;
    const shorter = ca.length <= cb.length ? ca : cb;
    const longer = ca.length <= cb.length ? cb : ca;
    if (longer.includes(shorter)) return true;
  }
  return false;
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
  let score = union > 0 ? overlap / union : 0;

  // Brand-level boost: AMAZON.COM vs AMAZON MKTPL*XXXX should still pair
  if (shareStrongMerchantToken(na, nb)) {
    score = Math.max(score, 0.65);
  }
  return score;
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
  // Same outflow leaving checking: imported Citi payment vs logged debt payment
  const outflow = new Set(['expense', 'debt_payment', 'transfer']);
  if (a.type !== b.type && !(outflow.has(a.type) && outflow.has(b.type))) return false;

  const amtA = Math.round(Math.abs(Number(a.amount) || 0) * 100);
  const amtB = Math.round(Math.abs(Number(b.amount) || 0) * 100);
  if (!amtA || amtA !== amtB) return false;
  if (bankRefsConflict(a.description, b.description)) return false;

  const dayDiff = daysBetween(a.date, b.date);
  // Same calendar day + same amount is NOT always a duplicate:
  // Chick-fil-A vs Lindt $20 must stay two purchases. Flag only when
  // merchants look related, both are generic bank-transfer labels, or one is a debt payment.
  if (dayDiff === 0) {
    if (areDescriptionsSimilar(a.description, b.description, crossDaySimilarity)) return true;
    if (shareStrongMerchantToken(a.description, b.description)) return true;
    if (looksLikeBankTransferLabel(a.description) && looksLikeBankTransferLabel(b.description)) return true;
    if ((a.type === 'debt_payment' || b.type === 'debt_payment')
      && (looksLikeBankTransferLabel(a.description) || looksLikeBankTransferLabel(b.description))) {
      return true;
    }
    return false;
  }
  if (dayDiff > dateWindowDays) return false;

  // Cross-day same amount: need similar merchant.
  // Use a slightly looser bar within 1–2 days (bank post lag / Amazon split posts).
  // Still requires merchant similarity so two different $12.83 kids' games can be
  // marked unique if descriptions differ and user confirms.
  const threshold = dayDiff <= 2 ? Math.min(crossDaySimilarity, 0.45) : crossDaySimilarity;
  if (areDescriptionsSimilar(a.description, b.description, threshold)) return true;
  // AMAZON.COM vs AMAZON MKTPL*orderid often fail pure Jaccard — brand token is enough
  if (shareStrongMerchantToken(a.description, b.description)) return true;
  return false;
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

  return (existing || []).some(t => {
    if (Math.round(Math.abs(Number(t.amount) || 0) * 100) !== amt) return false;
    if (String(t.date || '').slice(0, 10) !== day) return false;
    const sameType = t.type === tx.type;
    const bothOutflow = isOutflowType(t.type) && isOutflowType(tx.type);
    if (!sameType && !bothOutflow) return false;
    if (t.type === 'income' || tx.type === 'income') return sameType;
    if (bankRefsConflict(t.description, tx.description)) return false;

    const na = normalizeMerchantDescription(t.description);
    const nb = normalizeMerchantDescription(tx.description);
    if (!na || !nb) return true;
    if (na === nb) return true;
    if (t.type === 'debt_payment' || tx.type === 'debt_payment') return true;
    if (looksLikeBankTransferLabel(t.description) && looksLikeBankTransferLabel(tx.description)) return true;
    if (descriptionSimilarity(t.description, tx.description) >= 0.35) return true;
    // Distinct merchants same day same $ — keep both (Chick-fil-A vs Lindt)
    return false;
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

  // Also merge bank-pending purchases that already hit checking (post date often +1 day)
  const pending = (transactions || []).filter(t =>
    isTransactionPending(t) || t.bankPending,
  );
  if (!pending.length || !candidate) return null;

  const amt = Math.round(Math.abs(Number(candidate.amount) || 0) * 100);
  if (!amt) return null;

  const incomingRef = extractBankRef(candidate.description);
  const scored = [];

  pending.forEach(tx => {
    const sameType = tx.type === candidate.type;
    const bothOutflow = isOutflowType(tx.type) && isOutflowType(candidate.type);
    if (!sameType && !bothOutflow) return;
    const txAmt = Math.round(Math.abs(Number(tx.amount) || 0) * 100);
    if (txAmt !== amt) return;
    if (bankRefsConflict(tx.description, candidate.description)) return;

    const dayDiff = daysBetween(tx.date, candidate.date);
    if (dayDiff > dateWindowDays) return;

    const sim = descriptionSimilarity(tx.description, candidate.description);
    const sameMerchant = shareStrongMerchantToken(tx.description, candidate.description)
      || normalizeMerchantDescription(tx.description) === normalizeMerchantDescription(candidate.description);
    // Same day: allow weaker description (amount is strong signal)
    // Cross-day: require minSimilarity unless it's the same merchant (USPS PO → US Postal Service)
    if (dayDiff > 0 && sim < minSimilarity && !sameMerchant) return;
    if (dayDiff === 0 && sim < 0.15 && !sameMerchant) {
      const na = normalizeMerchantDescription(tx.description);
      const nb = normalizeMerchantDescription(candidate.description);
      if (na && nb) return;
    }

    // Score: similarity primary, recency secondary
    const score = sim * 10 + (dateWindowDays - dayDiff);
    scored.push({ tx, score, ref: extractBankRef(tx.description) });
  });

  if (!scored.length) return null;
  // Posted "Transfer to Venmo" without a last-4 must not guess among 1442 vs 7273.
  if (!incomingRef) {
    const distinctRefs = new Set(scored.map(s => s.ref).filter(Boolean));
    if (distinctRefs.size >= 2) return null;
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0].tx;
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
    const amt = Math.round(Math.abs(Number(tx.amount)) * 100);
    const key = isOutflowType(tx.type) ? `out|${amt}` : `${tx.type}|${amt}`;
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

/**
 * Console / node check for import merge rules. Does not touch the live budget.
 * window.FigPig.selfCheckImport() or: node scripts/test-import-reconcile.mjs
 */
export function selfCheckImportReconcile() {
  const failures = [];
  const check = (name, got, want) => {
    if (got !== want) failures.push(`${name}: got ${got}, want ${want}`);
  };

  check('wal-mart normalizes', normalizeMerchantDescription('WAL-MART #4428 082626'), 'walmart');
  check('federal travel payments match', looksLikeFederalTravelPayment('Federal Travel Payments'), true);
  check('federal travel ACH match', looksLikeFederalTravelPayment('FEDERAL TRAVEL PAYMENTS TREAS 310'), true);
  check('usps is not federal travel', looksLikeFederalTravelPayment('US Postal Service'), false);
  check(
    'usps po pending = usps',
    normalizeMerchantDescription('USPS PO 36248007 157 082626'),
    'usps',
  );
  check(
    'us postal service = usps',
    normalizeMerchantDescription('US Postal Service'),
    'usps',
  );
  check(
    'usps pending vs posted similar',
    descriptionSimilarity('USPS PO 36248007 157 082626', 'US Postal Service') >= 0.65,
    true,
  );
  const uspsPending = {
    date: '2026-08-27', amount: 12.90, type: 'expense',
    description: 'USPS PO 36248007 157 082626', id: 'up', bankPending: true,
  };
  const uspsPosted = {
    date: '2026-08-27', amount: 12.90, type: 'expense',
    description: 'US Postal Service', id: 'us',
  };
  check('usps pending import-dup of posted', isImportDuplicateTransaction([uspsPending], uspsPosted), true);
  check(
    'usps findBestPendingMatch',
    !!findBestPendingMatch([uspsPending], uspsPosted),
    true,
  );
  const vacpPending = {
    date: '2026-08-27', amount: 2378.45, type: 'income',
    description: 'VACP TREAS XXVA BENEF', id: 'vp', bankPending: true,
  };
  const vacpPosted = {
    date: '2026-08-27', amount: 2378.45, type: 'income',
    description: 'VACP TREAS XXVA BENEF', id: 'vf',
  };
  check('vacp pending import-dup of posted', isImportDuplicateTransaction([vacpPending], vacpPosted), true);
  check(
    'vacp findBestPendingMatch',
    !!findBestPendingMatch([vacpPending], vacpPosted),
    true,
  );
  check('ICPayment is transfer label', looksLikeBankTransferLabel('ICPayment'), true);
  check('DDA DEBIT is transfer label', looksLikeBankTransferLabel('DDA DEBIT'), true);
  check('Citi card payment is transfer label', looksLikeBankTransferLabel('Citi Credit Card Payment'), true);
  check('Chick-fil-A is not transfer label', looksLikeBankTransferLabel('Chick-fil-A'), false);

  const dda = { date: '2026-08-25', amount: 287.39, type: 'expense', description: 'DDA DEBIT' };
  const icp = { date: '2026-08-25', amount: 287.39, type: 'expense', description: 'ICPayment' };
  check('ICPayment merges DDA DEBIT', isImportDuplicateTransaction([dda], icp), true);
  check('ICPayment/DDA is Review pair', areLikelyDuplicatePair(dda, { ...icp, id: 'b' }), true);

  const debt = { date: '2026-08-17', amount: 2061.13, type: 'debt_payment', description: 'Snowball payment to Citi' };
  const citi = { date: '2026-08-17', amount: 2061.13, type: 'expense', description: 'Citi Credit Card Payment' };
  check('Citi expense merges debt_payment', isImportDuplicateTransaction([debt], citi), true);

  const chick = { date: '2026-08-24', amount: 20, type: 'expense', description: 'Chick-fil-A', id: 'c' };
  const lindt = { date: '2026-08-24', amount: 20, type: 'expense', description: 'Lindt', id: 'l' };
  check('Chick vs Lindt import keeps both', isImportDuplicateTransaction([chick], lindt), false);
  check('Chick vs Lindt not a Review pair', areLikelyDuplicatePair(chick, lindt), false);

  const v1442 = {
    date: '2026-09-01', amount: 20, type: 'expense',
    description: 'VENMO            PAYMENT    ***********1442', id: 'v1',
  };
  const v7273 = {
    date: '2026-09-01', amount: 20, type: 'expense',
    description: 'VENMO            PAYMENT    ***********7273', id: 'v2',
  };
  check('venmo last-4 extract 1442', extractBankRef(v1442.description), '1442');
  check('venmo last-4 extract 7273', extractBankRef(v7273.description), '7273');
  check('venmo last-4s not import dups', isImportDuplicateTransaction([v1442], v7273), false);
  check('venmo last-4s not Review pair', areLikelyDuplicatePair(v1442, v7273), false);
  check('same venmo last-4 is import dup', isImportDuplicateTransaction([v1442], { ...v1442, id: 'v1b' }), true);
  check(
    'venmo pending 1442 does not match 7273',
    !!findBestPendingMatch([{ ...v1442, bankPending: true }], v7273),
    false,
  );
  check(
    'venmo pending 1442 matches posted 1442',
    !!findBestPendingMatch([{ ...v1442, bankPending: true }], v1442),
    true,
  );
  const postedPretty = normalizeImportRow({
    Date: '2026-09-01',
    Description: 'Transfer to Venmo',
    'Original Description': 'VENMO            PAYMENT    ***********1442',
    Amount: '-20.00',
    Status: 'Posted',
  });
  check('posted Venmo keeps last-4 from original', extractBankRef(postedPretty?.description), '1442');
  check(
    'ambiguous Transfer to Venmo does not pick among last-4s',
    !!findBestPendingMatch(
      [{ ...v1442, bankPending: true }, { ...v7273, bankPending: true }],
      { date: '2026-09-01', amount: 20, type: 'expense', description: 'Transfer to Venmo' },
    ),
    false,
  );

  const clearer = pickClearerDescription('WAL-MART #4428 082626', 'Walmart', { preferIncoming: true });
  check('prefer posted Walmart name', clearer, 'Walmart');

  return { ok: failures.length === 0, failures };
}