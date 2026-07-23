import { store } from './store.js';
import { renderLayout, updateActiveNav, updateNavBadges, refreshSyncChip } from './components/layout.js';
import { renderWizard } from './components/wizard.js';
import { hashPassword } from './utils.js';
import { applyTheme } from './themes.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderIncome } from './pages/income.js';
import { renderBudget } from './pages/budget.js';
import { renderBills } from './pages/bills.js';
import { renderDebt } from './pages/debt.js';
import { renderTransactions } from './pages/transactions.js';
import { renderReports } from './pages/reports.js';
import { renderSettings } from './pages/settings.js';
import { renderNotes } from './pages/notes.js';
import { renderAdvisor, prepareAdvisorVisit } from './pages/advisor.js';
import { isCloudConfigured } from './cloud-sync.js';
import { showCloudAuthScreen } from './components/cloud-auth.js';

const PAGES = {
  dashboard: renderDashboard,
  income: renderIncome,
  budget: renderBudget,
  bills: renderBills,
  debt: renderDebt,
  transactions: renderTransactions,
  notes: renderNotes,
  reports: renderReports,
  advisor: renderAdvisor,
  settings: renderSettings,
};

let currentPage = 'dashboard';
let pageArg = null;
let mainEl = null;
let unlocked = false;

async function init() {
  const state = store.getState();
  applyTheme(state.settings);

  if (state.settings.passwordHash && !unlocked) {
    showLockScreen();
    return;
  }

  if (!state.setupComplete) {
    renderWizard(() => bootstrap());
    return;
  }

  bootstrap();
}

function softRefreshChrome() {
  updateNavBadges();
  refreshSyncChip();
}

function bootstrap() {
  const shell = document.getElementById('app');
  mainEl = renderLayout(shell, currentPage, navigate);
  renderPage();
  store.subscribe(() => {
    // Notes auto-save silently; re-rendering would reset the textarea while typing
    if (!mainEl || currentPage === 'notes') {
      softRefreshChrome();
      return;
    }
    // While a modal is open, never rebuild the page — that unmounts review UI
    // context and causes mobile resize thrash. Modals re-paint themselves.
    if (document.querySelector('.modal-backdrop')) {
      softRefreshChrome();
      return;
    }
    renderPage();
  });
}

function navigate(page, arg) {
  if (page === 'advisor' && currentPage !== 'advisor') {
    prepareAdvisorVisit();
  }
  currentPage = page;
  pageArg = arg || null;
  updateActiveNav(page);
  renderPage();
}

function renderPage() {
  if (!mainEl) return;
  mainEl.innerHTML = '';
  const renderer = PAGES[currentPage];
  if (renderer) renderer(mainEl, pageArg);
  pageArg = null;
  updateNavBadges();
  refreshSyncChip();
}

function showLockScreen() {
  const lock = document.createElement('div');
  lock.className = 'lock-screen';
  lock.innerHTML = `
    <div class="lock-card">
      <h2>🔒 Financial Peace</h2>
      <p>Enter your password to continue</p>
      <div class="form-group">
        <input type="password" id="lock-pw" placeholder="Password" />
      </div>
      <button class="btn btn-primary" style="width:100%" id="lock-btn">Unlock</button>
    </div>
  `;
  document.body.appendChild(lock);

  const errEl = document.createElement('p');
  errEl.id = 'lock-err';
  errEl.style.cssText = 'color:var(--danger);font-size:0.85rem;margin:0.5rem 0 0;min-height:1.2em';
  lock.querySelector('.lock-card')?.appendChild(errEl);

  const tryUnlock = async () => {
    const pw = document.getElementById('lock-pw').value;
    const hash = await hashPassword(pw);
    if (hash === store.getState().settings.passwordHash) {
      unlocked = true;
      lock.remove();
      init();
    } else {
      const input = document.getElementById('lock-pw');
      input.style.borderColor = 'var(--danger)';
      errEl.textContent = 'Incorrect password. Try again.';
      input.focus();
      input.select?.();
    }
  };

  document.getElementById('lock-btn').addEventListener('click', tryUnlock);
  document.getElementById('lock-pw').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryUnlock();
  });
}

window.appNavigate = navigate;
/** Soft: badges/sync only. Full page re-render when no modal (or force: true). */
window.appSoftRefresh = softRefreshChrome;
window.appRefresh = (opts = {}) => {
  if (!opts.force && document.querySelector('.modal-backdrop')) {
    softRefreshChrome();
    return;
  }
  renderPage();
};

/** Keep CSS dvh-ish layout stable when mobile browser chrome resizes. */
function bindVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
  };
  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
}

bindVisualViewport();

async function startApp() {
  const cloud = await store.initCloud();
  if (cloud.configured && !cloud.signedIn) {
    showCloudAuthScreen(() => init());
    return;
  }
  init();
}

document.addEventListener('DOMContentLoaded', () => {
  startApp().catch(err => {
    console.error('Startup failed', err);
    init();
  });
});

// Build stamp — change this (and index.html ?v=) on every mobile-visible ship
const APP_BUILD = '20260717j';

if ('serviceWorker' in navigator) {
  // When a new SW takes control, reload once so HTML/CSS/JS match
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'SW_ACTIVATED' && !sessionStorage.getItem('sw-reloaded-' + APP_BUILD)) {
      sessionStorage.setItem('sw-reloaded-' + APP_BUILD, '1');
      window.location.reload();
    }
  });

  window.addEventListener('load', async () => {
    try {
      // Drop any SW registered under a query-string URL (broke updates)
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(async (reg) => {
        const url = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
        if (url.includes('sw.js?')) await reg.unregister();
      }));

      const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await reg.update();
    } catch {
      // offline or unsupported
    }
  });
}