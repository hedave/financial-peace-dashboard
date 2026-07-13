/**
 * Client-side PDF import (USAA statement text extract).
 * Parsing runs entirely in the browser — the PDF is never uploaded to a server.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DATE_LINE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})(.*)$/i;
const AMOUNT_TAIL = /(-?\$[\d,]+\.\d{2})\s*$/;
const REFUND = /Refund:\s*\$?([\d,]+\.\d{2})/i;
const TRAIL_MMDDYY = /\s+\d{6}\s*$/;

/** Strip account/routing-style numbers so they never enter import rows. */
export function redactSensitivePdfText(text) {
  let t = String(text || '');
  t = t.replace(/\b\d{8,}\b/g, '[REDACTED]');
  t = t.replace(/(Account\s*Number\s*)\d+/gi, '$1[REDACTED]');
  t = t.replace(/(Routing\s*Number\s*)\d+/gi, '$1[REDACTED]');
  t = t.replace(/accountId=[^\s&#"']+/gi, 'accountId=[REDACTED]');
  return t;
}

function parseMoney(raw) {
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function toIsoDate(mon, day, year) {
  const m = MONTHS[String(mon).slice(0, 3).toLowerCase()];
  if (!m) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

/**
 * Parse USAA mobile/checking PDF text into import-shaped rows.
 * @returns {{ date: string, amount: number, type: string, description: string, bankCategory: string|null, pending: boolean }[]}
 */
export function parseUsaaPdfText(rawText) {
  const text = redactSensitivePdfText(rawText);
  const rows = [];
  let cur = null;

  const flush = (amountLine) => {
    if (!cur) return;
    const refund = amountLine.match(REFUND);
    let amount;
    let type;
    let bankCategory = null;
    const pending = /pending/i.test(amountLine);

    if (refund) {
      amount = Math.abs(parseMoney(refund[1]));
      type = 'income';
    } else {
      const am = amountLine.match(AMOUNT_TAIL);
      if (!am) return;
      const signed = parseMoney(am[1]);
      amount = Math.abs(signed);
      type = signed > 0 ? 'income' : 'expense';
      let mid = amountLine.slice(0, am.index).trim();
      mid = mid.replace(/Pending\s*/gi, '').replace(/^Category\s*/i, '').trim();
      if (mid && !/^category$/i.test(mid)) {
        const parts = mid.split(/\s+/);
        bankCategory = parts.length <= 3 ? parts[parts.length - 1] : mid;
      }
    }

    if (!amount) return;
    rows.push({
      date: cur.date,
      amount,
      type,
      description: cur.description || 'USAA transaction',
      bankCategory: bankCategory || null,
      pending,
    });
    cur = null;
  };

  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;

    if (/^\$[\d,]+\.\d{2}$/.test(line)) return;
    if (/^Page\s+\d+/i.test(line)) return;
    if (/^https?:\/\//i.test(line)) return;
    if (/Date Description Category/i.test(line)) return;
    if (/^(Account Nickname|Available Balance|Rates|Interest|Annual Percentage)/i.test(line)) return;

    const dm = line.match(DATE_LINE);
    if (dm) {
      cur = null;
      const date = toIsoDate(dm[1], dm[2], dm[3]);
      if (!date) return;
      let desc = (dm[4] || '').trim();
      desc = desc.replace(TRAIL_MMDDYY, '').replace(/[.…]+$/g, '').trim();
      cur = { date, description: desc };
      return;
    }

    if (!cur) return;

    if (REFUND.test(line) || AMOUNT_TAIL.test(line)) {
      flush(line);
      return;
    }

    // Continuation / full merchant name (no dollar amount)
    if (!/\$/.test(line) && line.length > 2) {
      const upper = line === line.toUpperCase() && /[A-Z]/.test(line);
      if (upper || !cur.description) {
        cur.description = line;
      } else if (line.length > cur.description.length + 3 && /[A-Za-z]{3,}/.test(line)) {
        // e.g. city/state line — append only if short
        if (line.length < 40) {
          /* keep primary merchant from date line */
        }
      }
    }
  });

  return rows;
}

/**
 * Extract plain text from a PDF File using PDF.js (CDN, browser only).
 */
export async function extractPdfText(file) {
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/+esm');
  pdfjs.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const parts = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter(it => it && typeof it.str === 'string');
    if (!items.length) continue;

    // Group by rounded Y so multi-column PDFs stay somewhat line-ordered
    const linesMap = new Map();
    items.forEach((it) => {
      const y = it.transform ? Math.round(it.transform[5]) : 0;
      const x = it.transform ? it.transform[4] : 0;
      if (!linesMap.has(y)) linesMap.set(y, []);
      linesMap.get(y).push({ x, str: it.str });
    });

    const ys = [...linesMap.keys()].sort((a, b) => b - a);
    ys.forEach((y) => {
      const segs = linesMap.get(y).sort((a, b) => a.x - b.x);
      const line = segs.map(s => s.str).join('').trim();
      if (line) parts.push(line);
    });
    parts.push('');
  }

  return redactSensitivePdfText(parts.join('\n'));
}

/**
 * Parse a PDF File into row objects.
 */
export async function parseBankPdfFile(file) {
  const text = await extractPdfText(file);
  return parseUsaaPdfText(text);
}

/**
 * Convert parsed rows into objects normalizeImportRow can read
 * (Date / Description / Amount / Category / Status).
 */
export function rowsToImportObjects(rows, { includePending = true } = {}) {
  return (rows || [])
    .filter(r => includePending || !r.pending)
    .map(r => ({
      Date: r.date,
      Description: r.description,
      Amount: r.type === 'income' ? String(r.amount) : String(-Math.abs(r.amount)),
      Category: r.bankCategory || '',
      Status: r.pending ? 'Pending' : '',
    }));
}
