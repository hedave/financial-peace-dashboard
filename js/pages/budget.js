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
  const focusId = arg?.focusId || arg?.categoryId || null;
  let viewFilter = (arg && arg.filter === 'attention') ? 'attention' : 'all';
  // Focusing a specific envelope: show all so the card is visible
  if (focusId) viewFilter = 'all';

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
      unallocated === 0 ? el('p', { style: 'font-size:0.75rem;color:var(--positive)' }, '✓ Zero-based budget!') : null,
      unallocated !== 0 && store.isDaveRamseyMode()
        ? el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem' },
          unallocated > 0 ? 'Ramsey mode: assign the rest until $0' : 'Ramsey mode: over-assigned vs income')
        : null,
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
    return health === 'over' || health === 'depleted' || health === 'warning'
      || remaining < 0 || store.isOverSoftCap(cat.id);
  }

  function renderGrid() {
    let parents = state.categories.filter(c => !c.parentId);
    if (viewFilter === 'attention') parents = parents.filter(needsAttention);
    let sorted = sortCategories(parents, sortKey, sortDir);
    // Pin focused envelope to the top when deep-linking from Advisor
    if (focusId) {
      const idx = sorted.findIndex(c => c.id === focusId);
      if (idx > 0) {
        const [hit] = sorted.splice(idx, 1);
        sorted = [hit, ...sorted];
      }
    }
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
    sorted.forEach(cat => gridEl.appendChild(envelopeCard(cat, focusId)));
  }

  sortSelect.addEventListener('change', e => {
    ({ key: sortKey, dir: sortDir } = parseSortValue(e.target.value));
    renderGrid();
  });

  renderGrid();

  if (focusId) {
    requestAnimationFrame(() => {
      const node = gridEl.querySelector(`[data-category-id="${focusId}"]`);
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
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

function goalBlock(cat) {
  const progress = store.getGoalProgress(cat.id);
  if (!progress) return null;
  const label = progress.isSinking ? 'Savings goal' : 'Soft cap';
  const over = progress.over;
  return el('div', { className: `envelope-goal${over ? ' over-cap' : ''}` },
    el('div', { className: 'envelope-goal-head' },
      el('span', {}, label),
      el('strong', {},
        over
          ? `${formatCurrency(progress.budgeted)} / ${formatCurrency(progress.goal)} over`
          : `${formatCurrency(progress.pool)} / ${formatCurrency(progress.goal)}`,
      ),
    ),
    el('div', { className: 'progress-bar envelope-goal-bar' },
      el('div', {
        className: 'progress-fill',
        style: `width:${progress.pct}%;${over ? 'background:var(--negative)' : 'background:var(--accent)'}`,
      }),
    ),
    over
      ? el('span', { className: 'envelope-health-badge health-over' }, progress.isSinking ? 'Over goal' : 'Over cap')
      : el('span', { className: 'envelope-goal-pct' }, `${progress.pct}% toward ${progress.isSinking ? 'goal' : 'cap'}`),
  );
}

function envelopeCard(cat, focusId = null) {
  const spent = store.getCategorySpent(cat.id);
  const remaining = store.getCategoryRemaining(cat.id);
  const budgeted = Number(cat.monthlyBudget) || 0;
  const carry = Number(cat.carryOver) || 0;
  const isOver = remaining < 0;
  const health = store.getEnvelopeHealth(cat.id);
  const healthLabel = store.getEnvelopeHealthLabel(health);
  const txCount = store.getCategoryTransactions(cat.id).length;
  const overCap = store.isOverSoftCap(cat.id);
  const isFocused = focusId && cat.id === focusId;
  // Same formula for every card: spent / available pool (budget + carry)
  const pool = budgeted + carry;
  let usedPct = 0;
  if (pool > 0.005) usedPct = Math.min(100, (spent / pool) * 100);
  else if (spent > 0) usedPct = 100; // spent with no plan still shows full bar (over)
  if (isOver) usedPct = 100;

  const card = el('div', {
    className: `envelope-card envelope-${health}${overCap ? ' envelope-over-cap' : ''} envelope-card-clickable${isFocused ? ' envelope-card-focus' : ''}`,
    'data-category-id': cat.id,
    title: isFocused ? 'Focused from Advisor' : 'Click to see transactions for this envelope',
    onClick: (e) => {
      if (e.target.closest('button, a, input, select, textarea, label, summary')) return;
      openEnvelopeActivity(cat);
    },
  },
    el('div', { className: 'envelope-card-top' },
      el('div', { className: 'envelope-header' },
        el('div', { className: 'envelope-title' },
          el('span', { className: 'envelope-icon' }, cat.icon || '✉️'),
          el('span', { className: 'envelope-name' }, cat.name),
          cat.isSinkingFund ? el('span', { className: 'sinking-tag' }, 'Sinking Fund') : null,
          healthLabel ? el('span', { className: `envelope-health-badge health-${health}` }, healthLabel) : null,
          overCap ? el('span', { className: 'envelope-health-badge health-over' }, cat.isSinkingFund ? 'Over goal' : 'Over cap') : null,
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
      // Fixed-height track on every card so bars line up and look even
      el('div', {
        className: 'progress-bar envelope-progress',
        title: pool > 0
          ? `${Math.round(usedPct)}% of ${formatCurrency(pool)} used`
          : (spent > 0 ? 'Spending with no budget set' : 'No budget set'),
      },
        el('div', {
          className: `progress-fill${isOver || (pool <= 0 && spent > 0) ? ' progress-fill-over' : ''}`,
          style: `width:${usedPct}%`,
        }),
      ),
      el('div', { className: 'envelope-progress-meta' },
        pool > 0 || spent > 0
          ? `${Math.round(usedPct)}% used`
          : 'No budget set',
      ),
      el('div', { className: 'envelope-card-mid' },
        goalBlock(cat),
        linkedItems(cat),
      ),
    ),
    el('div', { className: 'envelope-card-footer' },
      el('button', {
        className: 'btn btn-sm btn-secondary', style: 'width:100%',
        onClick: (e) => { e.stopPropagation(); openEnvelopeActivity(cat); },
      }, txCount ? `View ${txCount} transaction${txCount === 1 ? '' : 's'}` : 'View transactions'),
      el('button', {
        className: 'btn btn-sm btn-primary', style: 'width:100%;margin-top:0.5rem',
        onClick: (e) => { e.stopPropagation(); fundEnvelope(cat); },
      }, 'Allocate'),
      cat.note && String(cat.note).trim()
        ? el('div', { className: 'envelope-note' },
          el('span', { className: 'envelope-note-label' }, 'Note'),
          el('p', { className: 'envelope-note-text' }, String(cat.note).trim()),
        )
        : null,
    ),
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
  let editingNote = false;
  const bodyHost = el('div', {});
  let modal;

  function saveNote(text) {
    store.setEnvelopeNote(cat.id, text);
    editingNote = false;
    showToast(String(text || '').trim() ? 'Envelope note saved' : 'Envelope note cleared', 'success');
    paint();
    // Refresh cards behind the modal without losing this view
    // (store subscribe re-renders pages; re-open paint is enough for note)
  }

  function paint() {
    const txs = store.getCategoryTransactions(cat.id, { range });
    // Activity total: spending only (gifts listed separately as income rows)
    const spendTotal = txs
      .filter(t => t.type === 'expense' || t.type === 'debt_payment')
      .reduce((s, t) => s + (Number(t.envelopeAmount) || 0), 0);
    const list = el('div', { className: 'envelope-activity-list' });

    if (!txs.length) {
      list.appendChild(emptyState(
        '📝',
        'No activity yet',
        `Nothing charged to ${cat.name} in this range. Log an expense, gift, or import a CSV.`,
      ));
    } else {
      txs.forEach(t => {
        const isPending = store.isPending?.(t);
        const isSplit = store.isSplitTransaction(t);
        const memo = String(t.memo || '').trim();
        list.appendChild(el('div', { className: 'envelope-activity-row' },
          el('div', { className: 'envelope-activity-main' },
            el('div', { className: 'envelope-activity-top' },
              el('strong', {}, formatDate(t.date)),
              el('span', { className: 'envelope-activity-amt' }, formatCurrency(t.envelopeAmount)),
            ),
            el('div', { className: 'envelope-activity-desc' }, t.description || '—'),
            memo
              ? el('div', { className: 'envelope-activity-memo' }, memo)
              : null,
            el('div', { className: 'envelope-activity-meta' },
              t.type === 'debt_payment' ? 'Debt payment' : (t.type === 'income' ? 'Income / gift' : 'Expense'),
              isSplit ? ' · Split' : '',
              isPending ? ' · Pending' : '',
              t.earmarkedEnvelope ? ' · Earmarked gift' : '',
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
        el('span', {}, 'Spent'),
        el('strong', {}, formatCurrency(spendTotal)),
      ));
    }

    const chips = el('div', { className: 'chip-bar' },
      ...ACTIVITY_RANGES.map(opt => el('button', {
        type: 'button',
        className: `chip${range === opt.id ? ' active' : ''}`,
        onClick: () => { range = opt.id; paint(); },
      }, opt.label)),
    );

    const live = store.getState().categories.find(c => c.id === cat.id) || cat;
    const noteText = String(live.note || '').trim();
    const noteBox = el('div', { className: 'envelope-note envelope-note-in-modal envelope-note-editable' });

    if (editingNote) {
      const ta = el('textarea', {
        className: 'envelope-note-editor',
        rows: 3,
        placeholder: 'e.g. $20 from Grandma for Emma’s birthday — don’t mix with allowance',
      });
      ta.value = noteText;
      noteBox.appendChild(el('span', { className: 'envelope-note-label' }, 'Envelope note'));
      noteBox.appendChild(ta);
      noteBox.appendChild(el('div', { className: 'btn-group', style: 'margin-top:0.5rem;flex-wrap:wrap;gap:0.35rem' },
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-primary',
          onClick: () => saveNote(ta.value),
        }, 'Save note'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => { editingNote = false; paint(); },
        }, 'Cancel'),
        noteText
          ? el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => {
              confirmDialog(
                'Clear envelope note?',
                'This removes the general note on this envelope. Transaction memos are unchanged. You can add a new note anytime.',
                () => saveNote(''),
              );
            },
          }, 'Clear note')
          : null,
      ));
      setTimeout(() => ta.focus(), 30);
    } else if (noteText) {
      noteBox.appendChild(el('div', { className: 'envelope-note-head' },
        el('span', { className: 'envelope-note-label' }, 'Envelope note'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-secondary',
          onClick: () => { editingNote = true; paint(); },
        }, 'Edit'),
      ));
      noteBox.appendChild(el('p', { className: 'envelope-note-text' }, noteText));
      noteBox.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        style: 'margin-top:0.45rem',
        onClick: () => {
          confirmDialog(
            'Clear envelope note?',
            'Removes this note only — gift money and transactions stay as they are.',
            () => saveNote(''),
          );
        },
      }, 'Clear note'));
    } else {
      noteBox.appendChild(el('span', { className: 'envelope-note-label' }, 'Envelope note'));
      noteBox.appendChild(el('p', {
        className: 'envelope-note-text',
        style: 'color:var(--text-muted);font-style:italic',
      }, 'No note yet — for gift money context, kid reminders, etc.'));
      noteBox.appendChild(el('button', {
        type: 'button',
        className: 'btn btn-sm btn-primary',
        style: 'margin-top:0.45rem',
        onClick: () => { editingNote = true; paint(); },
      }, '+ Add note'));
    }

    bodyHost.innerHTML = '';
    bodyHost.appendChild(noteBox);
    bodyHost.appendChild(chips);
    bodyHost.appendChild(el('p', { className: 'envelope-activity-summary' },
      `${rangeLabel(range)} · spent ${formatCurrency(spendTotal)} · ${txs.length} item${txs.length === 1 ? '' : 's'}`,
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
        onClick: () => {
          modal.close();
          window.appRefresh();
        },
      }, 'Close'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          modal.close();
          openTransactionForm({ type: 'expense', categoryId: cat.id });
        },
      }, '+ Log expense'),
      el('button', {
        type: 'button',
        className: 'btn btn-secondary',
        onClick: () => {
          modal.close();
          window.appNavigate('transactions', { categoryId: cat.id });
        },
      }, 'Open in Transactions'),
    ],
  });
  modal.modal.classList.add('modal-wide', 'modal-scrollable');
}

function doFundEnvelope(cat, amt) {
  store.fundEnvelope(cat.id, amt);
  showToast(`Assigned ${formatCurrency(amt)} to ${cat.name}`);
  window.appRefresh();
}

function fundEnvelope(cat) {
  const toAllocate = store.getToAllocate();
  const goal = store.getCategoryGoal(cat.id);
  const budgeted = Number(cat.monthlyBudget) || 0;
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
      goal > 0
        ? el('p', {
          style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem',
        }, `${cat.isSinkingFund ? 'Goal' : 'Soft cap'}: ${formatCurrency(goal)} · currently budgeted ${formatCurrency(budgeted)}`)
        : null,
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
        const backdrop = this.closest('.modal-backdrop');
        const nextBudget = budgeted + amt;
        const assign = () => {
          backdrop?.remove();
          doFundEnvelope(cat, amt);
        };
        if (goal > 0 && nextBudget > goal + 0.005) {
          confirmDialog(
            cat.isSinkingFund ? 'Over savings goal' : 'Over soft cap',
            `This puts ${cat.name} at ${formatCurrency(nextBudget)} (cap/goal ${formatCurrency(goal)}). Assign anyway?`,
            assign,
          );
          return;
        }
        assign();
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

function goalField(isSinking, value = 0) {
  const input = el('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    placeholder: 'e.g. 400',
  });
  // Set value after create — empty string for “no cap” so the field is clearly editable
  const n = Number(value);
  input.value = n > 0 ? String(n) : '';
  const row = el('div', { className: 'form-group' },
    el('label', {}, isSinking ? 'Savings goal (optional)' : 'Soft cap (optional)'),
    input,
    el('p', { className: 'tx-form-hint', style: 'margin-top:0.35rem;margin-bottom:0' },
      isSinking
        ? 'Target to save toward (e.g. Christmas $800). Soft warning if you assign more than the goal.'
        : 'Optional max for this envelope (e.g. $400 on Eating Out). Leave blank for no cap. Soft warning only.',
    ),
  );
  return { row, input };
}

function parseGoalInput(input) {
  const raw = String(input?.value ?? '').trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function noteField(value = '') {
  const input = el('textarea', {
    rows: 3,
    placeholder: 'e.g. $20 from Grandma for Emma’s birthday — don’t mix with allowance',
    value: value || '',
    style: 'width:100%;resize:vertical;min-height:4rem',
  });
  // textarea value via attribute may not stick in all browsers through el()
  input.value = value || '';
  const row = el('div', { className: 'form-group' },
    el('label', {}, 'Note (optional)'),
    input,
    el('p', { className: 'tx-form-hint', style: 'margin-top:0.35rem;margin-bottom:0' },
      'Shows on the envelope card and activity — gift money, kid context, reminders for your spouse.',
    ),
  );
  return { row, input };
}

function addCategory(isSinking) {
  const nameIn = el('input', { type: 'text', placeholder: 'Category name' });
  const budgetIn = el('input', { type: 'number', step: '0.01', min: 0, value: 0 });
  const iconIn = el('input', { type: 'text', placeholder: 'Icon (emoji)', value: isSinking ? '🎯' : '📁' });
  const { row: sinkingRow, input: sinkingIn } = sinkingFundToggle(isSinking);
  const { row: goalRow, input: goalIn } = goalField(isSinking, 0);
  const { row: noteRow, input: noteIn } = noteField('');

  sinkingIn.addEventListener('change', () => {
    const label = goalRow.querySelector('label');
    const hint = goalRow.querySelector('.tx-form-hint');
    if (label) label.textContent = sinkingIn.checked ? 'Savings goal (optional)' : 'Soft cap (optional)';
    if (hint) {
      hint.textContent = sinkingIn.checked
        ? 'Target to save toward (e.g. Christmas $800). Warns if you assign more than the goal.'
        : 'Max you want budgeted here. Soft warning only — you can still override.';
    }
  });

  showModal({
    title: 'Add Envelope',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Icon'), iconIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Monthly Budget'), budgetIn),
      ),
      goalRow,
      noteRow,
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
            goalAmount: parseGoalInput(goalIn),
            note: noteIn.value.trim(),
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
  const budgetIn = el('input', { type: 'number', step: '0.01', min: '0' });
  budgetIn.value = String(Number(cat.monthlyBudget) || 0);
  const iconIn = el('input', { type: 'text', value: cat.icon || '' });
  const { row: sinkingRow, input: sinkingIn } = sinkingFundToggle(cat.isSinkingFund);
  const { row: goalRow, input: goalIn } = goalField(cat.isSinkingFund, Number(cat.goalAmount) || 0);
  const { row: noteRow, input: noteIn } = noteField(cat.note || '');

  sinkingIn.addEventListener('change', () => {
    const label = goalRow.querySelector('label');
    const hint = goalRow.querySelector('.tx-form-hint');
    if (label) label.textContent = sinkingIn.checked ? 'Savings goal (optional)' : 'Soft cap (optional)';
    if (hint) {
      hint.textContent = sinkingIn.checked
        ? 'Target to save toward (e.g. Christmas $800). Soft warning if you assign more than the goal.'
        : 'Optional max for this envelope. Leave blank for no cap. Soft warning only.';
    }
  });

  showModal({
    title: 'Edit Envelope',
    body: el('div', {},
      el('div', { className: 'form-group' }, el('label', {}, 'Name'), nameIn),
      el('div', { className: 'input-row' },
        el('div', { className: 'form-group' }, el('label', {}, 'Icon'), iconIn),
        el('div', { className: 'form-group' }, el('label', {}, 'Monthly Budget'), budgetIn),
      ),
      goalRow,
      noteRow,
      sinkingRow,
    ),
    footer: el('button', {
      className: 'btn btn-primary',
      onClick: function() {
        const nextBudget = Number(budgetIn.value) || 0;
        const nextGoal = parseGoalInput(goalIn);
        const backdrop = this.closest('.modal-backdrop');
        // Always save — including soft cap — even if currently over the cap
        store.update(s => {
          const c = s.categories.find(x => x.id === cat.id);
          if (c) {
            c.name = nameIn.value.trim() || c.name;
            c.icon = iconIn.value;
            c.monthlyBudget = nextBudget;
            c.isSinkingFund = sinkingIn.checked;
            c.goalAmount = nextGoal;
            c.note = noteIn.value.trim();
          }
        });
        backdrop?.remove();
        if (nextGoal > 0 && nextBudget > nextGoal + 0.005) {
          showToast(
            `Saved. Note: budgeted ${formatCurrency(nextBudget)} is above the ${sinkingIn.checked ? 'goal' : 'soft cap'} of ${formatCurrency(nextGoal)}.`,
            'info',
            5000,
          );
        } else if (nextGoal > 0) {
          showToast(
            sinkingIn.checked
              ? `Saved · goal ${formatCurrency(nextGoal)}`
              : `Saved · soft cap ${formatCurrency(nextGoal)}`,
            'success',
          );
        } else {
          showToast('Envelope saved');
        }
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