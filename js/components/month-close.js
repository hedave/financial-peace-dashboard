import { el, formatCurrency, getMonthLabel } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import { openReviewInbox, openBillMatches, openPendingReview } from './review-inbox.js';

export function openMonthCloseWizard() {
  const status = store.getMonthCloseStatus();
  let modal;

  const stepsEl = el('div', { className: 'month-close-steps' },
    ...status.steps.map((step, idx) => {
      let action = null;
      if (!step.done && step.id === 'review') {
        action = el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary month-close-action',
          onClick: () => { modal?.close(); openReviewInbox(); },
        }, 'Review');
      } else if (!step.done && step.id === 'bills') {
        action = el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary month-close-action',
          onClick: () => { modal?.close(); openBillMatches(); },
        }, 'Match');
      } else if (!step.done && step.id === 'allocate') {
        action = el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary month-close-action',
          onClick: () => { modal?.close(); window.appNavigate('budget', { filter: 'attention' }); },
        }, 'Budget');
      } else if (!step.done && step.id === 'caps') {
        action = el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary month-close-action',
          onClick: () => { modal?.close(); window.appNavigate('budget', { filter: 'attention' }); },
        }, 'Review');
      } else if (!step.done && step.id === 'surplus') {
        action = el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary month-close-action',
          onClick: async () => {
            modal?.close();
            const { allocateSurplus } = await import('../pages/dashboard.js');
            allocateSurplus();
          },
        }, 'Snowball');
      }

      return el('div', { className: `month-close-step${step.done ? ' done' : ''}` },
        el('div', { className: 'month-close-step-main' },
          el('span', { className: 'month-close-check' }, step.done ? '✓' : String(idx + 1)),
          el('div', { className: 'month-close-step-text' },
            el('strong', {}, step.label),
            !step.done && step.count != null && typeof step.count === 'number' && step.id !== 'allocate'
              ? el('span', { className: 'month-close-count' }, `(${step.count})`)
              : null,
            !step.done && step.id === 'allocate'
              ? el('span', { className: 'month-close-count accent' }, formatCurrency(step.count))
              : null,
          ),
        ),
        action,
      );
    }),
  );

  const pendingN = store.getPendingTransactions().length;
  if (pendingN > 0) {
    stepsEl.appendChild(el('div', { className: 'month-close-step' },
      el('div', { className: 'month-close-step-main' },
        el('span', { className: 'month-close-check' }, '⏳'),
        el('div', { className: 'month-close-step-text' },
          el('strong', {}, 'Pending bank logs'),
          el('span', { className: 'month-close-count' }, `(${pendingN})`),
        ),
      ),
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary month-close-action',
        onClick: () => { modal?.close(); openPendingReview(); },
      }, 'Review'),
    ));
  }

  modal = showModal({
    title: `Close ${getMonthLabel(status.month)}`,
    body: el('div', {},
      status.alreadyClosed
        ? el('p', { className: 'tx-form-hint' }, 'You already closed this month. You can run through the checklist again anytime.')
        : el('p', { style: 'margin-bottom:1rem;color:var(--text-muted)' },
          'Walk through these steps before rolling into the next month.'
        ),
      stepsEl,
      el('div', { className: 'card', style: 'margin-top:1rem;padding:0.75rem 1rem' },
        el('strong', {}, 'Snapshot'),
        el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-top:0.35rem;line-height:1.5' },
          'Closing saves your envelope budgets for reports and lets you copy them next month.'
        ),
      ),
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Later'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          store.closeMonth(status.month);
          showToast(`${getMonthLabel(status.month)} closed — budget snapshot saved!`, 'success');
          modal.close();
          window.appRefresh();
        },
      }, 'Close Month'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}