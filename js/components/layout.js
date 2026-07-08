import { el } from '../utils.js';
import { store } from '../store.js';
import { applyTheme } from '../themes.js';
import { showNotesPopup } from './notes-popup.js';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '🏠' },
  { id: 'income', label: 'Income & Balances', icon: '💰' },
  { id: 'budget', label: 'Envelope Budget', icon: '✉️' },
  { id: 'bills', label: 'Bills & Payments', icon: '📋' },
  { id: 'debt', label: 'Debt Snowball', icon: '❄️' },
  { id: 'transactions', label: 'Transactions', icon: '📝' },
  { id: 'notes', label: 'Notes', icon: '🗒️' },
  { id: 'reports', label: 'Reports & Insights', icon: '📊' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export function renderLayout(container, currentPage, onNavigate) {
  const state = store.getState();

  const sidebar = el('nav', { className: 'sidebar', id: 'sidebar' },
    el('div', { className: 'sidebar-header' },
      el('h1', {}, 'Financial Peace Dashboard'),
      el('div', { className: 'tagline' }, 'Give every dollar a job')
    ),
    el('div', { className: 'nav-links' },
      ...NAV_ITEMS.map(item =>
        el('button', {
          className: `nav-link${currentPage === item.id ? ' active' : ''}`,
          onClick: () => { closeMobile(); onNavigate(item.id); },
        },
          el('span', { className: 'icon' }, item.icon),
          item.label
        )
      )
    ),
    el('div', { className: 'sidebar-footer' },
      el('button', {
        className: 'quick-notes-btn',
        onClick: () => { closeMobile(); showNotesPopup(); },
      },
        el('span', { className: 'icon' }, '🗒️'),
        'Quick Notes'
      ),
      el('span', { className: 'sidebar-tagline' }, 'Total Money Makeover')
    )
  );

  const overlay = el('div', { className: 'overlay', id: 'overlay', onClick: closeMobile });

  const mobileHeader = el('div', { className: 'mobile-header' },
    el('button', { className: 'menu-btn', onClick: toggleMobile }, '☰'),
    el('span', {}, 'Financial Peace'),
    el('span', {}, '')
  );

  const main = el('main', { className: 'main-content', id: 'page-content' });

  container.innerHTML = '';
  container.appendChild(sidebar);
  container.appendChild(overlay);
  container.appendChild(mobileHeader);
  container.appendChild(main);

  applyTheme(state.settings);

  return main;
}

function toggleMobile() {
  document.getElementById('sidebar')?.classList.toggle('open');
  document.getElementById('overlay')?.classList.toggle('open');
}

function closeMobile() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('overlay')?.classList.remove('open');
}

export function updateActiveNav(page) {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });
  const idx = NAV_ITEMS.findIndex(n => n.id === page);
  document.querySelectorAll('.nav-link')[idx]?.classList.add('active');
}