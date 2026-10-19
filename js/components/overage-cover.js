/**
 * Budget page → "Cover overage" panel.
 *
 * David's rule: bonus pot first, then a forced equal split across all envelopes (minus
 * bills) or the ones he picks. Planning and the write both go through js/envelope-overage.js
 * on the live store — the same client-side path "Cover overspend" / "Assign bonus" use
 * (store.update → localStorage + the app's own cloud sync). No server endpoint, no token.
 *
 * All names are rendered as text nodes via el(); no HTML strings are ever parsed.
 */
import { el, formatCurrency, generateId } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import { overageOptions, planOverage, planSignature, coverOverageInStore } from '../envelope-overage.js';

const money = c => formatCurrency(c / 100);
const REASON_LABEL = {
  overspent: 'overspent',
  bill: 'bill — protected',
  debt: 'debt — protected',
  pass_through: 'pass-through — protected',
};

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/** True when the button should show: something non-bill is over this month. */
export function hasCoverableOverage() {
  return overageOptions(store).overspent.length > 0;
}

export function openCoverOverage({ onDone } = {}) {
  if (!store.canWriteBudget()) {
    showToast('Covering overage stays on the main account', 'info');
    return null;
  }
  const opts = overageOptions(store);
  if (!opts.overspent.length) {
    showToast('Nothing is overspent this month', 'info');
    return null;
  }
  let mode = 'all';
  let includeSinking = true;
  const picked = new Set();
  let current = null; // {input, plan, signature}

  const fromBonus = Math.min(opts.bonusAvailable, opts.total);
  const summary = el('div', { className: 'overage-summary' },
    el('p', { className: 'tx-form-hint mt-0 mb-2' },
      `Over this month: ${opts.overspent.map(o => `${o.name} ${money(o.over)}`).join(', ')}.`),
    el('div', { className: 'overage-bonus-line' },
      el('strong', {}, 'Bonus pot covers '),
      el('strong', { className: fromBonus > 0 ? 'positive' : '' }, money(fromBonus)),
      el('span', {}, ` of ${money(opts.total)}`
        + (opts.bonusAvailable > 0 ? ` (${money(opts.bonusAvailable)} free)` : ' (no free bonus)')),
    ),
    el('p', { className: 'tx-form-hint mt-1 mb-0' },
      opts.total - fromBonus > 0
        ? `${money(opts.total - fromBonus)} will be split equally across the envelopes below. Bills and debts are never touched.`
        : 'Bonus covers all of it — no envelope is debited.'),
  );

  // --- target picker ---
  const radioName = `overage-mode-${Math.random().toString(36).slice(2, 8)}`;
  const modeAll = el('input', { type: 'radio', name: radioName, value: 'all', checked: true, onChange: () => { mode = 'all'; paint(); } });
  const modePick = el('input', { type: 'radio', name: radioName, value: 'selected', onChange: () => { mode = 'selected'; paint(); } });
  const sinkBox = el('input', { type: 'checkbox', checked: true, onChange: e => { includeSinking = !!e.target.checked; paint(); } });
  const checklist = el('div', { className: 'overage-target-list', role: 'group', 'aria-label': 'Envelopes to split across' });
  const boxes = new Map();
  for (const c of opts.candidates) {
    const why = c.reason ? REASON_LABEL[c.reason] || c.reason : null;
    const box = el('input', {
      type: 'checkbox',
      value: c.id,
      disabled: !c.eligible,
      'aria-label': c.name,
      onChange: e => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); paint(); },
    });
    boxes.set(c.id, { box, c });
    checklist.appendChild(el('label', { className: `overage-target${c.eligible ? '' : ' is-disabled'}` },
      box,
      el('span', { className: 'overage-target-name' }, c.name),
      el('span', { className: 'overage-target-meta' },
        why || `${money(c.remaining)} left${c.isSinking ? ' · sinking' : ''}`),
    ));
  }
  const picker = el('fieldset', { className: 'overage-picker' },
    el('legend', { className: 'form-option-label' }, 'Split across'),
    el('label', { className: 'form-option overage-mode' }, modeAll, el('span', {}, 'All envelopes (minus bills)')),
    el('label', { className: 'form-option overage-mode' }, modePick, el('span', {}, 'Pick envelopes')),
    el('label', { className: 'form-option overage-mode' }, sinkBox, el('span', {}, 'Include sinking funds')),
    checklist,
  );

  const preview = el('div', { className: 'overage-preview', 'aria-live': 'polite' });
  const confirmBtn = el('button', { type: 'button', className: 'btn btn-primary', onClick: () => confirm() }, 'Confirm');

  function input() {
    const targets = mode === 'all'
      ? 'all'
      : opts.candidates.filter(c => picked.has(c.id)).map(c => c.name);
    return { targets, envelopes: null, includeSinking, negativeRule: 'cascade', note: '' };
  }

  function paint() {
    // checklist state
    checklist.hidden = mode !== 'selected';
    for (const { box, c } of boxes.values()) {
      const off = !c.eligible || (c.isSinking && !includeSinking);
      box.disabled = off;
      if (off && picked.has(c.id)) { picked.delete(c.id); box.checked = false; }
    }
    clear(preview);
    current = null;
    confirmBtn.disabled = true;
    const inp = input();
    if (mode === 'selected' && !inp.targets.length && opts.total - fromBonus > 0) {
      preview.appendChild(el('p', { className: 'tx-form-hint m-0' }, 'Pick at least one envelope to split across.'));
      return;
    }
    const plan = planOverage(store, inp);
    if (!plan.ok) {
      const msg = plan.code === 'no_targets'
        ? 'No eligible envelope to split across. Pick one, or turn sinking funds on.'
        : plan.code === 'no_overage' ? 'Nothing is overspent any more.' : (plan.message || 'Cannot plan this cover.');
      preview.appendChild(el('p', { className: 'tx-form-hint m-0 text-negative' }, msg));
      return;
    }
    current = { input: inp, plan, signature: planSignature(plan) };
    const list = el('div', { className: 'envelope-move-list' });
    if (plan.fromBonus > 0) {
      list.appendChild(el('div', { className: 'envelope-move-row' },
        el('div', { className: 'envelope-move-row-main' }, el('strong', {}, 'Bonus pot'), el('span', {}, ` −${money(plan.fromBonus)}`)),
        el('span', { className: 'overage-after' }, `${money(plan.bonusBefore - plan.fromBonus)} left`)));
    }
    for (const r of plan.debitRows.filter(d => d.debit > 0)) {
      list.appendChild(el('div', { className: `envelope-move-row${r.went_negative ? ' overage-row-negative' : ''}` },
        el('div', { className: 'envelope-move-row-main' },
          el('strong', {}, r.envelope),
          el('span', {}, ` −${money(r.debit)}`),
          r.went_negative ? el('span', { className: 'overage-flag text-negative' }, ' · goes below $0') : null),
        el('span', { className: `overage-after${r.remaining_after < 0 ? ' text-negative' : ''}` },
          `${money(r.remaining_before)} → ${money(r.remaining_after)}`)));
    }
    if (!list.children.length) list.appendChild(el('p', { className: 'tx-form-hint m-0' }, 'No envelope is debited.'));
    preview.appendChild(el('h4', { className: 'overage-preview-title' }, 'Preview'));
    preview.appendChild(list);
    for (const o of plan.overs) {
      preview.appendChild(el('p', { className: 'tx-form-hint mx-0 mt-2 mb-0' },
        `${o.name}: ${money(-o.over)} → $0.00 (bonus ${money(o.fromBonus)}, split ${money(o.over - o.fromBonus)})`));
    }
    const zeroTargets = plan.debitRows.filter(d => d.debit === 0).length;
    if (zeroTargets && plan.rest > 0) {
      preview.appendChild(el('p', { className: 'tx-form-hint mx-0 mt-2 mb-0' },
        `${zeroTargets} envelope${zeroTargets === 1 ? '' : 's'} with nothing left ${zeroTargets === 1 ? 'is' : 'are'} not pushed below $0; their share moves to the others.`));
    }
    for (const w of plan.warnings) preview.appendChild(el('p', { className: 'tx-form-hint mx-0 mt-2 mb-0 text-negative', role: 'alert' }, w));
    preview.appendChild(el('p', { className: 'tx-form-hint mx-0 mt-2 mb-0' },
      'This month only — next month’s plan and checking do not change. Each move has Undo, and “Repay from bonus” can refill these envelopes when bonus lands.'));
    confirmBtn.disabled = false;
  }

  function confirm() {
    if (!current) return;
    const res = coverOverageInStore(store, current.input, {
      signature: current.signature,
      newId: generateId,
      batchId: `ovr_${generateId().replace(/-/g, '').slice(0, 16)}`,
    });
    if (!res.ok) {
      showToast(res.code === 'stale_state' ? 'Budget changed — preview updated, check it and confirm again' : 'Could not cover the overage', 'info');
      paint();
      return;
    }
    const p = res.plan;
    showToast(`Covered ${money(p.total)}`
      + (p.fromBonus > 0 ? ` · ${money(p.fromBonus)} from bonus` : '')
      + (p.rest > 0 ? ` · ${money(p.rest)} split across ${p.debitRows.filter(d => d.debit > 0).length}` : ''), 'success');
    modal.close();
    onDone?.(res);
    window.appRefresh?.();
  }

  paint();
  const modal = showModal({
    title: 'Cover overage',
    body: el('div', { className: 'overage-cover' }, summary, picker, preview),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Cancel'),
      confirmBtn,
    ],
  });
  modal.modal.classList.add('modal-scrollable');
  return modal;
}
