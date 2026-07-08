export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = Math.random() * 16 | 0;
    return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function formatCurrency(amount) {
  const n = Number(amount) || 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
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
  const days = [];
  const add = (day) => {
    if (!day || day < 1 || day > 31) return;
    const d = new Date(y, m - 1, Math.min(day, new Date(y, m, 0).getDate()));
    days.push(d.toISOString().slice(0, 10));
  };
  add(day1);
  if (day2) add(day2);
  return days;
}

export function isInMonth(dateStr, monthKey) {
  return dateStr && dateStr.startsWith(monthKey);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
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

export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const DOM_PROPS = new Set(['checked', 'disabled', 'selected', 'readOnly', 'multiple', 'value']);

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

export function emptyState(icon, title, desc) {
  return el('div', { className: 'empty-state' },
    el('div', { className: 'empty-icon' }, icon),
    el('h3', {}, title),
    el('p', {}, desc)
  );
}