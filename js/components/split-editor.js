import { el, formatCurrency } from '../utils.js';

function buildCategorySelect(categories, value = '') {
  const select = el('select');
  select.appendChild(el('option', { value: '' }, '— Envelope —'));
  categories.forEach(c => {
    select.appendChild(el('option', { value: c.id }, `${c.icon || ''} ${c.name}`.trim()));
  });
  if (value) select.value = value;
  return select;
}

export function createSplitEditor(categories, {
  totalAmount = 0,
  initialSplits = null,
} = {}) {
  const host = el('div', { className: 'split-editor' });
  const remainderEl = el('div', { className: 'split-remainder' });
  let rows = [];

  function seedRows() {
    if (initialSplits?.length) {
      return initialSplits.map(s => ({
        categoryId: s.categoryId || '',
        amount: String(s.amount ?? ''),
      }));
    }
    return [
      { categoryId: '', amount: '' },
      { categoryId: '', amount: '' },
    ];
  }

  let splitData = seedRows();

  function getTotal() {
    return Math.abs(Number(totalAmount)) || 0;
  }

  function allocatedAmount() {
    return splitData.reduce((sum, row) => sum + (Math.abs(Number(row.amount)) || 0), 0);
  }

  function updateRemainder() {
    const total = getTotal();
    const allocated = allocatedAmount();
    const left = Math.round((total - allocated) * 100) / 100;
    remainderEl.textContent = total
      ? `${formatCurrency(allocated)} of ${formatCurrency(total)} assigned${
        left === 0 ? ' — balanced' : ` — ${formatCurrency(Math.abs(left))} ${left > 0 ? 'left' : 'over'}`
      }`
      : 'Enter the transaction amount first';
    remainderEl.className = `split-remainder${left === 0 && total > 0 ? ' balanced' : ''}`;
  }

  function syncRow(index) {
    const row = rows[index];
    if (!row) return;
    splitData[index].categoryId = row.catSelect.value;
    splitData[index].amount = row.amountIn.value;
    updateRemainder();
  }

  function render() {
    host.innerHTML = '';
    rows = [];

    splitData.forEach((row, index) => {
      const catSelect = buildCategorySelect(categories, row.categoryId);
      const amountIn = el('input', {
        type: 'number',
        step: '0.01',
        min: 0,
        placeholder: '0.00',
        value: row.amount,
      });

      catSelect.addEventListener('change', () => syncRow(index));
      amountIn.addEventListener('input', () => syncRow(index));

      const removeBtn = splitData.length > 2
        ? el('button', {
          type: 'button',
          className: 'btn btn-sm btn-danger split-remove',
          title: 'Remove line',
          onClick: () => {
            splitData.splice(index, 1);
            render();
          },
        }, '×')
        : null;

      const rowEl = el('div', { className: 'split-row' },
        el('div', { className: 'split-row-category' }, catSelect),
        el('div', { className: 'split-row-amount' }, amountIn),
        removeBtn,
      );

      rows.push({ catSelect, amountIn });
      host.appendChild(rowEl);
    });

    host.appendChild(el('div', { className: 'split-editor-actions' },
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => {
          splitData.push({ categoryId: '', amount: '' });
          render();
        },
      }, '+ Add line'),
      getTotal() >= 2 ? el('button', {
        type: 'button',
        className: 'btn btn-sm btn-secondary',
        onClick: () => {
          const total = getTotal();
          const count = splitData.length;
          const each = Math.round((total / count) * 100) / 100;
          let assigned = 0;
          splitData = splitData.map((row, i) => {
            const amt = i === count - 1
              ? Math.round((total - assigned) * 100) / 100
              : each;
            assigned += amt;
            return { ...row, amount: amt ? String(amt) : '' };
          });
          render();
        },
      }, 'Split evenly') : null,
    ));

    host.appendChild(remainderEl);
    updateRemainder();
  }

  render();

  return {
    element: host,
    setTotalAmount(amount) {
      totalAmount = amount;
      updateRemainder();
    },
    getSplits() {
      return splitData.map(row => ({
        categoryId: row.categoryId || null,
        amount: Math.abs(Number(row.amount)) || 0,
      }));
    },
    isValid() {
      const total = getTotal();
      if (!total) return false;
      return splitData.every(row => row.categoryId && Number(row.amount) > 0)
        && Math.abs(allocatedAmount() - total) < 0.01;
    },
    refresh: render,
  };
}