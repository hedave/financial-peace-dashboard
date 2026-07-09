import { el, formatCurrency, formatDate, todayISO, parseCSV, emptyState } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';
import { createSplitEditor } from '../components/split-editor.js';
import { openReviewInbox, openBillMatches, openDuplicateReview } from '../components/review-inbox.js';
import { isBonusIncomeSource, BONUS_INCOME_NAME } from '../income-sources.js';

let openMode = null;

const TYPE_LABELS = {
  expense: 'Expense',
  income: 'Income',
  debt_payment: 'Debt Payment',
  transfer: 'Transfer',
  celebration: 'Celebration',
};

const EDITABLE_TYPES = ['expense', 'income', 'debt_payment', 'transfer'];

const SORT_OPTIONS = [
  { key: 'date', dir: 'desc', label: 'Date (newest first)' },
  { key: 'date', dir: 'asc', label: 'Date (oldest first)' },
  { key: 'amount', dir: 'desc', label: 'Amount (high to low)' },
  { key: 'amount', dir: 'asc', label: 'Amount (low to high)' },
  { key: 'description', dir: 'asc', label: 'Description (A to Z)' },
  { key: 'description', dir: 'desc', label: 'Description (Z to A)' },
  { key: 'category', dir: 'asc', label: 'Category (A to Z)' },
  { key: 'category', dir: 'desc', label: 'Category (Z to A)' },
  { key: 'type', dir: 'asc', label: 'Type (A to Z)' },
  { key: 'type', dir: 'desc', label: 'Type (Z to A)' },
];

function sortOptionValue(key, dir) {
  return `${key}:${dir}`;
}

function categorySortName(t, state) {
  if (store.isSplitTransaction(t)) {
    return t.splits
      .map(s => state.categories.find(c => c.id === s.categoryId)?.name || '')
      .filter(Boolean)
      .join(', ');
  }
  const cat = state.categories.find(c => c.id === t.categoryId);
  return cat?.name || t.importCategory || '';
}

function transactionNeedsCategory(t) {
  if (!categoryUsesEnvelope(t.type)) return false;
  if (store.isSplitTransaction(t)) {
    return t.splits.some(s => !s.categoryId);
  }
  return !t.categoryId;
}

function sortTransactions(txs, state, sortKey, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...txs].sort((a, b) => {
    let va;
    let vb;
    switch (sortKey) {
      case 'description':
        va = (a.description || '').toLowerCase();
        vb = (b.description || '').toLowerCase();
        break;
      case 'category':
        va = categorySortName(a, state).toLowerCase();
        vb = categorySortName(b, state).toLowerCase();
        break;
      case 'type':
        va = (TYPE_LABELS[a.type] || a.type || '').toLowerCase();
        vb = (TYPE_LABELS[b.type] || b.type || '').toLowerCase();
        break;
      case 'amount':
        va = Number(a.amount) || 0;
        vb = Number(b.amount) || 0;
        break;
      case 'date':
      default:
        va = a.date || '';
        vb = b.date || '';
        break;
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
}

function categoryUsesEnvelope(type) {
  return type === 'expense' || type === 'debt_payment' || type === 'transfer';
}

function amountSearchStrings(amount) {
  const abs = Math.abs(Number(amount)) || 0;
  return [
    String(abs),
    abs.toFixed(2),
    formatCurrency(abs).replace(/[$,\s]/g, ''),
  ];
}

function transactionMatchesSearch(tx, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;

  if ((tx.description || '').toLowerCase().includes(q)) return true;

  const amountStrings = amountSearchStrings(tx.amount);
  const stripped = q.replace(/[$,\s]/g, '');
  if (stripped && /^[\d.]+$/.test(stripped)) {
    if (amountStrings.some(s => s.includes(stripped))) return true;
    const parsed = Number(stripped);
    if (!Number.isNaN(parsed) && Math.abs(Math.abs(Number(tx.amount)) - parsed) < 0.005) {
      return true;
    }
  }

  return false;
}

function guessMerchantPattern(description) {
  const text = String(description || '').trim();
  if (!text) return '';
  const words = text.split(/\s+/).filter(w => w.length >= 4);
  return (words[0] || text).toLowerCase().slice(0, 48);
}

function buildCategorySelect(state, { value = '', includeUncategorized = true } = {}) {
  const select = el('select');
  if (includeUncategorized) {
    select.appendChild(el('option', { value: '' }, '— No category —'));
  }
  state.categories.forEach(c => {
    select.appendChild(el('option', { value: c.id }, `${c.icon || ''} ${c.name}`.trim()));
  });
  if (value) select.value = value;
  return select;
}

export function renderTransactions(container, mode) {
  if (mode) openMode = mode;
  const state = store.getState();
  let filter = '';
  let typeFilter = 'all';
  let categoryFilter = 'all';
  let sortKey = 'date';
  let sortDir = 'desc';

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Transaction Log'),
    el('p', {}, 'Every dollar in and out — sort, edit, and categorize manually when needed')
  ));

  const inbox = store.getReviewInbox();
  const duplicateCount = store.getDuplicateTransactionIds().size;

  if (duplicateCount > 0) {
    container.appendChild(el('div', { className: 'banner banner-warning tx-duplicate-banner section' },
      el('div', { className: 'banner-icon' }, '⚠️'),
      el('div', { className: 'banner-text' },
        el('h3', {}, 'Possible duplicate transactions'),
        el('p', {}, `${duplicateCount} transaction${duplicateCount === 1 ? '' : 's'} look like duplicates — same amount and similar merchant. Review and delete any extras.`)
      ),
      el('button', {
        className: 'btn btn-secondary btn-sm',
        style: 'margin-left:auto;align-self:center',
        onClick: () => {
          typeFilter = 'duplicates';
          const typeEl = toolbar.querySelector('#tx-type-filter');
          if (typeEl) typeEl.value = 'duplicates';
          renderList();
        },
      }, 'Show Duplicates'),
    ));
  }

  const txTools = el('details', { className: 'page-tools-menu' });
  txTools.appendChild(el('summary', { className: 'btn btn-secondary' }, 'More actions'));
  const txToolsList = el('div', { className: 'page-tools-dropdown' });
  txToolsList.appendChild(el('button', {
    type: 'button', className: 'page-tools-item',
    onClick: () => { txTools.removeAttribute('open'); openTransactionForm({ type: 'income' }); },
  }, '+ Log Income'));
  txToolsList.appendChild(el('button', {
    type: 'button', className: 'page-tools-item',
    onClick: () => { txTools.removeAttribute('open'); openImportDialog(); },
  }, 'Import CSV'));
  if (inbox.totalCount > 0) {
    txToolsList.appendChild(el('button', {
      type: 'button', className: 'page-tools-item',
      onClick: () => { txTools.removeAttribute('open'); openReviewInbox(inbox); },
    }, `Review (${inbox.totalCount})`));
  }
  if (duplicateCount > 0) {
    txToolsList.appendChild(el('button', {
      type: 'button', className: 'page-tools-item',
      onClick: () => { txTools.removeAttribute('open'); openDuplicateReview(inbox); },
    }, `Duplicates (${duplicateCount})`));
  }
  txTools.appendChild(txToolsList);

  container.appendChild(el('div', { className: 'btn-group section tx-actions' },
    el('button', { className: 'btn btn-primary', onClick: () => openTransactionForm() }, '+ Add Transaction'),
    el('button', { className: 'btn btn-secondary tx-action-secondary', onClick: () => openTransactionForm({ type: 'expense' }) }, '+ Log Expense'),
    el('button', { className: 'btn btn-accent tx-action-secondary', onClick: () => openTransactionForm({ type: 'income' }) }, '+ Log Income'),
    el('button', { className: 'btn btn-secondary tx-action-secondary', onClick: openImportDialog }, 'Import CSV'),
    inbox.totalCount > 0 ? el('button', {
      className: 'btn btn-accent tx-action-secondary',
      onClick: () => openReviewInbox(inbox),
    }, `Review (${inbox.totalCount})`) : null,
    duplicateCount > 0 ? el('button', {
      className: 'btn btn-secondary tx-action-secondary',
      onClick: () => openDuplicateReview(inbox),
    }, `Duplicates (${duplicateCount})`) : null,
    txTools,
  ));

  const sortSelect = el('select', { id: 'tx-sort' },
    ...SORT_OPTIONS.map(opt => el('option', {
      value: sortOptionValue(opt.key, opt.dir),
    }, opt.label))
  );
  sortSelect.value = sortOptionValue(sortKey, sortDir);

  const typeSelect = el('select', { id: 'tx-type-filter' },
    el('option', { value: 'all' }, 'All Types'),
    ...EDITABLE_TYPES.map(type => el('option', { value: type }, TYPE_LABELS[type])),
    el('option', { value: 'duplicates' }, 'Possible Duplicates'),
  );
  const catSelect = el('select', { id: 'tx-cat-filter' },
    el('option', { value: 'all' }, 'All Categories'),
    el('option', { value: 'uncategorized' }, 'Uncategorized'),
    ...state.categories.map(c => el('option', { value: c.id }, c.name))
  );

  const filterFields = el('div', { className: 'tx-filter-fields' },
    typeSelect,
    catSelect,
    el('label', { className: 'tx-sort-label' }, 'Sort'),
    sortSelect,
  );

  const filtersToggle = el('button', {
    type: 'button',
    className: 'btn btn-secondary btn-sm tx-filters-toggle',
    onClick: () => toolbar.classList.toggle('filters-open'),
  }, 'Filters & sort');

  const toolbar = el('div', { className: 'toolbar tx-toolbar' },
    el('input', { type: 'search', placeholder: 'Search by description or amount...', id: 'tx-search' }),
    filtersToggle,
    filterFields,
  );
  container.appendChild(toolbar);

  const listEl = el('div', { id: 'tx-list' });
  container.appendChild(listEl);

  function sortableTh(key, label) {
    const active = sortKey === key;
    const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    return el('th', {
      className: `sortable-th${active ? ' sorted' : ''}`,
      onClick: () => {
        if (sortKey === key) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortKey = key;
          sortDir = key === 'date' || key === 'amount' ? 'desc' : 'asc';
        }
        sortSelect.value = sortOptionValue(sortKey, sortDir);
        renderList();
      },
      title: 'Click to sort',
    }, label + arrow);
  }

  function renderList() {
    const currentState = store.getState();
    const duplicateMeta = store.getDuplicateTransactionMeta();
    let txs = [...currentState.transactions];
    if (filter) txs = txs.filter(t => transactionMatchesSearch(t, filter));
    if (typeFilter === 'duplicates') {
      txs = txs.filter(t => duplicateMeta.has(t.id));
    } else if (typeFilter !== 'all') {
      txs = txs.filter(t => t.type === typeFilter);
    }
    if (categoryFilter === 'uncategorized') {
      txs = txs.filter(t => transactionNeedsCategory(t));
    } else if (categoryFilter !== 'all') {
      txs = txs.filter(t => {
        if (store.isSplitTransaction(t)) {
          return t.splits.some(s => s.categoryId === categoryFilter);
        }
        return t.categoryId === categoryFilter;
      });
    }
    txs = sortTransactions(txs, currentState, sortKey, sortDir);

    listEl.innerHTML = '';
    if (!txs.length) {
      listEl.appendChild(emptyState('📝', 'No transactions', 'Log a transaction, import from your bank, or adjust your filters.'));
      return;
    }

    const visible = txs.slice(0, 200);
    const moreNote = txs.length > 200
      ? el('p', { className: 'tx-list-more', style: 'padding:0.75rem;font-size:0.8rem;color:var(--text-muted)' },
        `Showing 200 of ${txs.length} transactions`)
      : null;

    // Desktop: multi-column table
    listEl.appendChild(el('div', { className: 'card tx-desktop-list' },
      el('div', { className: 'table-wrap' },
        el('table', { className: 'sortable-table' },
          el('thead', {}, el('tr', {},
            sortableTh('date', 'Date'),
            sortableTh('description', 'Description'),
            sortableTh('category', 'Category'),
            sortableTh('type', 'Type'),
            sortableTh('amount', 'Amount'),
            el('th', {}, 'Actions'),
          )),
          el('tbody', {},
            ...visible.map(t => txRow(t, currentState, duplicateMeta))
          )
        )
      ),
      moreNote ? moreNote.cloneNode(true) : null
    ));

    // Mobile: card list
    listEl.appendChild(el('div', { className: 'tx-mobile-list' },
      ...visible.map(t => txCard(t, currentState, duplicateMeta)),
      moreNote
    ));

    const checking = store.getState().balances.checking;
    listEl.appendChild(el('div', { className: 'card', style: 'margin-top:1rem;padding:0.75rem 1rem' },
      el('strong', {}, `Checking balance after transactions: ${formatCurrency(checking)}`)
    ));
  }

  toolbar.querySelector('#tx-search').addEventListener('input', e => { filter = e.target.value; renderList(); });
  toolbar.querySelector('#tx-type-filter').addEventListener('change', e => { typeFilter = e.target.value; renderList(); });
  toolbar.querySelector('#tx-cat-filter').addEventListener('change', e => { categoryFilter = e.target.value; renderList(); });
  sortSelect.addEventListener('change', e => {
    const [key, dir] = e.target.value.split(':');
    sortKey = key;
    sortDir = dir;
    renderList();
  });

  renderList();

  if (openMode) {
    const m = openMode;
    openMode = null;
    setTimeout(() => openTransactionForm({ type: m }), 100);
  }
}

function categoryLabel(t, state) {
  if (store.isSplitTransaction(t)) {
    const parts = t.splits.map(s => {
      const cat = state.categories.find(c => c.id === s.categoryId);
      const name = cat ? `${cat.icon || ''} ${cat.name}`.trim() : '—';
      return `${name} ${formatCurrency(s.amount)}`;
    });
    return el('span', { className: 'tx-split-label', title: parts.join('\n') },
      el('span', { className: 'tx-split-badge' }, `Split (${t.splits.length})`),
      el('span', { className: 'tx-split-detail' }, parts.join(' · '))
    );
  }
  const cat = state.categories.find(c => c.id === t.categoryId);
  if (cat) return `${cat.icon || ''} ${cat.name}`.trim();
  if (!categoryUsesEnvelope(t.type)) return '—';
  if (t.importCategory) {
    return el('span', { className: 'tx-category-unmapped', title: 'Imported bank category — click Edit to assign an envelope' },
      t.importCategory,
      el('span', { className: 'tx-category-hint' }, ' · assign')
    );
  }
  return el('span', { className: 'tx-category-missing' }, 'Uncategorized');
}

function incomeSourceLabel(t, state) {
  if (t.type !== 'income' || !t.incomeSourceId) return null;
  const source = state.incomeSources.find(s => s.id === t.incomeSourceId);
  if (!source) return null;
  if (isBonusIncomeSource(source)) {
    return el('span', { className: 'tx-bonus-badge', title: 'Freely allocatable — counts toward To Allocate' },
      BONUS_INCOME_NAME
    );
  }
  return el('span', { className: 'tx-income-source', style: 'font-size:0.75rem;color:var(--text-muted)' },
    source.name
  );
}

function txActionButtons(t) {
  return [
    el('button', {
      className: 'btn btn-sm btn-secondary',
      onClick: () => openTransactionForm({ transaction: t }),
    }, 'Edit'),
    t.type === 'expense' ? el('button', {
      className: 'btn btn-sm btn-accent',
      onClick: () => openTransactionForm({ transaction: t, splitMode: true }),
    }, store.isSplitTransaction(t) ? 'Edit Split' : 'Split') : null,
    transactionNeedsCategory(t) ? el('button', {
      className: 'btn btn-sm btn-secondary',
      onClick: () => openTransactionForm({ transaction: t, focusCategory: true }),
    }, 'Category') : null,
    el('button', {
      className: 'btn btn-sm btn-danger',
      onClick: () => deleteTransaction(t.id),
    }, '×'),
  ];
}

function txMoreMenu(t) {
  const menu = el('details', { className: 'tx-more-menu' });
  const summary = el('summary', {
    className: 'btn btn-sm btn-secondary tx-more-trigger',
    title: 'More actions',
  }, '⋯');
  summary.addEventListener('click', e => e.stopPropagation());

  const items = el('div', { className: 'tx-more-dropdown' });
  if (t.type === 'expense') {
    items.appendChild(el('button', {
      type: 'button',
      className: 'tx-more-item',
      onClick: () => {
        menu.removeAttribute('open');
        openTransactionForm({ transaction: t, splitMode: true });
      },
    }, store.isSplitTransaction(t) ? 'Edit Split' : 'Split'));
  }
  if (transactionNeedsCategory(t)) {
    items.appendChild(el('button', {
      type: 'button',
      className: 'tx-more-item',
      onClick: () => {
        menu.removeAttribute('open');
        openTransactionForm({ transaction: t, focusCategory: true });
      },
    }, 'Category'));
  }
  items.appendChild(el('button', {
    type: 'button',
    className: 'tx-more-item tx-more-item-danger',
    onClick: () => {
      menu.removeAttribute('open');
      deleteTransaction(t.id);
    },
  }, 'Delete'));

  menu.appendChild(summary);
  menu.appendChild(items);

  // Close when clicking outside
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    const close = e => {
      if (!menu.contains(e.target)) {
        menu.removeAttribute('open');
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  });

  return menu;
}

function txRow(t, state, duplicateMeta = new Map()) {
  const isIncome = t.type === 'income';
  const sourceTag = incomeSourceLabel(t, state);
  const dupCount = duplicateMeta.get(t.id);
  const isDuplicate = dupCount >= 2;
  return el('tr', { className: isDuplicate ? 'tx-duplicate-row' : '' },
    el('td', {},
      formatDate(t.date),
      isDuplicate ? el('div', {},
        el('span', {
          className: 'tx-duplicate-badge',
          title: `${dupCount} transactions on this date with this amount`,
        }, `Duplicate (${dupCount})`)
      ) : null,
    ),
    el('td', {},
      t.description || '—',
      sourceTag ? el('div', {}, sourceTag) : null,
    ),
    el('td', {}, categoryLabel(t, state)),
    el('td', {}, TYPE_LABELS[t.type] || t.type),
    el('td', { style: `font-weight:600;color:${isIncome ? 'var(--positive)' : 'var(--text)'}` },
      `${isIncome ? '+' : '-'}${formatCurrency(t.amount)}`
    ),
    el('td', {},
      el('div', { className: 'btn-group' },
        ...txActionButtons(t)
      )
    )
  );
}

function txCard(t, state, duplicateMeta = new Map()) {
  const isIncome = t.type === 'income';
  const sourceTag = incomeSourceLabel(t, state);
  const dupCount = duplicateMeta.get(t.id);
  const isDuplicate = dupCount >= 2;

  return el('article', {
    className: `tx-card${isDuplicate ? ' tx-duplicate-row' : ''}`,
  },
    el('div', { className: 'tx-card-top' },
      el('span', { className: 'tx-card-date' }, formatDate(t.date)),
      el('span', {
        className: 'tx-card-amount',
        style: `color:${isIncome ? 'var(--positive)' : 'var(--text)'}`,
      }, `${isIncome ? '+' : '-'}${formatCurrency(t.amount)}`)
    ),
    el('div', { className: 'tx-card-body' },
      el('div', { className: 'tx-card-desc' }, t.description || '—'),
      sourceTag ? el('div', { className: 'tx-card-meta' }, sourceTag) : null,
      el('div', { className: 'tx-card-meta' }, categoryLabel(t, state)),
      el('div', { className: 'tx-card-badges' },
        el('span', { className: 'tx-type-badge' }, TYPE_LABELS[t.type] || t.type),
        isDuplicate ? el('span', {
          className: 'tx-duplicate-badge',
          title: `${dupCount} transactions with this amount`,
        }, `Duplicate (${dupCount})`) : null,
      )
    ),
    el('div', { className: 'tx-card-actions' },
      el('button', {
        className: 'btn btn-sm btn-secondary',
        onClick: () => openTransactionForm({ transaction: t }),
      }, 'Edit'),
      txMoreMenu(t)
    )
  );
}

export function openTransactionForm({
  type = 'expense',
  transaction = null,
  focusCategory = false,
  splitMode = false,
} = {}) {
  const state = store.getState();
  const isEdit = !!transaction;
  const initialType = transaction?.type || type;

  const isCelebration = transaction?.type === 'celebration';
  const typeSelect = el('select', {},
    ...EDITABLE_TYPES.map(t => el('option', { value: t }, TYPE_LABELS[t]))
  );
  typeSelect.value = EDITABLE_TYPES.includes(initialType) ? initialType : 'expense';
  const typeField = isCelebration
    ? el('div', { className: 'form-group' },
      el('label', {}, 'Type'),
      el('p', { style: 'margin:0;padding:0.55rem 0;color:var(--text-muted)' }, TYPE_LABELS.celebration)
    )
    : el('div', { className: 'form-group' }, el('label', {}, 'Type'), typeSelect);

  const dateIn = el('input', { type: 'date', value: transaction?.date || todayISO() });
  const amountIn = el('input', {
    type: 'number',
    step: '0.01',
    min: 0,
    value: transaction ? String(transaction.amount) : '',
  });
  const descIn = el('input', {
    type: 'text',
    placeholder: 'Description',
    value: transaction?.description || '',
  });

  const catGroup = el('div', { className: 'form-group' },
    el('label', {}, 'Envelope / Category'),
    buildCategorySelect(state, { value: transaction?.categoryId || '' }),
  );
  const catSelect = catGroup.querySelector('select');

  const debtGroup = el('div', { className: 'form-group', style: 'display:none' },
    el('label', {}, 'Debt'),
    el('select', {},
      el('option', { value: '' }, '— Select debt —'),
      ...state.debts.filter(d => !d.archived && Number(d.balance) > 0).map(d =>
        el('option', { value: d.id }, `${d.name} (${formatCurrency(d.balance)})`)
      ),
    ),
  );
  const debtSelect = debtGroup.querySelector('select');
  if (transaction?.debtId) debtSelect.value = transaction.debtId;

  const importNote = transaction?.importCategory && !transaction?.categoryId
    ? el('p', { className: 'tx-form-hint' },
      `Bank category: ${transaction.importCategory}. Pick an envelope below to map it.`
    )
    : null;

  const linkedDebtNote = isEdit && transaction?.debtId
    ? el('p', { className: 'tx-form-hint' },
      `Linked to debt: ${state.debts.find(d => d.id === transaction.debtId)?.name || 'Unknown'}. Amount changes update the debt balance.`
    )
    : null;

  const splitToggle = el('input', { type: 'checkbox' });
  const splitInitial = store.isSplitTransaction(transaction)
    ? transaction.splits
    : transaction?.categoryId
      ? [{ categoryId: transaction.categoryId, amount: transaction.amount }]
      : null;
  const splitEditor = createSplitEditor(state.categories, {
    totalAmount: Number(transaction?.amount) || 0,
    initialSplits: splitInitial,
  });
  const splitSection = el('div', { className: 'split-section' }, splitEditor.element);
  const splitOption = el('div', { className: 'form-option split-toggle' },
    el('div', { className: 'form-option-text' },
      el('span', { className: 'form-option-label' }, 'Split across envelopes'),
      el('span', { className: 'form-option-hint' }, 'Divide one purchase between multiple budget categories'),
    ),
    el('label', { className: 'toggle-switch' },
      splitToggle,
      el('span', { className: 'toggle-slider' }),
    ),
  );

  if (splitMode || store.isSplitTransaction(transaction)) {
    splitToggle.checked = true;
  }

  function syncTypeFields() {
    const currentType = isCelebration ? transaction.type : typeSelect.value;
    const canSplit = currentType === 'expense';
    const useSplit = canSplit && splitToggle.checked;
    splitOption.style.display = canSplit ? '' : 'none';
    catGroup.style.display = categoryUsesEnvelope(currentType) && !useSplit ? '' : 'none';
    splitSection.style.display = useSplit ? '' : 'none';
    const showDebt = currentType === 'debt_payment' && !isEdit;
    debtGroup.style.display = showDebt ? '' : 'none';
    if (useSplit) {
      splitEditor.setTotalAmount(Number(amountIn.value) || 0);
    }
    syncRemember();
  }

  typeSelect.addEventListener('change', syncTypeFields);
  splitToggle.addEventListener('change', syncTypeFields);
  amountIn.addEventListener('input', () => {
    if (splitToggle.checked) splitEditor.setTotalAmount(Number(amountIn.value) || 0);
  });
  const rememberRule = el('input', { type: 'checkbox' });
  const rememberGroup = el('div', { className: 'form-option remember-rule', style: 'display:none' },
    el('div', { className: 'form-option-text' },
      el('span', { className: 'form-option-label' }, 'Remember for future imports'),
      el('span', { className: 'form-option-hint' }, 'Auto-categorize when this merchant appears in CSV imports'),
    ),
    el('label', { className: 'toggle-switch' },
      rememberRule,
      el('span', { className: 'toggle-slider' }),
    ),
  );

  function syncRemember() {
    const currentType = isCelebration ? transaction?.type : typeSelect.value;
    const useSplit = currentType === 'expense' && splitToggle.checked;
    const hasCat = useSplit ? splitEditor.getSplits().some(s => s.categoryId) : !!catSelect.value;
    rememberGroup.style.display = currentType === 'expense' && hasCat && descIn.value.trim() ? '' : 'none';
  }

  catSelect.addEventListener('change', syncRemember);
  descIn.addEventListener('input', syncRemember);
  syncTypeFields();

  const modal = showModal({
    title: isEdit ? 'Edit Transaction' : 'Add Transaction',
    body: el('div', {},
      importNote,
      linkedDebtNote,
      el('div', { className: 'input-row' },
        typeField,
        el('div', { className: 'form-group' }, el('label', {}, 'Date'), dateIn),
      ),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Amount'), amountIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Description'), descIn),
      ),
      splitOption,
      catGroup,
      splitSection,
      rememberGroup,
      debtGroup,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Cancel'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const amt = Number(amountIn.value);
          if (!amt) {
            showToast('Enter an amount', 'info');
            return;
          }
          const txType = isCelebration ? transaction.type : typeSelect.value;
          const useSplit = txType === 'expense' && splitToggle.checked;
          const debtId = txType === 'debt_payment' && !isEdit ? (debtSelect.value || null) : (transaction?.debtId || null);

          if (txType === 'debt_payment' && !isEdit && !debtId) {
            showToast('Select a debt for debt payments', 'info');
            return;
          }

          if (useSplit) {
            if (!splitEditor.isValid()) {
              showToast('Assign each split to an envelope and match the transaction total', 'info');
              return;
            }
          }

          const categoryId = !useSplit && categoryUsesEnvelope(txType) ? (catSelect.value || null) : null;
          const splits = useSplit ? splitEditor.getSplits() : null;

          if (isEdit) {
            const updates = {
              date: dateIn.value,
              amount: amt,
              type: txType,
              description: descIn.value.trim(),
            };
            if (useSplit) {
              updates.splits = splits;
            } else {
              updates.categoryId = categoryId;
              updates.splits = [];
            }
            store.updateTransaction(transaction.id, updates);
            showToast(useSplit ? 'Split transaction saved!' : 'Transaction updated!');
          } else {
            store.addTransaction({
              date: dateIn.value,
              amount: amt,
              type: txType,
              categoryId,
              description: descIn.value.trim(),
              debtId,
              splits,
            });
            showToast(useSplit ? 'Split transaction logged!' : 'Transaction logged!');
          }

          if (rememberRule.checked && txType === 'expense') {
            const pattern = guessMerchantPattern(descIn.value);
            if (pattern) {
              if (useSplit) {
                store.addCategoryRule({
                  pattern,
                  type: 'split',
                  categoryIds: splits.map(s => s.categoryId).filter(Boolean),
                });
              } else if (categoryId) {
                store.addCategoryRule({ pattern, type: 'category', categoryId });
              }
              showToast(`Rule saved for "${pattern}"`, 'success', 4000);
            }
          }

          modal.close();
          window.appRefresh();
        },
      }, isEdit ? 'Save Changes' : 'Add Transaction'),
    ],
  });

  if (focusCategory) setTimeout(() => catSelect.focus(), 50);
}

function formatImportToast(stats) {
  if (!stats.parsed) {
    return 'No transactions found in that file. Make sure it is a bank CSV export with a Date column and data rows.';
  }
  if (stats.count > 0) {
    const parts = [`Imported ${stats.count} transaction${stats.count === 1 ? '' : 's'}`];
    if (stats.income) parts.push(`${stats.income} income`);
    if (stats.expense) parts.push(`${stats.expense} expenses`);
    if (stats.categorized) parts.push(`${stats.categorized} categorized`);
    if (stats.ruleApplied) parts.push(`${stats.ruleApplied} from rules`);
    if (stats.incomeLinked) parts.push(`${stats.incomeLinked} income matched`);
    if (stats.billMatches) parts.push(`${stats.billMatches} bill matches`);
    if (stats.duplicates) parts.push(`${stats.duplicates} duplicates skipped`);
    if (stats.skipped) parts.push(`${stats.skipped} rows skipped`);
    return parts.join(' · ');
  }
  const parts = ['No new transactions imported'];
  if (stats.duplicates) parts.push(`${stats.duplicates} already in your log`);
  if (stats.skipped) parts.push(`${stats.skipped} skipped (pending/cancelled or unparseable)`);
  if (!stats.duplicates && !stats.skipped) {
    parts.push('check that the file has posted transactions with amounts');
  }
  return parts.join(' · ');
}

function openImportDialog() {
  const fileIn = el('input', { type: 'file', accept: '.csv,.CSV,text/csv' });
  const includePendingIn = el('input', { type: 'checkbox', checked: true, id: 'import-pending' });
  const preview = el('div', { style: 'margin-top:1rem;font-size:0.85rem;color:var(--text-muted);line-height:1.6' },
    'Supports USAA, Chase, and most bank exports.',
    el('br'),
    'Positive amount = income, negative amount = expense. Category column maps to envelopes when possible.',
    el('br'),
    'Use Edit or Category on each row to assign envelopes manually.',
    el('br'),
    'Likely duplicates (same amount + similar merchant, within 7 days) are skipped automatically.',
    el('br'),
    el('label', { style: 'display:flex;align-items:center;gap:0.5rem;margin-top:0.75rem;color:var(--text)' },
      includePendingIn, ' Include pending/unposted transactions'
    ),
  );

  const modal = showModal({
    title: 'Import Transactions from CSV',
    body: el('div', {}, fileIn, preview),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Cancel'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const file = fileIn.files[0];
          if (!file) {
            showToast('Choose a CSV file first', 'info');
            return;
          }
          const reader = new FileReader();
          reader.onload = e => {
            try {
              const rows = parseCSV(e.target.result);
              const stats = store.importTransactions(rows, {
                includePending: includePendingIn.checked,
              });
              modal.close();
              const type = stats.count > 0 ? 'success' : 'info';
              showToast(formatImportToast(stats), type, 6000);
              if (stats.count > 0) {
                window.appRefresh();
                if (stats.billMatches > 0) {
                  setTimeout(() => openBillMatches(store.getReviewInbox()), 400);
                } else if (store.getReviewInbox().uncategorized.length > 0) {
                  setTimeout(() => openReviewInbox(store.getReviewInbox()), 400);
                }
              }
            } catch (err) {
              console.error('CSV import failed', err);
              const msg = err?.message?.includes('storage')
                ? err.message
                : 'Import failed. Please try again.';
              showToast(msg, 'info');
            }
          };
          reader.onerror = () => showToast('Could not read that file', 'info');
          reader.readAsText(file);
        },
      }, 'Import'),
    ],
  });
}

function deleteTransaction(id) {
  confirmDialog('Delete Transaction', 'Remove this transaction and reverse its balance impact?', () => {
    store.update(s => {
      const t = s.transactions.find(x => x.id === id);
      if (t) {
        s.balances.checking -= store.getCheckingDelta(t.type, t.amount);
        if (t.type === 'debt_payment' && t.debtId) {
          store.adjustDebtForPayment(s, t.debtId, -Math.abs(Number(t.amount) || 0));
        }
        s.transactions = s.transactions.filter(x => x.id !== id);
      }
    });
    window.appRefresh();
  });
}