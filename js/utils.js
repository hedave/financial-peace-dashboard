export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = Math.random() * 16 | 0;
    return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** U+2212 minus + U+2060 word joiner: the sign can never wrap away from the "$". */
export const MONEY_MINUS = '\u2212\u2060';

/**
 * Display-only money string. Negatives use a true minus glued to the amount
 * (−$1,113.68). Values that round to $0.00 never show a sign.
 */
export function formatCurrency(amount) {
  const n = Number(amount) || 0;
  const text = USD.format(Math.abs(n));
  return n < 0 && text !== '$0.00' ? MONEY_MINUS + text : text;
}

const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
});
/** Compact display ($11.9K) for tiles that can't fit the full value; same sign rule. */
export function formatCurrencyCompact(amount) {
  const n = Number(amount) || 0;
  if (Math.abs(n) < 1000) return formatCurrency(n);
  const text = USD_COMPACT.format(Math.abs(n));
  return n < 0 ? MONEY_MINUS + text : text;
}

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function getMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function getPreviousMonth(monthKey = getCurrentMonth()) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function addMonths(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function getRecentMonths(count = 6, fromMonth = getCurrentMonth()) {
  const months = [];
  for (let i = 0; i < count; i++) {
    months.unshift(addMonths(fromMonth, -i));
  }
  return months;
}

export function getPayDaysInMonth(monthKey, day1, day2 = null) {
  const [y, m] = monthKey.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  const days = [];
  const add = (day) => {
    if (!day || day < 1 || day > 31) return;
    const dom = Math.min(day, lastDay);
    days.push(`${y}-${pad(m)}-${pad(dom)}`);
  };
  add(day1);
  if (day2) add(day2);
  return days;
}

export function isInMonth(dateStr, monthKey) {
  return dateStr && dateStr.startsWith(monthKey);
}

/** YYYY-MM-DD in the user's local timezone (not UTC — evenings were rolling to "tomorrow"). */
export function formatLocalISODate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return formatLocalISODate(new Date());
}

/**
 * Advance a YYYY-MM-DD date by one calendar month.
 * Clamps the day (e.g. Jan 31 → Feb 28/29).
 */
export function addOneMonthToDate(isoDate) {
  const raw = String(isoDate || todayISO()).slice(0, 10);
  const parts = raw.split('-').map(Number);
  if (parts.length < 3 || parts.some(n => Number.isNaN(n))) {
    return addOneMonthToDate(todayISO());
  }
  let [y, m, d] = parts;
  m += 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  const lastDay = new Date(y, m, 0).getDate();
  const dom = Math.min(d, lastDay);
  return `${y}-${String(m).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
}

export function daysUntil(dateStr) {
  const today = new Date(todayISO() + 'T12:00:00');
  const target = new Date(dateStr + 'T12:00:00');
  return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}

function parseCSVLine(line, delimiter = ',') {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === delimiter && !inQuotes) { values.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  values.push(current.trim());
  return values.map(v => v.replace(/^"|"$/g, ''));
}

function detectDelimiter(line) {
  const commaFields = parseCSVLine(line, ',').length;
  const tabFields = parseCSVLine(line, '\t').length;
  if (tabFields > commaFields) return '\t';
  return ',';
}

export function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headerIdx = lines.findIndex(line => {
    const first = parseCSVLine(line)[0]?.toLowerCase() || '';
    return first === 'date' || first.includes('date');
  });
  const start = headerIdx >= 0 ? headerIdx : 0;
  const delimiter = detectDelimiter(lines[start]);
  const headers = parseCSVLine(lines[start], delimiter)
    .map(h => h.trim())
    .filter(Boolean);

  if (!headers.length) return [];

  return lines.slice(start + 1).map(line => {
    const values = parseCSVLine(line, delimiter);
    if (!values.some(v => v.trim())) return null;
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  }).filter(Boolean);
}

export function toCSV(rows, headers) {
  const escape = v => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  rows.forEach(row => lines.push(headers.map(h => escape(row[h])).join(',')));
  return lines.join('\n');
}

export function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const digest = await sha256Hex(`${saltHex}:${password}`);
  return `s1:${saltHex}:${digest}`;
}

export async function passwordMatches(password, stored) {
  const raw = String(stored || '');
  if (raw.startsWith('s1:')) {
    const parts = raw.split(':');
    const saltHex = parts[1];
    const digest = parts[2];
    if (!saltHex || !digest) return false;
    return (await sha256Hex(`${saltHex}:${password}`)) === digest;
  }
  return (await sha256Hex(password)) === raw;
}

const DOM_PROPS = new Set(['checked', 'disabled', 'selected', 'readOnly', 'multiple', 'value', 'hidden']);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
    else if (k === 'innerHTML') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (DOM_PROPS.has(k)) node[k] = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  children.flat().forEach(child => {
    if (child == null) return;
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  });
  return node;
}

export function emptyState(icon, title, desc, action = null) {
  return el('div', { className: 'empty-state', role: 'status' },
    el('div', { className: 'empty-icon', 'aria-hidden': 'true' }, icon),
    el('h3', {}, title),
    el('p', {}, desc),
    action ? el('button', { type: 'button', className: 'btn btn-primary', onClick: action.onClick }, action.label) : null,
  );
}
let _fieldSeq = 0;
/** Label wired to its control in markup (for/id). Gives the control an id if it has none. */
export function labelFor(text, control, attrs = {}) {
  if (control && !control.id) control.id = `fp-f-${++_fieldSeq}`;
  return el('label', { ...attrs, for: control?.id || '' }, text);
}

/**
 * Inline field validation (sheets): message under the field, aria-invalid,
 * aria-describedby, focus. Clears itself on the next input/change.
 */
export function showFieldError(control, message, { anchor = null } = {}) {
  if (!control) return;
  clearFieldError(control);
  const host = anchor || control.closest('.input-affix') || control;
  const id = `${control.id || `fp-err-${++_fieldSeq}`}-error`;
  const msg = el('p', { className: 'form-error field-error', id, role: 'alert' }, message);
  host.insertAdjacentElement('afterend', msg);
  control._fpError = msg;
  control.setAttribute('aria-invalid', 'true');
  control.closest('.input-affix')?.classList.add('is-invalid');
  const prev = (control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  control.setAttribute('aria-describedby', [...prev.filter(x => x !== id), id].join(' '));
  const clear = () => clearFieldError(control);
  control.addEventListener('input', clear, { once: true });
  control.addEventListener('change', clear, { once: true });
  try { control.focus({ preventScroll: false }); } catch { control.focus?.(); }
  msg.scrollIntoView?.({ block: 'nearest' });
}

export function clearFieldError(control) {
  const msg = control?._fpError;
  if (!msg) return;
  msg.remove();
  control._fpError = null;
  control.removeAttribute('aria-invalid');
  control.closest('.input-affix')?.classList.remove('is-invalid');
  const rest = (control.getAttribute('aria-describedby') || '').split(' ').filter(x => x && x !== msg.id);
  if (rest.length) control.setAttribute('aria-describedby', rest.join(' '));
  else control.removeAttribute('aria-describedby');
}

/** AU3: Show/Hide toggle for a password input (wraps it; type swap only). */
export function addPasswordToggle(input) {
  if (!input || input.closest('.pw-field')) return;
  const wrap = el('div', { className: 'pw-field' });
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = el('button', {
    type: 'button',
    className: 'pw-toggle',
    'aria-controls': input.id || '',
    'aria-pressed': 'false',
    'aria-label': 'Show password',
  }, 'Show');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });
  wrap.appendChild(btn);
}
