import { el } from '../utils.js';

let toastContainer = null;
let openModalCount = 0;
let stackRefreshTimer = null;
let escapeBound = false;

function bindEscapeOnce() {
  if (escapeBound) return;
  escapeBound = true;
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const backdrops = document.querySelectorAll('.modal-backdrop');
    if (!backdrops.length) return;
    const top = backdrops[backdrops.length - 1];
    const closeBtn = top.querySelector('.close-btn');
    if (closeBtn) closeBtn.click();
    else top.remove();
    // Re-sync stack after legacy remove paths
    setTimeout(() => {
      const n = document.querySelectorAll('.modal-backdrop').length;
      if (n === 0) {
        document.body.classList.remove('modal-open');
        window.appRefresh?.({ force: true });
      } else {
        window.appSoftRefresh?.();
      }
    }, 0);
  });
}

/** How many modals are currently open (for page-render guards). */
export function getOpenModalCount() {
  return document.querySelectorAll('.modal-backdrop').length;
}

export function isModalOpen() {
  return getOpenModalCount() > 0;
}

function isPhoneUi() {
  return window.matchMedia('(max-width: 768px)').matches
    || window.matchMedia('(pointer: coarse)').matches;
}

function lockBodyScroll() {
  if (document.body.classList.contains('modal-open')) return;
  const y = window.scrollY || 0;
  document.body.dataset.scrollY = String(y);
  document.body.classList.add('modal-open');
  document.body.style.top = `-${y}px`;
}

function unlockBodyScroll() {
  if (getOpenModalCount() > 0) return;
  document.body.classList.remove('modal-open');
  const y = Number(document.body.dataset.scrollY || 0);
  delete document.body.dataset.scrollY;
  document.body.style.top = '';
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

export function showModal({ title, body, footer, onClose, closeOnBackdrop = true }) {
  bindEscapeOnce();
  const backdrop = el('div', { className: 'modal-backdrop' });
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;
  const modal = el('div', {
    className: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
  });

  const z = 200 + getOpenModalCount() * 20;
  backdrop.style.zIndex = String(z);

  let closed = false;
  const onViewportChange = () => {
    const active = document.activeElement;
    if (modal.contains(active) && active.matches?.('input, select, textarea')) {
      try {
        active.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      } catch {
        active.scrollIntoView(true);
      }
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    // Block ghost click-through to the sheet underneath (common on mobile)
    backdrop.style.pointerEvents = 'none';
    window.visualViewport?.removeEventListener('resize', onViewportChange);
    backdrop.remove();
    onClose?.();
    afterModalStackChange();
  };

  // Backdrop dismiss: require down+up on the dimmed area only (not the sheet).
  // Review modals set closeOnBackdrop: false — desktop clicks were kicking users out.
  if (closeOnBackdrop) {
    let dismissArmed = false;
    backdrop.addEventListener('pointerdown', e => {
      dismissArmed = e.target === backdrop;
    });
    backdrop.addEventListener('pointerup', e => {
      if (dismissArmed && e.target === backdrop) close();
      dismissArmed = false;
    });
    backdrop.addEventListener('pointercancel', () => { dismissArmed = false; });
  }

  // Clicks inside the sheet must never hit the backdrop
  modal.addEventListener('pointerdown', e => e.stopPropagation());
  modal.addEventListener('click', e => e.stopPropagation());

  const header = el('div', { className: 'modal-header' },
    el('h3', { id: titleId }, title),
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

  modal.classList.add('modal-scrollable');

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  syncModalCountFromDom();
  lockBodyScroll();

  const keepFieldVisible = (target) => {
    if (!target || !bodyEl.contains(target)) return;
    if (!target.matches('input, select, textarea')) return;
    requestAnimationFrame(() => {
      try {
        target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      } catch {
        target.scrollIntoView(true);
      }
    });
  };
  bodyEl.addEventListener('focusin', e => keepFieldVisible(e.target));
  window.visualViewport?.addEventListener('resize', onViewportChange);

  // Phone: don't pop the keyboard immediately — it shoves the sheet off-screen
  requestAnimationFrame(() => {
    if (isPhoneUi()) return;
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
  return toast;
}

/**
 * Toast with Undo action (e.g. after delete or snowball allocate).
 * @param {string} message
 * @param {() => void} onUndo
 * @param {number} [duration=8000]
 */
export function showUndoToast(message, onUndo, duration = 8000) {
  if (!toastContainer) {
    toastContainer = el('div', { className: 'toast-container' });
    document.body.appendChild(toastContainer);
  }
  let done = false;
  const toast = el('div', { className: 'toast undo-toast' });
  toast.appendChild(el('span', { className: 'undo-toast-msg' }, message));
  const btn = el('button', {
    type: 'button',
    className: 'undo-toast-btn',
    onClick: () => {
      if (done) return;
      done = true;
      toast.remove();
      try { onUndo?.(); } catch (e) { console.error(e); }
    },
  }, 'Undo');
  toast.appendChild(btn);
  toastContainer.appendChild(toast);
  setTimeout(() => {
    if (!done) toast.remove();
  }, duration);
  return toast;
}

export function confirmDialog(title, message, onConfirm) {
  const modal = showModal({
    title,
    body: el('p', { style: 'white-space:pre-line;line-height:1.5;margin:0' }, message),
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
