import { el, formatCurrency, getCurrentMonth, getMonthLabel, toCSV, downloadFile } from '../utils.js';
import { store } from '../store.js';

export function renderReports(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const categories = state.categories;
  const spentByCategory = categories.map(c => ({
    name: c.name,
    budgeted: Number(c.monthlyBudget) || 0,
    spent: store.getCategorySpent(c.id, month),
    remaining: store.getCategoryRemaining(c.id, month),
  })).filter(c => c.budgeted > 0 || c.spent > 0);

  const totalBudgeted = store.getTotalBudgeted();
  const totalSpent = store.getTotalSpent();
  const income = store.getTotalIncome(month);

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Reports & Insights'),
    el('p', {}, `${getMonthLabel(month)} — Where did my money go?`)
  ));

  container.appendChild(el('div', { className: 'btn-group section' },
    el('button', { className: 'btn btn-secondary', onClick: () => exportCSV(spentByCategory) }, 'Export CSV'),
    el('button', { className: 'btn btn-secondary', onClick: () => window.print() }, 'Print / PDF'),
  ));

  container.appendChild(el('div', { className: 'grid grid-3 section' },
    summaryCard('Income', income, 'accent'),
    summaryCard('Budgeted', totalBudgeted),
    summaryCard('Spent', totalSpent, totalSpent > totalBudgeted ? 'negative' : ''),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Monthly Summary'),
    el('div', { className: 'card' },
      el('p', { style: 'margin-bottom:1rem;line-height:1.7' },
        `This month you planned ${formatCurrency(income)} in income and budgeted ${formatCurrency(totalBudgeted)} across ${categories.length} envelopes. `,
        `You've spent ${formatCurrency(totalSpent)} so far, leaving ${formatCurrency(totalBudgeted - totalSpent)} in your planned budget. `,
        store.getTotalDebt() > 0
          ? `Your debt snowball has ${formatCurrency(store.getTotalDebt())} remaining across ${store.getActiveDebts().length} debts.`
          : 'You are debt free — keep building wealth!'
      )
    )
  ));

  const trends = store.getMonthlyTrends(6);

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, '6-Month Trends'),
    el('div', { className: 'card' },
      el('div', { className: 'chart-container', style: 'height:280px' },
        el('canvas', { id: 'trend-chart' }),
      ),
      el('div', { className: 'table-wrap', style: 'margin-top:1rem' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Month'), el('th', {}, 'Income'), el('th', {}, 'Spent'),
            el('th', {}, 'Budgeted'), el('th', {}, 'Debt Paid'),
          )),
          el('tbody', {},
            ...trends.map(t => el('tr', {},
              el('td', {}, getMonthLabel(t.month)),
              el('td', {}, formatCurrency(t.income)),
              el('td', {}, formatCurrency(t.spent)),
              el('td', {}, formatCurrency(t.budgeted)),
              el('td', {}, formatCurrency(t.debtPaid)),
            )),
          ),
        ),
      ),
    ),
  ));

  const topCats = new Set();
  trends.forEach(t => Object.keys(t.byCategory).forEach(n => topCats.add(n)));
  const topCategoryNames = [...topCats]
    .map(name => ({
      name,
      total: trends.reduce((s, t) => s + (t.byCategory[name] || 0), 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(c => c.name);

  if (topCategoryNames.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, 'Category Trends (Top 5)'),
      el('div', { className: 'card' },
        el('div', { className: 'chart-container', style: 'height:260px' },
          el('canvas', { id: 'category-trend-chart' }),
        ),
      ),
    ));
  }

  container.appendChild(el('div', { className: 'grid grid-2 section' },
    el('div', { className: 'card' },
      el('div', { className: 'section-title' }, 'Spending by Category'),
      el('div', { className: 'chart-container' },
        el('canvas', { id: 'spending-chart' })
      )
    ),
    el('div', { className: 'card' },
      el('div', { className: 'section-title' }, 'Budget vs Actual'),
      el('div', { className: 'chart-container' },
        el('canvas', { id: 'budget-chart' })
      )
    ),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Category Breakdown'),
    el('div', { className: 'card' },
      el('div', { className: 'table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Category'),
            el('th', {}, 'Budgeted'),
            el('th', {}, 'Actual'),
            el('th', {}, 'Difference'),
            el('th', {}, '% Used'),
          )),
          el('tbody', {},
            ...spentByCategory.sort((a, b) => b.spent - a.spent).map(c => el('tr', {},
              el('td', {}, c.name),
              el('td', {}, formatCurrency(c.budgeted)),
              el('td', {}, formatCurrency(c.spent)),
              el('td', { style: `color:${c.remaining >= 0 ? 'var(--positive)' : 'var(--negative)'}` },
                formatCurrency(c.remaining)
              ),
              el('td', {}, c.budgeted > 0 ? `${Math.round((c.spent / c.budgeted) * 100)}%` : '—'),
            ))
          )
        )
      )
    )
  ));

  if (store.getActiveDebts().length || state.archivedDebts?.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, 'Debt Payoff Progress'),
      el('div', { className: 'card' },
        el('div', { className: 'chart-container' },
          el('canvas', { id: 'debt-chart' })
        )
      )
    ));
  }

  requestAnimationFrame(() => {
    renderCharts(spentByCategory, state);
    renderTrendCharts(trends, topCategoryNames);
  });
}

function summaryCard(title, value, cls = '') {
  return el('div', { className: 'card' },
    el('div', { className: 'card-title' }, title),
    el('div', { className: `card-value ${cls}` }, formatCurrency(value))
  );
}

function renderCharts(spentByCategory, state) {
  if (typeof Chart === 'undefined') return;

  const colors = [
    '#1e6b5c', '#3b82c4', '#2d9a83', '#60a5fa', '#5e7d72',
    '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316',
  ];

  const spendingCtx = document.getElementById('spending-chart');
  if (spendingCtx) {
    new Chart(spendingCtx, {
      type: 'doughnut',
      data: {
        labels: spentByCategory.map(c => c.name),
        datasets: [{
          data: spentByCategory.map(c => c.spent),
          backgroundColor: colors,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
      },
    });
  }

  const budgetCtx = document.getElementById('budget-chart');
  if (budgetCtx) {
    const top = spentByCategory.sort((a, b) => b.budgeted - a.budgeted).slice(0, 8);
    new Chart(budgetCtx, {
      type: 'bar',
      data: {
        labels: top.map(c => c.name),
        datasets: [
          { label: 'Budgeted', data: top.map(c => c.budgeted), backgroundColor: '#3b82c4' },
          { label: 'Actual', data: top.map(c => c.spent), backgroundColor: '#1e6b5c' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } },
        plugins: { legend: { position: 'top' } },
      },
    });
  }

  const debtCtx = document.getElementById('debt-chart');
  if (debtCtx) {
    const debts = store.getActiveDebts();
    new Chart(debtCtx, {
      type: 'bar',
      data: {
        labels: debts.map(d => d.name),
        datasets: [{
          label: 'Balance',
          data: debts.map(d => Number(d.balance)),
          backgroundColor: '#8f6f6f',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
      },
    });
  }
}

function renderTrendCharts(trends, topCategoryNames) {
  if (typeof Chart === 'undefined') return;

  const trendCtx = document.getElementById('trend-chart');
  if (trendCtx) {
    new Chart(trendCtx, {
      type: 'line',
      data: {
        labels: trends.map(t => getMonthLabel(t.month).split(' ')[0]),
        datasets: [
          { label: 'Income', data: trends.map(t => t.income), borderColor: '#3b82c4', tension: 0.2 },
          { label: 'Spent', data: trends.map(t => t.spent), borderColor: '#1e6b5c', tension: 0.2 },
          { label: 'Budgeted', data: trends.map(t => t.budgeted), borderColor: '#94a3b8', borderDash: [4, 4], tension: 0.2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  const catCtx = document.getElementById('category-trend-chart');
  if (catCtx && topCategoryNames.length) {
    const colors = ['#1e6b5c', '#3b82c4', '#f59e0b', '#8b5cf6', '#ec4899'];
    new Chart(catCtx, {
      type: 'line',
      data: {
        labels: trends.map(t => getMonthLabel(t.month).split(' ')[0]),
        datasets: topCategoryNames.map((name, i) => ({
          label: name,
          data: trends.map(t => t.byCategory[name] || 0),
          borderColor: colors[i % colors.length],
          tension: 0.2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }
}

function exportCSV(data) {
  const rows = data.map(c => ({
    Category: c.name,
    Budgeted: c.budgeted,
    Actual: c.spent,
    Difference: c.remaining,
  }));
  const csv = toCSV(rows, ['Category', 'Budgeted', 'Actual', 'Difference']);
  downloadFile(csv, `budget-report-${getCurrentMonth()}.csv`, 'text/csv');
}