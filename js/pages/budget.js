import { el, formatCurrency, getPreviousMonth, getMonthLabel, getCurrentMonth } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast, confirmDialog } from '../components/modal.js';

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

export function renderBudget(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const income = store.getTotalIncome(month);
  const bonusLogged = store.getBonusIncomeLogged();
  const budgeted = store.getTotalBudgeted();
  const unallocated = store.getToAllocate();

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Envelope Budget'),
    el('p', {}, 'Zero-based budgeting — every dollar has a job')
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

  container.appendChild(el('div', { className: 'btn-group section' },
    el('button', { className: 'btn btn-primary', onClick: () => addCategory(false) }, '+ Add Category'),
    el('button', { className: 'btn btn-accent', onClick: () => addCategory(true) }, '+ Add Sinking Fund'),
    el('button', { className: 'btn btn-secondary', onClick: fundAllEnvelopes }, 'Fund All from Checking'),
    hasSnapshot ? el('button', {
      className: 'btn btn-secondary',
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
  ));

  let sortKey = 'budgeted';
  let sortDir = 'desc';

  const sortSelect = el('select', { id: 'env-sort' },
    ...SORT_OPTIONS.map(opt => el('option', {
      value: sortOptionValue(opt.key, opt.dir),
    }, opt.label))
  );
  sortSelect.value = sortOptionValue(sortKey, sortDir);

  container.appendChild(el('div', { className: 'toolbar section' },
    el('label', { style: 'font-size:0.85rem;font-weight:600;color:var(--text-muted)' }, 'Sort by'),
    sortSelect,
  ));

  const gridEl = el('div', { className: 'envelope-grid' });
  container.appendChild(gridEl);

  function renderGrid() {
    const parents = state.categories.filter(c => !c.parentId);
    const sorted = sortCategories(parents, sortKey, sortDir);
    gridEl.innerHTML = '';
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

  const card = el('div', { className: `envelope-card envelope-${health}` },
    el('div', { className: 'envelope-header' },
      el('div', { className: 'envelope-title' },
        el('span', { className: 'envelope-icon' }, cat.icon || '✉️'),
        el('span', { className: 'envelope-name' }, cat.name),
        cat.isSinkingFund ? el('span', { className: 'sinking-tag' }, 'Sinking Fund') : null,
        healthLabel ? el('span', { className: `envelope-health-badge health-${health}` }, healthLabel) : null,
      ),
      el('div', { className: 'btn-group' },
        el('button', { className: 'btn btn-sm btn-secondary', onClick: () => editCategory(cat) }, '✏️'),
        el('button', { className: 'btn btn-sm btn-danger', onClick: () => deleteCategory(cat.id) }, '×'),
      )
    ),
    el('div', { className: 'envelope-stats' },
      el('div', { className: 'envelope-stat' },
        el('label', {}, 'Budgeted'),
        el('span', {}, formatCurrency(budgeted))
      ),
      el('div', { className: 'envelope-stat' },
        el('label', {}, 'Spent'),
        el('span', {}, formatCurrency(spent))
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
      className: 'btn btn-sm btn-primary', style: 'width:100%;margin-top:0.75rem',
      onClick: () => fundEnvelope(cat)
    }, 'Fund Envelope')
  );

  return card;
}

function fundEnvelope(cat) {
  const input = el('input', { type: 'number', step: '0.01', min: 0, value: 0 });
  showModal({
    title: `Fund: ${cat.name}`,
    body: el('div', { className: 'form-group' },
      el('label', {}, 'Amount from checking'),
      input
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        store.fundEnvelope(cat.id, Number(input.value));
        this.closest('.modal-backdrop').remove();
        showToast(`Funded ${cat.name}!`);
        window.appRefresh();
      }
    }, 'Fund'),
  });
}

function fundAllEnvelopes() {
  const unallocated = store.getUnallocatedFunds();
  if (unallocated <= 0) {
    showToast('No unallocated funds to distribute', 'info');
    return;
  }
  confirmDialog('Fund All Envelopes', `Distribute ${formatCurrency(unallocated)} evenly across all categories?`, () => {
    const cats = store.getState().categories;
    const each = unallocated / cats.length;
    store.update(s => {
      cats.forEach(c => {
        const cat = s.categories.find(x => x.id === c.id);
        if (cat) cat.carryOver = (Number(cat.carryOver) || 0) + each;
      });
      s.balances.checking -= unallocated;
    });
    showToast('Envelopes funded!');
    window.appRefresh();
  });
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