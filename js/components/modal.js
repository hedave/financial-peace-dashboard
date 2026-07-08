import { el } from '../utils.js';

let toastContainer = null;

export function showModal({ title, body, footer, onClose }) {
  const backdrop = el('div', { className: 'modal-backdrop' });
  const modal = el('div', { className: 'modal' });

  const close = () => {
    backdrop.remove();
    onClose?.();
  };

  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  const header = el('div', { className: 'modal-header' },
    el('h3', {}, title),
    el('button', { className: 'close-btn', onClick: close }, '×')
  );

  const bodyEl = el('div', { className: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  modal.appendChild(header);
  modal.appendChild(bodyEl);

  if (footer) {
    const footerEl = el('div', { className: 'modal-footer' });
    if (Array.isArray(footer)) footer.forEach(f => footerEl.appendChild(f));
    else footerEl.appendChild(footer);
    modal.appendChild(footerEl);
  }

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  return { close, backdrop, modal };
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
  showModal({
    title,
    body: el('p', {}, message),
    footer: [
      el('button', { className: 'btn btn-secondary', onClick: function() { this.closest('.modal-backdrop').remove(); } }, 'Cancel'),
      el('button', {
        className: 'btn btn-primary',
        onClick: function() {
          this.closest('.modal-backdrop').remove();
          onConfirm();
        }
      }, 'Confirm'),
    ],
  });
}