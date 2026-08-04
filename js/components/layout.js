import { el } from '../utils.js';
import { store } from '../store.js';
import { applyTheme } from '../themes.js';
import { showNotesPopup } from './notes-popup.js';
import { showToast } from './modal.js';
import { getSyncStatus, isCloudConfigured } from '../cloud-sync.js';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Home', icon: '🏠' },
  { id: 'income', label: 'Income', icon: '💰' },
  { id: 'budget', label: 'Budget', icon: '✉️' },
  { id: 'bills', label: 'Bills', icon: '📋' },
  { id: 'debt', label: 'Debt', icon: '❄️' },
  { id: 'transactions', label: 'Transactions', icon: '📝' },
  { id: 'notes', label: 'Notes', icon: '🗒️' },
  { id: 'reports', label: 'Reports', icon: '📊' },
  { id: 'advisor', label: 'Advisor', icon: '🧭' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

/** Primary tabs for mobile bottom nav. "more" opens the sidebar. */
const BOTTOM_NAV_ITEMS = [
  { id: 'dashboard', label: 'Home', icon: '🏠' },
  { id: 'transactions', label: 'Log', icon: '📝' },
  { id: 'budget', label: 'Budget', icon: '✉️' },
  { id: 'bills', label: 'Bills', icon: '📋' },
  { id: 'more', label: 'More', icon: '☰' },
];

const BOTTOM_NAV_PAGE_IDS = new Set(
  BOTTOM_NAV_ITEMS.filter(i => i.id !== 'more').map(i => i.id)
);

const FAB_PAGES = new Set(['dashboard', 'transactions', 'budget']);

export function renderLayout(container, currentPage, onNavigate) {
  const state = store.getState();

  const sidebar = el('nav', { className: 'sidebar', id: 'sidebar' },
    el('div', { className: 'sidebar-header' },
      el('h1', {}, 'FigPig Financial'),
      el('div', { className: 'tagline' }, 'Give every dollar a job')
    ),
    el('div', { className: 'nav-links' },
      ...NAV_ITEMS.map(item =>
        el('button', {
          className: `nav-link${currentPage === item.id ? ' active' : ''}`,
          'data-page': item.id,
          'aria-current': currentPage === item.id ? 'page' : null,
          onClick: () => { closeMobile(); onNavigate(item.id); },
        },
          el('span', { className: 'icon' }, item.icon),
          el('span', { className: 'nav-link-label' }, item.label),
          el('span', { className: 'nav-badge', hidden: true }, '0')
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
      buildSyncChip(),
      el('span', { className: 'sidebar-tagline' }, 'Total Money Makeover')
    )
  );

  const overlay = el('div', { className: 'overlay', id: 'overlay', onClick: closeMobile });

  const bottomNav = el('nav', {
    className: 'bottom-nav',
    id: 'bottom-nav',
    'aria-label': 'Primary',
  },
    ...BOTTOM_NAV_ITEMS.map(item =>
      el('button', {
        type: 'button',
        className: `bottom-nav-item${isBottomNavActive(item.id, currentPage) ? ' active' : ''}`,
        'data-nav': item.id,
        onClick: () => {
          if (item.id === 'more') {
            openMobile();
            return;
          }
          closeMobile();
          onNavigate(item.id);
        },
      },
        el('span', { className: 'bottom-nav-icon-wrap' },
          el('span', { className: 'bottom-nav-icon' }, item.icon),
          item.id === 'transactions'
            ? el('span', { className: 'nav-badge bottom-nav-badge', hidden: true }, '0')
            : null,
        ),
        el('span', { className: 'bottom-nav-label' }, item.label)
      )
    )
  );

  const fab = el('button', {
    type: 'button',
    className: 'fab-expense',
    id: 'fab-expense',
    title: 'Log expense',
    'aria-label': 'Log expense',
    hidden: !FAB_PAGES.has(currentPage),
    onClick: () => {
      window.appNavigate('transactions', 'expense');
    },
  }, '+');

  const main = el('main', { className: 'main-content', id: 'page-content' });

  container.innerHTML = '';
  container.appendChild(sidebar);
  container.appendChild(overlay);
  container.appendChild(main);
  container.appendChild(bottomNav);
  container.appendChild(fab);

  applyTheme(state.settings);
  updateNavBadges();

  return main;
}

function buildSyncChip() {
  const chip = el('button', {
    type: 'button',
    className: 'sync-chip',
    id: 'sync-chip',
    title: 'Cloud sync status — tap to sync now',
  }, syncChipLabel());

  chip.addEventListener('click', async () => {
    if (!isCloudConfigured()) {
      showToast('Cloud sync is not configured', 'info');
      return;
    }
    chip.disabled = true;
    chip.textContent = 'Syncing…';
    try {
      await store.pushToCloud({ force: true });
      showToast('Synced to cloud', 'success');
    } catch (err) {
      console.warn(err);
      showToast('Sync failed — try Settings', 'info');
    } finally {
      chip.disabled = false;
      refreshSyncChip();
    }
  });

  return chip;
}

function syncChipLabel() {
  if (!isCloudConfigured()) return 'Cloud: off';
  const { status, lastSyncedAt } = getSyncStatus();
  if (status === 'syncing') return 'Syncing…';
  if (status === 'error') return 'Sync error · Tap to retry';
  if (lastSyncedAt) {
    const mins = Math.round((Date.now() - new Date(lastSyncedAt).getTime()) / 60000);
    if (mins < 1) return 'Synced just now · Tap to sync';
    if (mins < 60) return `Synced ${mins}m ago · Tap to sync`;
    const hrs = Math.round(mins / 60);
    return `Synced ${hrs}h ago · Tap to sync`;
  }
  const cloudAt = store.getState()._cloudUpdatedAt;
  if (cloudAt) {
    const mins = Math.round((Date.now() - Number(cloudAt)) / 60000);
    if (mins < 60) return `Cloud data · ${mins}m · Tap to sync`;
    return 'Cloud connected · Tap to sync';
  }
  return 'Cloud · Tap to sync';
}

export function refreshSyncChip() {
  const chip = document.getElementById('sync-chip');
  if (chip && !chip.disabled) chip.textContent = syncChipLabel();
}

function isBottomNavActive(navId, page) {
  if (navId === 'more') return !BOTTOM_NAV_PAGE_IDS.has(page);
  return navId === page;
}

function openMobile() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('overlay')?.classList.add('open');
}

function closeMobile() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('overlay')?.classList.remove('open');
}

export function updateNavBadges() {
  let count = 0;
  try {
    count = store.getReviewInbox()?.totalCount || 0;
  } catch {
    count = 0;
  }
  const label = count > 99 ? '99+' : String(count);

  document.querySelectorAll('.nav-link[data-page="transactions"] .nav-badge').forEach(badge => {
    badge.hidden = count <= 0;
    badge.textContent = label;
  });
  document.querySelectorAll('.bottom-nav-badge').forEach(badge => {
    badge.hidden = count <= 0;
    badge.textContent = label;
  });
}

export function updateActiveNav(page) {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });
  const idx = NAV_ITEMS.findIndex(n => n.id === page);
  document.querySelectorAll('.nav-link')[idx]?.classList.add('active');

  document.querySelectorAll('.bottom-nav-item').forEach(btn => {
    const navId = btn.getAttribute('data-nav');
    btn.classList.toggle('active', isBottomNavActive(navId, page));
  });

  const fab = document.getElementById('fab-expense');
  if (fab) fab.hidden = !FAB_PAGES.has(page);

  updateNavBadges();
  refreshSyncChip();
}
