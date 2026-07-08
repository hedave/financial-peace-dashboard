import { el, formatCurrency, getMonthLabel } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import { openReviewInbox, openBillMatches } from './review-inbox.js';

export function openMonthCloseWizard() {
  const status = store.getMonthCloseStatus();

  const stepsEl = el('div', { className: 'month-close-steps' },
    ...status.steps.map(step => el('div', { className: `month-close-step${step.done ? ' done' : ''}` },
      el('span', { className: 'month-close-check' }, step.done ? '✓' : '○'),
      el('div', { className: 'month-close-step-text' },
        el('strong', {}, step.label),
        !step.done && step.count != null && typeof step.count === 'number' && step.id !== 'allocate'
          ? el('span', { style: 'color:var(--text-muted);margin-left:0.35rem' }, `(${step.count})`)
          : null,
        !step.done && step.id === 'allocate'
          ? el('span', { style: 'color:var(--accent);margin-left:0.35rem' }, formatCurrency(step.count))
          : null,
      ),
      !step.done && step.id === 'review' ? el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => openReviewInbox(),
      }, 'Review') : null,
      !step.done && step.id === 'bills' ? el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => openBillMatches(),
      }, 'Match') : null,
      !step.done && step.id === 'allocate' ? el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => { window.appNavigate('budget'); },
      }, 'Budget') : null,
      !step.done && step.id === 'surplus' ? el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => { window.appNavigate('debt'); },
      }, 'Snowball') : null,
    )),
  );

  const modal = showModal({
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