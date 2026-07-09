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

function bootstrap() {
  const shell = document.getElementById('app');
  mainEl = renderLayout(shell, currentPage, navigate);
  renderPage();
  store.subscribe(() => {
    // Notes auto-save silently; re-rendering would reset the textarea while typing
    if (mainEl && currentPage !== 'notes') renderPage();
  });
}

function navigate(page, arg) {
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

  const tryUnlock = async () => {
    const pw = document.getElementById('lock-pw').value;
    const hash = await hashPassword(pw);
    if (hash === store.getState().settings.passwordHash) {
      unlocked = true;
      lock.remove();
      init();
    } else {
      document.getElementById('lock-pw').style.borderColor = 'var(--danger)';
    }
  };

  document.getElementById('lock-btn').addEventListener('click', tryUnlock);
  document.getElementById('lock-pw').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryUnlock();
  });
}

window.appNavigate = navigate;
window.appRefresh = () => renderPage();

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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}