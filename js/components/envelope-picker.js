/**
 * Searchable envelope picker (type-ahead combobox).
 * Type "p" → Pets; multi-letter filters by name.
 */
import { el, formatCurrency } from '../utils.js';
import { store } from '../store.js';

function remainingText(categoryId) {
  const rem = store.getCategoryRemaining(categoryId);
  if (rem < -0.005) return `${formatCurrency(Math.abs(rem))} over`;
  return `${formatCurrency(rem)} left`;
}

function optionLabel(c, showRemaining) {
  const icon = c.icon ? `${c.icon} ` : '';
  if (!showRemaining) return `${icon}${c.name}`.trim();
  return `${icon}${c.name} · ${remainingText(c.id)}`;
}

function parentCategories() {
  return [...(store.getState().categories || [])]
    .filter(c => !c.parentId)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * @param {{
 *   id?: string,
 *   value?: string,
 *   placeholder?: string,
 *   emptyLabel?: string,
 *   showRemaining?: boolean,
 *   allowEmpty?: boolean,
 * }} [opts]
 */
export function createEnvelopePicker(opts = {}) {
  const showRemaining = opts.showRemaining !== false;
  const allowEmpty = opts.allowEmpty !== false;
  const emptyLabel = opts.emptyLabel || '— Choose envelope —';
  const placeholder = opts.placeholder || 'Type to find envelope…';

  let value = opts.value || '';
  let open = false;
  let highlight = 0;
  let filter = '';
  /** Ignore blur while committing a pick (mousedown/touch). */
  let picking = false;
  /** @type {Array<{ id: string, label: string, name: string }>} */
  let visible = [];
  const changeListeners = [];

  const root = el('div', { className: 'envelope-picker' });
  // type=text: type=search has a clear (×) that wipes the selection on some browsers
  const input = el('input', {
    type: 'text',
    className: 'envelope-picker-input',
    id: opts.id || undefined,
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    role: 'combobox',
  });
  input.setAttribute('enterkeyhint', 'done');
  const list = el('div', {
    className: 'envelope-picker-list',
    role: 'listbox',
    hidden: true,
  });
  root.appendChild(input);
  root.appendChild(list);

  function catById(id) {
    if (!id) return null;
    return (store.getState().categories || []).find(c => c.id === id) || null;
  }

  function displayForValue() {
    if (!value) return '';
    const c = catById(value);
    if (!c) return '';
    // Prefer parent list for remaining labels; fall back to any cat
    return optionLabel(c, showRemaining);
  }

  function notifyChange() {
    changeListeners.forEach(fn => {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  function setValue(next, { silent = false, syncInput = true } = {}) {
    const prev = value;
    value = next || '';
    if (syncInput) {
      // Always sync the visible text when committing a value (was skipped while focused+open)
      input.value = displayForValue();
    }
    if (!silent && prev !== value) notifyChange();
  }

  function buildVisible() {
    const q = filter.trim().toLowerCase();
    let cats = parentCategories();
    if (q) {
      const starts = [];
      const contains = [];
      cats.forEach(c => {
        const name = String(c.name || '').toLowerCase();
        if (name.startsWith(q)) starts.push(c);
        else if (name.includes(q)) contains.push(c);
      });
      cats = [...starts, ...contains];
    }
    visible = [];
    if (allowEmpty && !q) {
      visible.push({ id: '', label: emptyLabel, name: '' });
    }
    cats.forEach(c => {
      visible.push({
        id: c.id,
        label: optionLabel(c, showRemaining),
        name: c.name,
      });
    });
  }

  function updateHighlightClasses() {
    list.querySelectorAll('.envelope-picker-option').forEach((node, i) => {
      node.classList.toggle('is-active', i === highlight);
    });
    const active = list.querySelector('.envelope-picker-option.is-active');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function paintList() {
    buildVisible();
    list.innerHTML = '';
    if (!visible.length) {
      list.appendChild(el('div', {
        className: 'envelope-picker-empty',
      }, filter.trim() ? `No envelopes match “${filter.trim()}”` : 'No envelopes'));
      return;
    }
    if (highlight >= visible.length) highlight = visible.length - 1;
    if (highlight < 0) highlight = 0;

    visible.forEach((item, i) => {
      const row = el('button', {
        type: 'button',
        className: `envelope-picker-option${i === highlight ? ' is-active' : ''}${item.id && item.id === value ? ' is-selected' : ''}`,
        role: 'option',
        'data-id': item.id,
        'aria-selected': item.id === value ? 'true' : 'false',
      }, item.label);
      // pointerdown covers mouse + touch; preventDefault keeps input from stealing blur before pick
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pick(item.id);
      });
      row.addEventListener('mouseenter', () => {
        if (highlight === i) return;
        highlight = i;
        // Only toggle classes — full rebuild here broke clicks (destroyed the target)
        updateHighlightClasses();
      });
      list.appendChild(row);
    });
  }

  function positionList() {
    const r = input.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const maxH = Math.min(256, Math.max(120, window.innerHeight * 0.45));
    const openUp = spaceBelow < Math.min(maxH, 180) && r.top > spaceBelow;
    list.style.position = 'fixed';
    list.style.left = `${Math.max(8, r.left)}px`;
    list.style.width = `${Math.max(r.width, 160)}px`;
    list.style.right = 'auto';
    list.style.maxHeight = `${maxH}px`;
    list.style.zIndex = '400';
    if (openUp) {
      list.style.top = 'auto';
      list.style.bottom = `${window.innerHeight - r.top + 2}px`;
    } else {
      list.style.bottom = 'auto';
      list.style.top = `${r.bottom + 2}px`;
    }
  }

  function openList() {
    const wasOpen = open;
    open = true;
    root.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    list.hidden = false;
    positionList();
    paintList();
    // Attach only while open — avoid leaking resize handlers per picker instance
    if (!wasOpen) window.addEventListener('resize', onResize);
  }

  function closeList({ commitDisplay = true } = {}) {
    open = false;
    filter = '';
    root.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    list.hidden = true;
    list.style.position = '';
    list.style.left = '';
    list.style.top = '';
    list.style.bottom = '';
    list.style.width = '';
    list.style.right = '';
    list.style.maxHeight = '';
    window.removeEventListener('resize', onResize);
    if (commitDisplay) input.value = displayForValue();
  }

  function pick(id) {
    picking = true;
    setValue(id, { silent: false, syncInput: true });
    closeList({ commitDisplay: true });
    // Ensure text stuck even if something raced
    input.value = displayForValue();
    queueMicrotask(() => {
      picking = false;
      try { input.blur(); } catch { /* ignore */ }
    });
  }

  function tryCommitTypedName() {
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    // Already showing a selected label — leave value alone
    if (value && displayForValue().toLowerCase() === q) return;
    // Don't treat a full "Name · $left" label as a search query
    if (value && q.includes('·')) return;

    const cats = parentCategories();
    const exact = cats.find(c => String(c.name).toLowerCase() === q);
    if (exact) {
      setValue(exact.id, { silent: false, syncInput: true });
      return;
    }
    const starts = cats.filter(c => String(c.name).toLowerCase().startsWith(q));
    if (starts.length === 1) {
      setValue(starts[0].id, { silent: false, syncInput: true });
    }
  }

  /** Resolve typed text → id before parent reads .value (Save/Assign click after blur). */
  function commitTyped() {
    if (!picking) tryCommitTypedName();
    return value;
  }

  function onResize() {
    if (open) positionList();
  }

  input.addEventListener('focus', () => {
    if (picking) return;
    filter = '';
    requestAnimationFrame(() => {
      try { input.select(); } catch { /* ignore */ }
    });
    buildVisible();
    highlight = Math.max(0, visible.findIndex(v => v.id === value));
    openList();
  });

  input.addEventListener('input', () => {
    filter = input.value;
    // Typing a new query clears prior selection until they pick again
    // (keeps getSplits from using a stale envelope while search text differs)
    if (value) {
      const label = displayForValue();
      if (filter !== label) {
        const prev = value;
        value = '';
        if (prev) notifyChange();
      }
    }
    highlight = 0;
    if (!open) openList();
    else {
      positionList();
      paintList();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openList();
      else {
        highlight = Math.min(visible.length - 1, highlight + 1);
        updateHighlightClasses();
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openList();
      else {
        highlight = Math.max(0, highlight - 1);
        updateHighlightClasses();
      }
      return;
    }
    if (e.key === 'Enter') {
      if (open && visible[highlight]) {
        e.preventDefault();
        pick(visible[highlight].id);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeList({ commitDisplay: true });
      return;
    }
    if (e.key === 'Tab') {
      if (open && filter.trim() && visible.length >= 1) {
        // Prefer starts-with single match, else highlighted row
        const q = filter.trim().toLowerCase();
        const starts = visible.filter(v => v.id && String(v.name).toLowerCase().startsWith(q));
        if (starts.length === 1) setValue(starts[0].id, { silent: false, syncInput: true });
        else if (visible[highlight]) setValue(visible[highlight].id, { silent: false, syncInput: true });
      }
      closeList({ commitDisplay: true });
    }
  });

  input.addEventListener('blur', () => {
    // CRITICAL: commit typed name synchronously on blur so a following button
    // click (Save / Assign / Move) reads the resolved id. A delayed-only commit
    // races the click (blur → click often < 150ms) and silently drops the envelope.
    if (!picking) tryCommitTypedName();
    setTimeout(() => {
      if (picking) return;
      if (root.contains(document.activeElement)) return;
      tryCommitTypedName();
      closeList({ commitDisplay: true });
    }, 150);
  });

  input.value = displayForValue();

  return {
    element: root,
    get value() { return value; },
    set value(v) { setValue(v, { silent: true, syncInput: true }); },
    setValue(v, silent = false) { setValue(v, { silent, syncInput: true }); },
    /** Flush typeahead text → category id (call before reading .value on Save). */
    commitTyped,
    refresh() {
      if (!open) input.value = displayForValue();
      else paintList();
    },
    focus() { input.focus(); },
    addEventListener(type, fn) {
      if (type === 'change' && typeof fn === 'function') changeListeners.push(fn);
    },
    get selectLike() {
      return {
        get value() { return value; },
        set value(v) { setValue(v, { silent: true, syncInput: true }); },
        addEventListener: (type, fn) => {
          if (type === 'change' && typeof fn === 'function') changeListeners.push(fn);
        },
        focus: () => input.focus(),
        commitTyped,
      };
    },
  };
}
