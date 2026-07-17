import { el } from '../utils.js';

let toastContainer = null;
let openModalCount = 0;
let stackRefreshTimer = null;

/** How many modals are currently open (for page-render guards). */
export function getOpenModalCount() {
  return document.querySelectorAll('.modal-backdrop').length;
}

export function isModalOpen() {
  return getOpenModalCount() > 0;
}

function lockBodyScroll() {
  if (document.body.classList.contains('modal-open')) return;
  document.body.dataset.scrollY = String(window.scrollY || 0);
  document.body.classList.add('modal-open');
}

function unlockBodyScroll() {
  if (getOpenModalCount() > 0) return;
  document.body.classList.remove('modal-open');
  const y = Number(document.body.dataset.scrollY || 0);
  delete document.body.dataset.scrollY;
  if (y) window.scrollTo(0, y);
}

function syncModalCountFromDom() {
  openModalCount = getOpenModalCount();
  if (openModalCount > 0) lockBodyScroll();
  else unlockBodyScroll();
  return openModalCount;
}

/**
 * Soft UI refresh while a modal is open (badges only).
 * Full page re-render shortly after the last modal closes
 * (deferred so hub → queue handoff doesn't flash a full re-render).
 */
function afterModalStackChange() {
  const n = syncModalCountFromDom();
  if (n > 0) {
    window.appSoftRefresh?.();
    return;
  }
  if (stackRefreshTimer) clearTimeout(stackRefreshTimer);
  stackRefreshTimer = setTimeout(() => {
    stackRefreshTimer = null;
    if (getOpenModalCount() === 0) {
      unlockBodyScroll();
      window.appRefresh?.({ force: true });
    }
  }, 60);
}

export function showModal({ title, body, footer, onClose }) {
  const backdrop = el('div', { className: 'modal-backdrop' });
  const modal = el('div', { className: 'modal', role: 'dialog', 'aria-modal': 'true' });

  const z = 200 + getOpenModalCount() * 20;
  backdrop.style.zIndex = String(z);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Block ghost click-through to the sheet underneath (common on mobile)
    backdrop.style.pointerEvents = 'none';
    backdrop.remove();
    onClose?.();
    afterModalStackChange();
  };

  // Backdrop dismiss: require down+up on the backdrop itself
  let dismissArmed = false;
  backdrop.addEventListener('pointerdown', e => {
    dismissArmed = e.target === backdrop;
  });
  backdrop.addEventListener('pointerup', e => {
    if (dismissArmed && e.target === backdrop) close();
    dismissArmed = false;
  });
  backdrop.addEventListener('pointercancel', () => { dismissArmed = false; });

  const header = el('div', { className: 'modal-header' },
    el('h3', {}, title),
    el('button', {
      type: 'button',
      className: 'close-btn',
      'aria-label': 'Close',
      onClick: close,
    }, '×')
  );

  const bodyEl = el('div', { className: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  modal.appendChild(header);
  modal.appendChild(bodyEl);

  if (footer) {
    const footerEl = el('div', { className: 'modal-footer' });
    if (Array.isArray(footer)) footer.forEach(f => { if (f) footerEl.appendChild(f); });
    else footerEl.appendChild(footer);
    modal.appendChild(footerEl);
  }

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  syncModalCountFromDom();
  lockBodyScroll();

  // Focus first useful control without scrolling the page behind
  requestAnimationFrame(() => {
    const focusable = modal.querySelector('input, select, textarea, button:not(.close-btn)');
    if (focusable && typeof focusable.focus === 'function') {
      try { focusable.focus({ preventScroll: true }); } catch { focusable.focus(); }
    }
  });

  return {
    close,
    backdrop,
    modal,
    setTitle(next) {
      const h = header.querySelector('h3');
      if (h) h.textContent = next;
    },
  };
}

export function showToast(message, type = 'info', duration = 3500) {
  if (!toastContainer) {
    toastContainer = el('div', { className: 'toast-container' });
    document.body.appendChild(toastContainer);
  }
  const toast = el('div', { className: `toast ${type}` }, message);
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

export function confirmDialog(title, message, onConfirm) {
  const modal = showModal({
    title,
    body: el('p', {}, message),
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Cancel'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          modal.close();
          // After this sheet is gone so parent review modal can re-paint cleanly
          queueMicrotask(() => onConfirm?.());
        },
      }, 'Confirm'),
    ],
  });
  return modal;
}
