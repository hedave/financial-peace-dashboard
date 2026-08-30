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
import { renderTransactions, importBankText, importBankFile, openImportDialog } from './pages/transactions.js';
import { selfCheckImportReconcile } from './csv-import.js';
import { renderReports } from './pages/reports.js';
import { renderSettings } from './pages/settings.js';
import { renderNotes } from './pages/notes.js';
import { renderAdvisor, prepareAdvisorVisit } from './pages/advisor.js';
import { isNotesOnlyRole } from './cloud-sync.js';
import { refreshBankInboxCache, applyPendingBankInbox, inboxTransactionCount } from './bank-inbox.js';
import { showCloudAuthScreen } from './components/cloud-auth.js';
import { showToast } from './components/modal.js';

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
/** Last non-zero scroll per page (survives a frame where the browser clamps to 0). */
const lastScrollByPage = Object.create(null);
/** Held across modal lock → page rebuild (live capture is 0 while body is position:fixed). */
let holdScroll = null;
let restoreGuard = false;
let scrollTrackingBound = false;
let restoreTimers = [];

function captureScrollPos() {
  const se = document.scrollingElement;
  return {
    win: window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0,
    doc: se ? se.scrollTop : 0,
    main: mainEl ? mainEl.scrollTop : 0,
  };
}

function applyScrollPos(pos) {
  if (!pos) return;
  const y = Math.max(0, Number(pos.win || pos.doc || 0));
  const mainY = Math.max(0, Number(pos.main || 0));
  try {
    window.scrollTo({ top: y, left: 0, behavior: 'auto' });
  } catch {
    window.scrollTo(0, y);
  }
  const se = document.scrollingElement;
  if (se) se.scrollTop = y;
  if (mainEl) mainEl.scrollTop = mainY;
}

function trackScrollPos() {
  if (restoreGuard) return;
  if (document.body.classList.contains('modal-open')) return;
  const pos = captureScrollPos();
  // Ignore zeros after content collapse — keep last meaningful position
  if (pos.win > 0 || pos.doc > 0 || pos.main > 0) {
    lastScrollByPage[currentPage] = pos;
  }
}

function snapshotScroll() {
  if (document.body.classList.contains('modal-open') && holdScroll) return;
  const pos = captureScrollPos();
  if (pos.win > 0 || pos.doc > 0 || pos.main > 0) {
    lastScrollByPage[currentPage] = pos;
    holdScroll = pos;
  } else if (lastScrollByPage[currentPage]) {
    holdScroll = lastScrollByPage[currentPage];
  }
}

function bindScrollTracking() {
  if (scrollTrackingBound) return;
  scrollTrackingBound = true;
  const opts = { passive: true, capture: true };
  window.addEventListener('scroll', trackScrollPos, opts);
  document.addEventListener('scroll', trackScrollPos, opts);
}

function clearRestoreTimers() {
  restoreTimers.forEach(id => clearTimeout(id));
  restoreTimers = [];
}

/** Retry restore — content height (esp. async Settings) may land after first paint. */
function restoreScrollPos(pos) {
  if (!pos) return;
  const meaningful = (pos.win || 0) > 0 || (pos.doc || 0) > 0 || (pos.main || 0) > 0;
  if (!meaningful) return;
  clearRestoreTimers();
  restoreGuard = true;
  const run = () => applyScrollPos(pos);
  run();
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(run);
  });
  [16, 50, 100, 200, 400, 700, 1000].forEach(ms => {
    restoreTimers.push(setTimeout(run, ms));
  });
  restoreTimers.push(setTimeout(() => { restoreGuard = false; }, 1100));
}

function scrollToTop() {
  clearRestoreTimers();
  applyScrollPos({ win: 0, doc: 0, main: 0 });
}

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

function getRouteIntent() {
  const hash = String(window.location.hash || '');
  const search = String(window.location.search || '');
  const qFromHash = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(qFromHash || search.replace(/^\?/, ''));
  const pageMatch = hash.match(/^#\/?([a-z]+)/i);
  return {
    page: pageMatch && PAGES[pageMatch[1]] ? pageMatch[1] : null,
    openImport: params.get('import') === '1',
  };
}

function applyHashRoute() {
  const intent = getRouteIntent();
  if (intent.page) {
    navigate(intent.page, intent.openImport ? { import: true } : null);
    return;
  }
  if (intent.openImport) navigate('transactions', { import: true });
}

let lastInboxCount = 0;
let inboxWatchBound = false;

function pollBankInbox() {
  if (isNotesOnlyRole()) return;
  store.pullFromCloud()
    .then((result) => {
      if (result?.applied) window.appRefresh?.();
      return refreshBankInboxCache();
    })
    .then((rows) => {
      const n = inboxTransactionCount(rows);
      if (n > 0 && currentPage === 'dashboard') window.appRefresh?.();
      else if (n > lastInboxCount) {
        showToast(`${n} USAA row${n === 1 ? '' : 's'} waiting — API apply missed; tap Import on Home`, 'info', 5000);
      }
      lastInboxCount = n;
    })
    .catch(() => {});
}

function bindInboxWatch() {
  if (inboxWatchBound) return;
  inboxWatchBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollBankInbox();
  });
}

function installFigPigApi() {
  window.FigPig = {
    importBankText,
    importBankFile,
    openImportDialog,
    applyBankInbox: applyPendingBankInbox,
    selfCheckImport: selfCheckImportReconcile,
    lastImportStats: window.FigPig?.lastImportStats || null,
    APP_BUILD,
  };
}

function bootstrap() {
  const shell = document.getElementById('app');
  const intent = getRouteIntent();
  if (intent.page) currentPage = intent.page;
  else if (intent.openImport) currentPage = 'transactions';
  if (intent.openImport) pageArg = { import: true };

  mainEl = renderLayout(shell, currentPage, navigate);
  bindScrollTracking();
  if (mainEl) {
    mainEl.addEventListener('scroll', trackScrollPos, { passive: true });
  }
  renderPage({ reason: 'bootstrap' });
  bindInboxWatch();
  pollBankInbox();
  window.addEventListener('hashchange', applyHashRoute);
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
    renderPage({ reason: 'store' });
  });
}

function navigate(page, arg) {
  if (page === 'advisor' && currentPage !== 'advisor') {
    prepareAdvisorVisit();
  }
  // Remember scroll on the page we’re leaving
  trackScrollPos();
  currentPage = page;
  pageArg = arg || null;
  updateActiveNav(page);
  renderPage({ reason: 'navigate', scrollTop: true });
}

/**
 * Re-render current page.
 * - Same-page soft re-renders (rule delete, budget edits, etc.): restore scroll
 * - Navigation: jump to top
 */
function renderPage(opts = {}) {
  if (!mainEl) return;
  const navigating = !!opts.scrollTop;
  const samePage = !navigating && renderPage._lastPage === currentPage;

  // Prefer live capture; if browser already clamped to 0, use last known for this page
  let pos = captureScrollPos();
  if (samePage) {
    const known = holdScroll || lastScrollByPage[currentPage];
    if ((pos.win === 0 && pos.doc === 0 && pos.main === 0) && known) {
      pos = known;
    } else if (pos.win > 0 || pos.doc > 0 || pos.main > 0) {
      lastScrollByPage[currentPage] = pos;
    }
  }

  renderPage._lastPage = currentPage;

  const active = document.activeElement;
  if (active && mainEl.contains(active) && typeof active.blur === 'function') {
    active.blur();
  }
  mainEl.innerHTML = '';
  const renderer = PAGES[currentPage];
  const finish = () => {
    pageArg = null;
    updateNavBadges();
    refreshSyncChip();
    if (navigating || !samePage) {
      holdScroll = null;
      scrollToTop();
      lastScrollByPage[currentPage] = { win: 0, doc: 0, main: 0 };
      return;
    }
    restoreScrollPos(pos);
  };

  if (!renderer) {
    finish();
    return;
  }
  try {
    const out = renderer(mainEl, pageArg);
    if (out && typeof out.then === 'function') {
      out.then(finish).catch(err => {
        console.error(err);
        finish();
      });
      return;
    }
  } catch (err) {
    console.error(err);
  }
  finish();
}

function showLockScreen() {
  const lock = document.createElement('div');
  lock.className = 'lock-screen';
  lock.innerHTML = `
    <div class="lock-card">
      <h2>🔒 FigPig Financial</h2>
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

window.appToast = showToast;
window.appNavigate = navigate;
window.appSnapshotScroll = snapshotScroll;
/** Soft: badges/sync only. Full page re-render when no modal (or force: true). */
window.appSoftRefresh = softRefreshChrome;
window.appRefresh = (opts = {}) => {
  if (!opts.force && document.querySelector('.modal-backdrop')) {
    softRefreshChrome();
    return;
  }
  // Soft full re-render: keep scroll (same page)
  renderPage({ reason: opts.force ? 'force' : 'refresh' });
};

/** Keep sheets inside the visible viewport (keyboard + mobile browser chrome). */
function bindVisualViewport() {
  const apply = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const w = vv ? vv.width : window.innerWidth;
    const top = vv ? vv.offsetTop : 0;
    const left = vv ? vv.offsetLeft : 0;
    const root = document.documentElement;
    root.style.setProperty('--vvh', `${Math.round(h)}px`);
    root.style.setProperty('--vvw', `${Math.round(w)}px`);
    root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    root.style.setProperty('--vv-left', `${Math.round(left)}px`);
    const keyboard = vv && vv.height < window.innerHeight * 0.78;
    document.body.classList.toggle('vv-keyboard', !!keyboard);
  };
  apply();
  window.addEventListener('resize', apply);
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
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
const APP_BUILD = '20260830b';

installFigPigApi();

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