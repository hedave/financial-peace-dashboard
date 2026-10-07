/**
 * Presentation/accessibility pass over rendered forms. Never changes values.
 * - Associates sibling <label>s with their field (id + htmlFor).
 * - Money/number fields: decimal keypad, $ / % affix inside .form-group,
 *   and a "0" default is selected on focus so typing replaces it.
 */
let seq = 0;
const CONTROL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea';

function fieldFor(label) {
  if (label.htmlFor || label.querySelector('input, select, textarea')) return null;
  let n = label.nextElementSibling;
  while (n && !n.matches(CONTROL) && !n.querySelector?.(CONTROL) && n.tagName !== 'LABEL') n = n.nextElementSibling;
  if (!n || n.tagName === 'LABEL') return null;
  return n.matches(CONTROL) ? n : n.querySelector(CONTROL);
}

function enhanceLabel(label) {
  const f = fieldFor(label);
  if (!f) return;
  if (!f.id) f.id = `fp-field-${++seq}`;
  label.htmlFor = f.id;
}

function labelText(input) {
  const id = input.id;
  const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || input.closest('label');
  return `${lab?.textContent || ''} ${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`.toLowerCase();
}

function enhanceNumber(input) {
  if (input.dataset.fpEnh) return;
  input.dataset.fpEnh = '1';
  const step = String(input.getAttribute('step') || '');
  const decimal = step.includes('.') || step === 'any';
  input.setAttribute('inputmode', decimal ? 'decimal' : 'numeric');
  input.addEventListener('focus', () => {
    if (input.value === '0' || input.value === '0.00') { try { input.select(); } catch { /* noop */ } }
  });
  if (!decimal) return;
  const group = input.parentElement;
  if (!group || !group.classList.contains('form-group')) return;
  const text = labelText(input);
  const pct = /(%|rate|apr|percent)/.test(text);
  const wrap = document.createElement('div');
  wrap.className = `input-affix ${pct ? 'input-affix--suffix' : 'input-affix--prefix'}`;
  const sym = document.createElement('span');
  sym.className = 'input-affix__sym';
  sym.setAttribute('aria-hidden', 'true');
  sym.textContent = pct ? '%' : '$';
  group.insertBefore(wrap, input);
  wrap.appendChild(input);
  wrap.appendChild(sym);
}

export function enhanceForms(root = document.body) {
  root.querySelectorAll('label').forEach(enhanceLabel);
  root.querySelectorAll('input[type=number]').forEach(enhanceNumber);
}

let queued = false;
export function installFormEnhancer() {
  const run = () => { queued = false; enhanceForms(document.body); };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true });
  run();
}
