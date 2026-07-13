import { el, formatCurrency, formatDate, getPreviousMonth, getMonthLabel, getCurrentMonth, emptyState } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';
import { openTransactionForm } from './transactions.js';

const SORT_OPTIONS = [
  { key: 'budgeted', dir: 'desc', label: 'Budgeted (high to low)' },
  { key: 'budgeted', dir: 'asc', label: 'Budgeted (low to high)' },
  { key: 'spent', dir: 'desc', label: 'Spent (high to low)' },
  { key: 'remaining', dir: 'desc', label: 'Remaining (high to low)' },
  { key: 'name', dir: 'asc', label: 'Name (A to Z)' },
  { key: 'name', dir: 'desc', label: 'Name (Z to A)' },
];

function sortOptionValue(key, dir) {
  return `${key}:${dir}`;
}

function parseSortValue(value) {
  const [key, dir] = value.split(':');
  return { key, dir };
}

function sortCategories(cats, sortKey, sortDir) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...cats].sort((a, b) => {
    let va;
    let vb;
    switch (sortKey) {
      case 'spent':
        va = store.getCategorySpent(a.id);
        vb = store.getCategorySpent(b.id);
        break;
      case 'remaining':
        va = store.getCategoryRemaining(a.id);
        vb = store.getCategoryRemaining(b.id);
        break;
      case 'name':
        va = a.name.toLowerCase();
        vb = b.name.toLowerCase();
        break;
      case 'budgeted':
      default:
        va = Number(a.monthlyBudget) || 0;
        vb = Number(b.monthlyBudget) || 0;
        break;
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name);
  });
}

export function renderBudget(container, arg) {
  const state = store.getState();
  const month = getCurrentMonth();
  const income = store.getTotalIncome(month);
  const bonusLogged = store.getBonusIncomeLogged();
  const budgeted = store.getTotalBudgeted();
  const unallocated = store.getToAllocate();
  let viewFilter = (arg && arg.filter === 'attention') ? 'attention' : 'all';

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Envelope Budget'),
    el('p', {}, 'Zero-based budgeting — every dollar has a job · Tap an envelope to see spending')
  ));

  container.appendChild(el('div', { className: 'grid grid-3 section' },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, `Monthly Income — ${getMonthLabel(month)}`),
      el('div', { className: 'card-value accent' }, formatCurrency(income)),
      el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem' },
        'From pay-calendar dates & amounts this month'
      ),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Total Budgeted'),
      el('div', { className: 'card-value' }, formatCurrency(budgeted))
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'To Allocate'),
      el('div', { className: `card-value ${unallocated === 0 ? 'positive' : unallocated > 0 ? 'accent' : 'negative'}` },
        formatCurrency(unallocated)
      ),
      bonusLogged > 0
        ? el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem' },
          `Includes ${formatCurrency(bonusLogged)} bonus income this month`
        )
        : null,
      unallocated === 0 ? el('p', { style: 'font-size:0.75rem;color:var(--positive)' }, '✓ Zero-based budget!') : null
    )
  ));

  const prevMonth = getPreviousMonth();
  const hasSnapshot = !!store.getState().monthBudgetSnapshots[prevMonth];

  const toolsMenu = el('details', { className: 'page-tools-menu' });
  toolsMenu.appendChild(el('summary', { className: 'btn btn-secondary' }, 'Budget tools'));
  const toolsList = el('div', { className: 'page-tools-dropdown' });
  toolsList.appendChild(el('button', {
    type: 'button',
    className: 'page-tools-item',
    onClick: () => { toolsMenu.removeAttribute('open'); addCategory(true); },
  }, '+ Add Sinking Fund'));
  toolsList.appendChild(el('button', {
    type: 'button',
    className: 'page-tools-item',
    onClick: () => { toolsMenu.removeAttribute('open'); fundAllEnvelopes(); },
  }, 'Assign To Allocate evenly'));
  if (hasSnapshot) {
    toolsList.appendChild(el('button', {
      type: 'button',
      className: 'page-tools-item',
      onClick: () => {
        toolsMenu.removeAttribute('open');
        confirmDialog(
          'Copy Last Month\'s Budget',
          `Replace current envelope amounts with ${getMonthLabel(prevMonth)}?`,
          () => {
            if (store.copyBudgetFromMonth(prevMonth)) {
              showToast('Budget copied from last month!');
              window.appRefresh();
            }
          },
        );
      },
    }, 'Copy Last Month'));
  }
  toolsMenu.appendChild(toolsList);

  container.appendChild(el('div', { className: 'btn-group section budget-actions' },
    el('button', { className: 'btn btn-primary', onClick: () => addCategory(false) }, '+ Add Category'),
    el('button', { className: 'btn btn-accent budget-action-secondary', onClick: () => addCategory(true) }, '+ Add Sinking Fund'),
    el('button', { className: 'btn btn-secondary budget-action-secondary', onClick: fundAllEnvelopes }, 'Assign To Allocate evenly'),
    hasSnapshot ? el('button', {
      className: 'btn btn-secondary budget-action-secondary',
      onClick: () => {
        confirmDialog(
          'Copy Last Month\'s Budget',
          `Replace current envelope amounts with ${getMonthLabel(prevMonth)}?`,
          () => {
            if (store.copyBudgetFromMonth(prevMonth)) {
              showToast('Budget copied from last month!');
              window.appRefresh();
            }
          },
        );
      },
    }, 'Copy Last Month') : null,
    toolsMenu,
  ));

  let sortKey = 'budgeted';
  let sortDir = 'desc';

  const sortSelect = el('select', { id: 'env-sort' },
    ...SORT_OPTIONS.map(opt => el('option', {
      value: sortOptionValue(opt.key, opt.dir),
    }, opt.label))
  );
  sortSelect.value = sortOptionValue(sortKey, sortDir);

  const filterBar = el('div', { className: 'chip-bar section' });
  function renderFilterChips() {
    filterBar.innerHTML = '';
    [
      { id: 'all', label: 'All envelopes' },
      { id: 'attention', label: 'Needs attention' },
    ].forEach(opt => {
      filterBar.appendChild(el('button', {
        type: 'button',
        className: `chip${viewFilter === opt.id ? ' active' : ''}`,
        onClick: () => { viewFilter = opt.id; renderFilterChips(); renderGrid(); },
      }, opt.label));
    });
  }
  renderFilterChips();
  container.appendChild(filterBar);

  container.appendChild(el('div', { className: 'toolbar section' },
    el('label', { style: 'font-size:0.85rem;font-weight:600;color:var(--text-muted)' }, 'Sort by'),
    sortSelect,
  ));

  const gridEl = el('div', { className: 'envelope-grid' });
  container.appendChild(gridEl);

  function needsAttention(cat) {
    const health = store.getEnvelopeHealth(cat.id);
    const remaining = store.getCategoryRemaining(cat.id);
    return health === 'over' || health === 'depleted' || health === 'warning' || remaining < 0;
  }

  function renderGrid() {
    let parents = state.categories.filter(c => !c.parentId);
    if (viewFilter === 'attention') parents = parents.filter(needsAttention);
    const sorted = sortCategories(parents, sortKey, sortDir);
    gridEl.innerHTML = '';
    if (!sorted.length) {
      gridEl.appendChild(emptyState(
        '✓',
        viewFilter === 'attention' ? 'All clear' : 'No envelopes',
        viewFilter === 'attention'
          ? 'No envelopes need attention right now.'
          : 'Add a category to start budgeting.',
      ));
      return;
    }
    sorted.forEach(cat => gridEl.appendChild(envelopeCard(cat)));
  }

  sortSelect.addEventListener('change', e => {
    ({ key: sortKey, dir: sortDir } = parseSortValue(e.target.value));
    renderGrid();
  });

  renderGrid();
}

function linkedItems(cat) {
  const debts = store.getDebtsForCategory(cat.id);
  const bills = store.getBillsForCategory(cat.id);
  if (!debts.length && !bills.length) return null;

  const items = [
    ...debts.map(d => `❄️ ${d.name} (${formatCurrency(d.minPayment)}/mo min)`),
    ...bills.map(b => `📋 ${b.name} (${formatCurrency(b.amount)})`),
  ];

  return el('div', { className: 'envelope-linked' },
    el('span', { className: 'envelope-linked-label' }, 'Linked'),
    items.join(' · ')
  );
}

function envelopeCard(cat) {
  const spent = store.getCategorySpent(cat.id);
  const remaining = store.getCategoryRemaining(cat.id);
  const budgeted = Number(cat.monthlyBudget) || 0;
  const carry = Number(cat.carryOver) || 0;
  const isOver = remaining < 0;
  const health = store.getEnvelopeHealth(cat.id);
  const healthLabel = store.getEnvelopeHealthLabel(health);
  const txCount = store.getCategoryTransactions(cat.id).length;

  const card = el('div', {
    className: `envelope-card envelope-${health} envelope-card-clickable`,
    title: 'Click to see transactions for this envelope',
    onClick: (e) => {
      if (e.target.closest('button, a, input, select, textarea, label, summary')) return;
      openEnvelopeActivity(cat);
    },
  },
    el('div', { className: 'envelope-header' },
      el('div', { className: 'envelope-title' },
        el('span', { className: 'envelope-icon' }, cat.icon || '✉️'),
        el('span', { className: 'envelope-name' }, cat.name),
        cat.isSinkingFund ? el('span', { className: 'sinking-tag' }, 'Sinking Fund') : null,
        healthLabel ? el('span', { className: `envelope-health-badge health-${health}` }, healthLabel) : null,
      ),
      el('div', { className: 'btn-group' },
        el('button', { className: 'btn btn-sm btn-secondary', onClick: (e) => { e.stopPropagation(); editCategory(cat); } }, '✏️'),
        el('button', { className: 'btn btn-sm btn-danger', onClick: (e) => { e.stopPropagation(); deleteCategory(cat.id); } }, '×'),
      )
    ),
    el('div', { className: 'envelope-stats' },
      el('div', { className: 'envelope-stat' },
        el('label', {}, 'Budgeted'),
        el('span', {}, formatCurrency(budgeted))
      ),
      el('div', { className: 'envelope-stat envelope-stat-spent' },
        el('label', {}, 'Spent'),
        el('span', {}, formatCurrency(spent)),
        txCount > 0
          ? el('span', { className: 'envelope-tx-hint' }, `${txCount} tx`)
          : null,
      ),
      el('div', { className: 'envelope-stat' },
        el('label', {}, 'Carry-over'),
        el('span', {}, formatCurrency(carry))
      ),
    ),
    el('div', { className: `envelope-remaining ${isOver ? 'over' : 'ok'}` },
      el('span', {}, 'Remaining'),
      el('span', { className: 'amount' }, formatCurrency(remaining))
    ),
    el('div', { className: 'progress-bar', style: 'margin-top:0.5rem' },
      el('div', {
        className: 'progress-fill',
        style: `width:${budgeted > 0 ? Math.min(100, (spent / (budgeted + carry)) * 100) : 0}%;${isOver ? 'background:var(--negative)' : ''}`
      })
    ),
    linkedItems(cat),
    el('button', {
      className: 'btn btn-sm btn-secondary', style: 'width:100%;margin-top:0.75rem',
      onClick: (e) => { e.stopPropagation(); openEnvelopeActivity(cat); },
    }, txCount ? `View ${txCount} transaction${txCount === 1 ? '' : 's'}` : 'View transactions'),
    el('button', {
      className: 'btn btn-sm btn-primary', style: 'width:100%;margin-top:0.5rem',
      onClick: (e) => { e.stopPropagation(); fundEnvelope(cat); },
    }, 'Allocate')
  );

  return card;
}

const ACTIVITY_RANGES = [
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

function rangeLabel(range) {
  if (range === '30d') return 'Last 30 days';
  if (range === 'all') return 'All time';
  return getMonthLabel(getCurrentMonth());
}

export function openEnvelopeActivity(cat, { range: initialRange = 'month' } = {}) {
  let range = initialRange;
  const bodyHost = el('div', {});
  let modal;

  function paint() {
    const txs = store.getCategoryTransactions(cat.id, { range });
    const total = txs.reduce((s, t) => s + (Number(t.envelopeAmount) || 0), 0);
    const list = el('div', { className: 'envelope-activity-list' });

    if (!txs.length) {
      list.appendChild(emptyState(
        '📝',
        'No spending yet',
        `Nothing charged to ${cat.name} in this range. Log an expense or import a CSV.`,
      ));
    } else {
      txs.forEach(t => {
        const isPending = store.isPending?.(t);
        const isSplit = store.isSplitTransaction(t);
        list.appendChild(el('div', { className: 'envelope-activity-row' },
          el('div', { className: 'envelope-activity-main' },
            el('div', { className: 'envelope-activity-top' },
              el('strong', {}, formatDate(t.date)),
              el('span', { className: 'envelope-activity-amt' }, formatCurrency(t.envelopeAmount)),
            ),
            el('div', { className: 'envelope-activity-desc' }, t.description || '—'),
            el('div', { className: 'envelope-activity-meta' },
              t.type === 'debt_payment' ? 'Debt payment' : 'Expense',
              isSplit ? ' · Split' : '',
              isPending ? ' · Pending' : '',
              t.envelopeAmount !== Math.abs(Number(t.amount))
                ? ` · of ${formatCurrency(t.amount)} total`
                : '',
            ),
          ),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-secondary',
            onClick: () => {
              modal?.close();
              openTransactionForm({ transaction: t });
            },
          }, 'Edit'),
        ));
      });
      list.appendChild(el('div', { className: 'envelope-activity-total' },
        el('span', {}, 'Total'),
        el('strong', {}, formatCurrency(total)),
      ));
    }

    const chips = el('div', { className: 'chip-bar' },
      ...ACTIVITY_RANGES.map(opt => el('button', {
        type: 'button',
        className: `chip${range === opt.id ? ' active' : ''}`,
        onClick: () => { range = opt.id; paint(); },
      }, opt.label)),
    );

    bodyHost.innerHTML = '';
    bodyHost.appendChild(chips);
    bodyHost.appendChild(el('p', { className: 'envelope-activity-summary' },
      `${rangeLabel(range)} · ${formatCurrency(total)} · ${txs.length} transaction${txs.length === 1 ? '' : 's'}`,
    ));
    bodyHost.appendChild(list);
  }

  paint();

  modal = showModal({
    title: `${cat.icon || '✉️'} ${cat.name}`,
    body: bodyHost,
    footer: [
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => modal.close(),
      }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-accent',
        onClick: () => {
          modal.close();
          openTransactionForm({ type: 'expense', categoryId: cat.id });
        },
      }, '+ Log expense'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          modal.close();
          window.appNavigate('transactions', { categoryId: cat.id });
        },
      }, 'Open in Transactions'),
    ],
  });
  modal.modal.classList.add('modal-wide');
}

function fundEnvelope(cat) {
  const toAllocate = store.getToAllocate();
  const input = el('input', {
    type: 'number',
    step: '0.01',
    min: 0,
    value: toAllocate > 0 ? String(Math.round(Math.min(toAllocate, 50) * 100) / 100) : '0',
  });
  showModal({
    title: `Allocate: ${cat.name}`,
    body: el('div', {},
      el('p', {
        className: 'tx-form-hint',
        style: 'margin-bottom:1rem',
      },
        'This gives dollars a job in this envelope. Money stays in your bank checking — only the budget assignment changes.',
      ),
      el('p', {
        style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem',
      }, `To Allocate right now: ${formatCurrency(toAllocate)}`),
      el('div', { className: 'form-group' },
        el('label', {}, 'Amount to assign'),
        input,
      ),
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        const amt = Number(input.value);
        if (!(amt > 0)) {
          showToast('Enter an amount greater than zero', 'info');
          return;
        }
        store.fundEnvelope(cat.id, amt);
        this.closest('.modal-backdrop').remove();
        showToast(`Assigned ${formatCurrency(amt)} to ${cat.name}`);
        window.appRefresh();
      }
    }, 'Assign'),
  });
}

function fundAllEnvelopes() {
  const unallocated = store.getUnallocatedFunds();
  if (unallocated <= 0) {
    showToast('Nothing left to allocate — To Allocate is already $0 or negative', 'info');
    return;
  }
  const cats = store.getState().categories.filter(c => !c.parentId);
  if (!cats.length) {
    showToast('Add envelopes first', 'info');
    return;
  }
  confirmDialog(
    'Assign To Allocate evenly',
    `Split ${formatCurrency(unallocated)} across ${cats.length} envelopes as monthly budget? Checking balance will not change.`,
    () => {
      const each = unallocated / cats.length;
      store.update(s => {
        cats.forEach(c => {
          const cat = s.categories.find(x => x.id === c.id);
          if (cat) cat.monthlyBudget = (Number(cat.monthlyBudget) || 0) + each;
        });
      });
      showToast('To Allocate assigned across envelopes');
      window.appRefresh();
    },
  );
}

function sinkingFundToggle(checked) {
  const input = el('input', { type: 'checkbox' });
  if (checked) input.checked = true;
  const row = el('div', { className: 'form-option' },
    el('div', { className: 'form-option-text' },
      el('span', { className: 'form-option-label' }, 'Sinking fund'),
      el('span', { className: 'form-option-hint' }, 'Save up over time for periodic expenses'),
    ),
    el('label', { className: 'toggle-switch' },
      input,
      el('span', { className: 'toggle-slider' }),
    ),
  );
  return { row, input };
}

function addCategory(isSinking) {
  const nameIn = el('input', { type: 'text', placeholder: 'Category name' });
  const budgetIn = el('input', { type: 'number', step: '0.01', min: 0, value: 0 });
  const iconIn = el('input', { type: 'text', placeholder: 'Icon (emoji)', value: isSinking ? '🎯' : '📁' });
  const { row: sinkingRow, input: sinkingIn } = sinkingFundToggle(isSinking);

  showModal({
    title: 'Add Envelope',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Icon'), iconIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Monthly Budget'), budgetIn),
      ),
      sinkingRow,
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        if (!nameIn.value.trim()) return;
        store.update(s => {
          s.categories.push({
            id: crypto.randomUUID(),
            name: nameIn.value.trim(),
            icon: iconIn.value || '📁',
            parentId: null,
            isSinkingFund: sinkingIn.checked,
            monthlyBudget: Number(budgetIn.value),
            carryOver: 0,
          });
        });
        this.closest('.modal-backdrop').remove();
        showToast('Envelope added!');
        window.appRefresh();
      }
    }, 'Add'),
  });
}

function editCategory(cat) {
  const nameIn = el('input', { type: 'text', value: cat.name });
  const budgetIn = el('input', { type: 'number', step: '0.01', value: cat.monthlyBudget });
  const iconIn = el('input', { type: 'text', value: cat.icon || '' });
  const { row: sinkingRow, input: sinkingIn } = sinkingFundToggle(cat.isSinkingFund);

  showModal({
    title: 'Edit Envelope',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Icon'), iconIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Monthly Budget'), budgetIn),
      ),
      sinkingRow,
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        store.update(s => {
          const c = s.categories.find(x => x.id === cat.id);
          if (c) {
            c.name = nameIn.value;
            c.icon = iconIn.value;
            c.monthlyBudget = Number(budgetIn.value);
            c.isSinkingFund = sinkingIn.checked;
          }
        });
        this.closest('.modal-backdrop').remove();
        window.appRefresh();
      }
    }, 'Save'),
  });
}

function deleteCategory(id) {
  confirmDialog('Delete Category', 'Remove this category? Transactions will be unlinked.', () => {
    store.removeCategory(id);
    window.appRefresh();
  });
}