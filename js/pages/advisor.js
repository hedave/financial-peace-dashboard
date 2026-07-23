import { el, formatCurrency } from '../utils.js';
import { store } from '../store.js';
import { buildAdvisorSnapshot } from '../advisor/context.js';
import {
  ADVISOR_CHIPS,
  ADVISOR_CHIP_GROUPS,
  answerChip,
  runAdvisorAction,
  pickDefaultChip,
  saveAnswerToNotes,
} from '../advisor/engine.js';
import { showToast } from '../components/modal.js';

/** User-picked chip; null = use smart default for this visit. */
let stickyChipId = null;
let affordAmount = '';
/** Flexible “cut X by Y%” controls */
let cutEnvelopeId = '';
let cutPct = '20';
let lastAnswer = null;

/** Call when navigating into Advisor so the default chip can re-evaluate. */
export function prepareAdvisorVisit() {
  stickyChipId = null;
}

// Allow engine actions to switch chips without leaving the page
if (typeof window !== 'undefined' && !window.__advisorChipListener) {
  window.__advisorChipListener = true;
  window.addEventListener('advisor-set-chip', (e) => {
    const id = e.detail?.chipId;
    if (!id) return;
    stickyChipId = id;
    if (typeof window.appRefresh === 'function') window.appRefresh();
  });
}

export function renderAdvisor(container) {
  const snap = buildAdvisorSnapshot();
  // Drop removed chips (e.g. old "attention" sticky from a prior visit)
  const validChipIds = new Set(ADVISOR_CHIPS.map(c => c.id));
  // Migrate old sticky chip id
  if (stickyChipId === 'cut_dining') stickyChipId = 'cut_envelope';
  if (stickyChipId && !validChipIds.has(stickyChipId)) stickyChipId = null;
  const activeChipId = stickyChipId || pickDefaultChip(snap);

  // Default cut target: dining alias, else sticky, else largest discretionary
  if (!cutEnvelopeId) {
    cutEnvelopeId = snap.named?.dining?.id
      || snap.envelopes?.filter(e => !e.isSinkingFund)
        .sort((a, b) => Math.max(b.budgeted, b.spent) - Math.max(a.budgeted, a.spent))[0]?.id
      || '';
  }

  // Always recompute against latest store so surplus/inbox stay live
  lastAnswer = {
    ...answerChip(activeChipId, {
      amount: parseAmount(affordAmount),
      cutPct: Number(cutPct) || 20,
      envelopeId: cutEnvelopeId || null,
      snapshot: snap,
    }),
    _month: snap.month,
  };

  container.innerHTML = '';

  const defaultHint = stickyChipId
    ? null
    : defaultChipHint(activeChipId);

  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Advisor'),
    el('p', {}, `${snap.monthLabel} · Local coach · your numbers only`),
    defaultHint
      ? el('p', { className: 'advisor-default-hint' }, defaultHint)
      : null,
  ));

  // Snapshot strip
  container.appendChild(el('div', { className: 'grid grid-4 section advisor-metrics' },
    metricCard('Baby Step', String(snap.mode.babyStep), snap.mode.babyStepTitle, 'accent'),
    metricCard('To Allocate', formatCurrency(snap.cashflow.toAllocate),
      Math.abs(snap.cashflow.toAllocate) < 0.01 ? 'Every dollar has a job' : 'Give leftover a job',
      Math.abs(snap.cashflow.toAllocate) < 0.01 ? 'positive' : 'warning'),
    metricCard('Snowball surplus', formatCurrency(snap.cashflow.surplus),
      snap.snowballTarget ? `→ ${snap.snowballTarget.name}` : 'No active debt target',
      snap.cashflow.surplus > 0 ? 'positive' : ''),
    metricCard('Attention', String(snap.attention.length),
      snap.inbox.totalCount ? `${snap.inbox.totalCount} inbox item(s)` : 'Queues look clear',
      snap.attention.length ? 'warning' : 'positive'),
  ));

  // Priority list (single source of truth for "what to do next")
  container.appendChild(el('div', { className: 'section', id: 'advisor-priority' },
    el('div', { className: 'section-title' }, 'Do these next'),
    snap.attention.length
      ? el('div', { className: 'card advisor-priority-list' },
          ...snap.attention.slice(0, 6).map((item, idx) =>
            el('div', { className: 'advisor-priority-row' },
              el('span', { className: 'advisor-priority-num' }, String(idx + 1)),
              el('span', { className: 'advisor-priority-label' }, item.label),
              el('button', {
                type: 'button',
                className: item.id === 'leftover' || item.action === 'allocate-surplus'
                  ? 'btn btn-sm btn-primary'
                  : 'btn btn-sm btn-secondary',
                onClick: () => runAdvisorAction({
                  page: item.page,
                  action: item.action,
                  targetName: item.targetName,
                }),
              }, item.buttonLabel || 'Go'),
            )
          ),
        )
      : el('div', { className: 'card' },
          el('p', { className: 'tx-form-hint' }, 'Nothing urgent — budgets and inbox look steady. Tap a question below anytime.'),
        ),
  ));

  // Question chips — grouped for scanability
  const cutEnvName = snap.envelopes?.find(e => e.id === cutEnvelopeId)?.name
    || snap.named?.dining?.name
    || 'envelope';

  function selectChip(chipId) {
    stickyChipId = chipId;
    const s = buildAdvisorSnapshot();
    lastAnswer = {
      ...answerChip(chipId, {
        amount: parseAmount(affordAmount),
        cutPct: Number(cutPct) || 20,
        envelopeId: cutEnvelopeId || null,
        snapshot: s,
      }),
      _month: s.month,
    };
    renderAdvisor(container);
  }

  const chipSection = el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Ask the household coach'),
  );
  ADVISOR_CHIP_GROUPS.forEach(group => {
    chipSection.appendChild(el('div', { className: 'advisor-chip-group' },
      el('div', { className: 'advisor-chip-group-label' }, group.label),
      el('div', { className: 'chip-bar advisor-chip-bar' },
        ...group.chips.map(chip => {
          let label = chip.label;
          if (chip.id === 'cut_envelope') {
            label = `Cut ${cutEnvName} ${cutPct || 20}%`;
          }
          return el('button', {
            type: 'button',
            className: `chip${activeChipId === chip.id ? ' active' : ''}`,
            onClick: () => selectChip(chip.id),
          }, label);
        }),
      ),
    ));
  });
  container.appendChild(chipSection);

  // Cut / afford tools — expand when those questions are active
  const toolsOpen = activeChipId === 'cut_envelope' || activeChipId === 'afford';
  const cutSelect = el('select', {
    id: 'advisor-cut-env',
    className: 'form-input advisor-cut-select',
    onChange: (e) => { cutEnvelopeId = e.target.value; },
  },
    el('option', { value: '' }, '— Choose envelope —'),
    ...(snap.envelopes || [])
      .filter(e => !e.isSinkingFund)
      .map(e => el('option', { value: e.id }, `${e.icon || '✉️'} ${e.name}`)),
    ...(snap.envelopes || [])
      .filter(e => e.isSinkingFund)
      .map(e => el('option', { value: e.id }, `${e.icon || '🎯'} ${e.name} (sinking)`)),
  );
  if (cutEnvelopeId) cutSelect.value = cutEnvelopeId;

  const toolsInner = el('div', { className: 'advisor-tools-inner' },
    el('div', { className: 'card advisor-cut-bar', style: 'margin-bottom:0.75rem' },
      el('label', { className: 'advisor-afford-label' }, 'Cut envelope by %'),
      el('div', { className: 'advisor-cut-row' },
        cutSelect,
        el('div', { className: 'advisor-cut-pct-wrap' },
          el('input', {
            id: 'advisor-cut-pct',
            type: 'number',
            min: '1',
            max: '100',
            step: '1',
            value: cutPct,
            className: 'form-input advisor-cut-pct',
            onInput: (e) => { cutPct = e.target.value; },
          }),
          el('span', { className: 'advisor-cut-pct-suffix' }, '%'),
        ),
        el('button', {
          type: 'button',
          className: 'btn btn-primary',
          onClick: () => {
            cutEnvelopeId = cutSelect.value || cutEnvelopeId;
            selectChip('cut_envelope');
          },
        }, 'Model cut'),
      ),
      el('p', { className: 'tx-form-hint' },
        'Family of 7: groceries, kids activities, dining, gas…',
      ),
    ),
    el('div', { className: 'card advisor-afford-bar' },
      el('label', { className: 'advisor-afford-label', for: 'advisor-afford-amt' }, 'Affordability ($)'),
      el('div', { className: 'advisor-afford-row' },
        el('span', { className: 'advisor-afford-prefix' }, '$'),
        el('input', {
          id: 'advisor-afford-amt',
          type: 'number',
          min: '0',
          step: '1',
          inputMode: 'decimal',
          placeholder: '400',
          value: affordAmount,
          className: 'form-input advisor-afford-input',
          onInput: (e) => { affordAmount = e.target.value; },
        }),
        el('button', {
          type: 'button',
          className: 'btn btn-primary',
          onClick: () => selectChip('afford'),
        }, 'Can we afford this?'),
      ),
      el('p', { className: 'tx-form-hint' },
        'Trips, sports, multi-kid costs — checks surplus and sinking funds.',
      ),
    ),
  );

  container.appendChild(el('details', {
    className: 'section advisor-tools-details',
    open: toolsOpen || undefined,
  },
    el('summary', { className: 'advisor-tools-summary' }, 'Tools: cut % · afford $'),
    toolsInner,
  ));

  // Answer card
  const answer = lastAnswer || answerChip(activeChipId, {
    amount: parseAmount(affordAmount),
    cutPct: Number(cutPct) || 20,
    envelopeId: cutEnvelopeId || null,
    snapshot: snap,
  });
  container.appendChild(renderAnswerCard(answer));

  // Footnote
  const familyN = store.getState().settings?.familySize || 7;
  container.appendChild(el('p', { className: 'tx-form-hint section advisor-footnote' },
    `Snapshot ${snap.asOf} · household of ${familyN} · ${snap.envelopes.length} envelopes · ${snap.debts.length} active debt(s) · local only`,
  ));
}

function defaultChipHint(chipId) {
  switch (chipId) {
    case 'payday':
      return 'Paycheck is within a few days — payday brief first.';
    case 'after_snowball':
      return 'See checking after snowball extra, bills, and next deposit.';
    case 'month_close':
      return 'Late in the month with open checklist items — month-close first.';
    case 'surplus_split':
      return 'Surplus is free — split plan by Baby Step first.';
    case 'snowball':
      return 'Surplus is free and debt is active — snowball plan first.';
    default:
      return null;
  }
}

function renderAnswerCard(answer) {
  return el('div', { className: 'card section advisor-answer' },
    el('div', { className: 'advisor-answer-header' },
      el('h3', {}, answer.title || 'Answer'),
    ),
    answer.metrics?.length
      ? el('div', {
          className: `grid advisor-answer-metrics ${
            answer.metrics.length >= 4 ? 'grid-4' : answer.metrics.length === 2 ? 'grid-2' : 'grid-3'
          }`,
        },
          ...answer.metrics.map(m =>
            el('div', { className: 'advisor-mini-metric' },
              el('div', { className: 'card-title' }, m.label),
              el('div', { className: `card-value${m.tone ? ` ${toneClass(m.tone)}` : ''}` }, m.value),
            )
          ),
        )
      : null,
    ...(answer.paragraphs || []).map(p => el('p', { className: 'advisor-answer-p' }, p)),
    answer.bullets?.length
      ? el('ul', { className: 'advisor-bullet-list' },
          ...answer.bullets.map(b => el('li', {}, b)),
        )
      : null,
    el('div', { className: 'btn-group advisor-answer-actions' },
      ...(answer.actions || []).map(a =>
        el('button', {
          type: 'button',
          className: a.action === 'month-close' || a.action === 'allocate-surplus'
            ? 'btn btn-primary btn-sm'
            : 'btn btn-secondary btn-sm',
          onClick: () => runAdvisorAction(a),
        }, a.label)
      ),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary btn-sm',
        title: 'Save this plan as a sticky note',
        onClick: () => {
          saveAnswerToNotes(answer);
          showToast('Saved to Notes → Advisor plans', 'success');
        },
      }, 'Save to Notes'),
    ),
  );
}

function metricCard(label, value, hint, tone) {
  return el('div', { className: 'card' },
    el('div', { className: 'card-title' }, label),
    el('div', { className: `card-value${tone ? ` ${toneClass(tone)}` : ''}` }, value),
    hint ? el('p', { className: 'tx-form-hint' }, hint) : null,
  );
}

function toneClass(tone) {
  if (tone === 'positive') return 'positive';
  if (tone === 'negative') return 'negative';
  if (tone === 'accent') return 'accent';
  if (tone === 'warning') return 'negative';
  return '';
}

function parseAmount(raw) {
  const n = parseFloat(String(raw || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
