/**
 * Fit money values in small stat tiles onto one line (display only).
 *
 * Shrinks the font of each tile value until it fits, down to MIN_PX. If it
 * still can't fit, shows a compact amount ($11.9K) with the full value kept
 * for screen readers and as a tooltip. Never touches stored data or math.
 */
import { formatCurrencyCompact } from './utils.js';

const MIN_PX = 15;

/** Small stat tiles / summary grids across the app. */
export const FIT_SELECTOR = [
  '.dash-stats .card-value',
  '.budget-summary .card-value',
  '.debt-summary .card-value',
  '.report-summary .card-value',
  '.bills-summary .card-value',
  '.grid .card > .card-value',
  '.envelope-stat > span:not(.envelope-stat__label):not(.envelope-tx-hint)',
].join(', ');

const MONEY_RE = /^\s*([−-]\u2060?)?\$([\d,]+(?:\.\d+)?)\s*$/;

function parseMoney(text) {
  const m = MONEY_RE.exec(text || '');
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[1] ? -n : n;
}

function restore(el) {
  if (el.dataset.fitFull == null) return;
  if (el.querySelector(':scope > .fit-compact')) el.textContent = el.dataset.fitFull;
  delete el.dataset.fitFull;
  el.removeAttribute('title');
}

function overflows(el) {
  return el.scrollWidth > el.clientWidth + 0.5;
}

function fitOne(el) {
  if (!el.isConnected) return;
  restore(el);
  el.style.removeProperty('font-size');
  const avail = el.clientWidth;
  if (!avail || !overflows(el)) return;

  const base = parseFloat(getComputedStyle(el).fontSize) || 16;
  // Proportional first guess, then step down in half pixels
  let size = Math.max(MIN_PX, Math.floor((base * avail / el.scrollWidth) * 2) / 2);
  el.style.fontSize = `${size}px`;
  while (overflows(el) && size > MIN_PX) {
    size = Math.max(MIN_PX, size - 0.5);
    el.style.fontSize = `${size}px`;
  }
  if (!overflows(el)) return;

  // Still too wide at the minimum: compact, with the full value for AT / hover
  const full = el.textContent;
  const n = parseMoney(full);
  if (n == null || el.children.length) return;
  const compact = formatCurrencyCompact(n);
  if (compact === full) return;
  el.dataset.fitFull = full;
  el.title = full;
  el.textContent = '';
  const vis = document.createElement('span');
  vis.className = 'fit-compact';
  vis.setAttribute('aria-hidden', 'true');
  vis.textContent = compact;
  const sr = document.createElement('span');
  sr.className = 'sr-only';
  sr.textContent = full;
  el.append(vis, sr);
}

let observer = null;
let frame = 0;

export function fitValues(root = document) {
  if (observer) observer.disconnect();
  try {
    root.querySelectorAll(FIT_SELECTOR).forEach(fitOne);
  } finally {
    if (observer) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; fitValues(); });
}

export function installValueFit() {
  if (observer || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  document.fonts?.ready?.then(schedule).catch(() => {});
  // Large-text / theme switches change sizes without DOM mutations
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-large-text', 'data-theme', 'class', 'style'] });
  schedule();
}
