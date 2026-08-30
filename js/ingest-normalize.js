/** Shared ingest payload → FigPig import rows. Used by the Netlify function, tests, and the app. */

const ACCOUNTISH = /\b\d{8,}\b/g;

export function redactSensitive(text) {
  let t = String(text || '');
  t = t.replace(ACCOUNTISH, '[REDACTED]');
  t = t.replace(/(Account\s*Number\s*)\d+/gi, '$1[REDACTED]');
  t = t.replace(/(Routing\s*Number\s*)\d+/gi, '$1[REDACTED]');
  return t.trim();
}

function parseMoney(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n === 0) return null;
  return negative ? -Math.abs(n) : n;
}

function isoDate(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  const mon = s.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (mon) {
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const mm = months[mon[1].slice(0, 3).toLowerCase()];
    if (mm) return `${mon[3]}-${mm}-${String(mon[2]).padStart(2, '0')}`;
  }
  return null;
}

function signedAmount(row) {
  if (row.amount != null && row.amount !== '') {
    const signed = parseMoney(row.amount);
    if (signed == null) return null;
    const typeHint = String(row.type || row.direction || '').toLowerCase();
    if (typeHint === 'expense' || typeHint === 'out' || typeHint === 'debit') {
      return -Math.abs(signed);
    }
    if (typeHint === 'income' || typeHint === 'in' || typeHint === 'credit') {
      return Math.abs(signed);
    }
    return signed;
  }
  const debit = parseMoney(row.debit);
  const credit = parseMoney(row.credit);
  if (debit != null) return -Math.abs(debit);
  if (credit != null) return Math.abs(credit);
  return null;
}

function firstHint(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    if (typeof v === 'object') {
      const inner = firstHint(v.id, v.name, v.envelope, v.category);
      if (inner) return inner;
      continue;
    }
    const s = redactSensitive(String(v).trim());
    if (s) return s;
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {{ date: string, amount: number, type: 'income'|'expense', description: string, pending: boolean, bankCategory: string|null, requestedEnvelope: string|null }[]}
 */
export function normalizeIngestTransactions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const date = isoDate(row.date || row.Date);
    const signed = signedAmount(row);
    if (!date || signed == null) continue;
    const pending = row.pending === true
      || /pending/i.test(String(row.status || row.Status || ''));
    const type = signed < 0 ? 'expense' : 'income';
    const description = redactSensitive(
      row.description || row.Description || row.merchant || row.merchant_name || row.name || 'USAA transaction',
    );
    const bankCategory = redactSensitive(row.bankCategory || row.category || row.Category || '') || null;
    const requestedEnvelope = firstHint(
      row.envelope,
      row.Envelope,
      row.envelopeId,
      row.envelope_id,
      row.envelopeID,
      row.envelopeName,
      row.envelope_name,
      row.categoryId,
      row.category_id,
      row.CategoryId,
      row.category,
      row.Category,
      row.bankCategory,
    );
    out.push({
      date,
      amount: Math.abs(signed),
      type,
      description: description || 'USAA transaction',
      pending,
      bankCategory,
      requestedEnvelope,
    });
  }
  return out;
}

export function inboxRowsToImportObjects(txs) {
  return (txs || []).map((t) => ({
    Date: t.date,
    Description: t.description,
    Amount: t.type === 'income' ? Math.abs(Number(t.amount) || 0) : -Math.abs(Number(t.amount) || 0),
    Status: t.pending ? 'Pending' : 'Posted',
    Category: t.bankCategory || '',
    Envelope: t.requestedEnvelope || '',
  }));
}
