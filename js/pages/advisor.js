import { el, formatCurrency } from '../utils.js';
import { buildAdvisorSnapshot } from '../advisor/context.js';
import {
  ADVISOR_CHIPS,
  answerChip,
  runAdvisorAction,
  pickDefaultChip,
  saveAnswerToNotes,
} from '../advisor/engine.js';
import { showToast } from '../components/modal.js';

/** User-picked chip; null = use smart default for this visit. */
let stickyChipId = null;
let affordAmount = '';
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
  if (stickyChipId && !validChipIds.has(stickyChipId)) stickyChipId = null;
  const activeChipId = stickyChipId || pickDefaultChip(snap);
  // Always recompute against latest store so surplus/inbox stay live
  lastAnswer = {
    ...answerChip(activeChipId, { amount: parseAmount(affordAmount), snapshot: snap }),
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

  // Question chips (dining label follows alias / match)
  const diningName = snap.named.dining?.name || 'dining';
  const chips = ADVISOR_CHIPS.map(chip => {
    if (chip.id === 'cut_dining') {
      return { ...chip, label: `What if we cut ${diningName} 20%?` };
    }
    return chip;
  });

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Ask the household coach'),
    el('div', { className: 'chip-bar advisor-chip-bar' },
      ...chips.map(chip =>
        el('button', {
          type: 'button',
          className: `chip${activeChipId === chip.id ? ' active' : ''}`,
          onClick: () => {
            stickyChipId = chip.id;
            const s = buildAdvisorSnapshot();
            lastAnswer = {
              ...answerChip(chip.id, { amount: parseAmount(affordAmount), snapshot: s }),
              _month: s.month,
            };
            renderAdvisor(container);
          },
        }, chip.label)
      ),
    ),
  ));

  // Afford amount
  container.appendChild(el('div', { className: 'card section advisor-afford-bar' },
    el('label', { className: 'advisor-afford-label', for: 'advisor-afford-amt' }, 'Affordability amount'),
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
        onClick: () => {
          stickyChipId = 'afford';
          const s = buildAdvisorSnapshot();
          lastAnswer = {
            ...answerChip('afford', { amount: parseAmount(affordAmount), snapshot: s }),
            _month: s.month,
          };
          renderAdvisor(container);
        },
      }, 'Can we afford this?'),
    ),
    el('p', { className: 'tx-form-hint' }, 'Checks surplus, discretionary envelope room, and Vacation-style sinking funds.'),
  ));

  // Answer card
  const answer = lastAnswer || answerChip(activeChipId, { amount: parseAmount(affordAmount), snapshot: snap });
  container.appendChild(renderAnswerCard(answer));

  // Footnote
  container.appendChild(el('p', { className: 'tx-form-hint section advisor-footnote' },
    `Snapshot ${snap.asOf} · ${snap.envelopes.length} envelopes · ${snap.debts.length} active debt(s) · local only`,
  ));
}

function defaultChipHint(chipId) {
  switch (chipId) {
    case 'payday':
      return 'Paycheck is within a few days — payday brief first.';
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
      ? el('div', { className: 'grid grid-3 advisor-answer-metrics' },
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
