import { el, formatCurrency, getCurrentMonth, getPreviousMonth, getMonthLabel, toCSV, downloadFile } from '../utils.js';
import { store } from '../store.js';

/** Trend window for the 6-month section (display only; reads existing monthly trends). */
let trendMonths = 6;
const PERIODS = [[3, '3M'], [6, '6M'], [12, '1Y']];

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Chart.js defaults from the design tokens (R2). */
function applyChartTheme() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = cssVar('--text-muted', '#475467');
  Chart.defaults.borderColor = cssVar('--border', '#e4e7ec');
  if (Chart.defaults.plugins?.legend?.labels) {
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
  }
}

function palette() {
  return [
    cssVar('--primary', '#1e6b5c'),
    cssVar('--accent', '#3b82c4'),
    cssVar('--warning', '#f59e0b'),
    cssVar('--negative', '#dc2626'),
    '#8b5cf6', '#14b8a6', '#ec4899', '#5e7d72', '#60a5fa', '#f97316',
  ];
}

function periodSwitcher() {
  return el('div', { className: 'segmented', role: 'radiogroup', 'aria-label': 'Trend period' },
    ...PERIODS.map(([n, label]) => el('button', {
      type: 'button',
      role: 'radio',
      className: `segmented__opt${trendMonths === n ? ' is-active' : ''}`,
      'aria-checked': trendMonths === n ? 'true' : 'false',
      onClick: () => { if (trendMonths !== n) { trendMonths = n; window.appRefresh(); } },
    }, label)),
  );
}

export function renderReports(container) {
  const state = store.getState();
  const month = getCurrentMonth();
  const prevMonth = getPreviousMonth(month);
  const categories = state.categories;
  const spentByCategory = categories.map(c => ({
    id: c.id,
    name: c.name,
    icon: c.icon,
    budgeted: Number(c.monthlyBudget) || 0,
    spent: store.getCategorySpent(c.id, month),
    prevSpent: store.getCategorySpent(c.id, prevMonth),
    remaining: store.getCategoryRemaining(c.id, month),
  })).filter(c => c.budgeted > 0 || c.spent > 0 || c.prevSpent > 0);

  const totalBudgeted = store.getTotalBudgeted();
  const totalSpent = store.getTotalSpent();
  const prevSpentTotal = categories.reduce((s, c) => s + store.getCategorySpent(c.id, prevMonth), 0);
  const income = store.getTotalIncome(month);
  const spendDelta = totalSpent - prevSpentTotal;

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Reports'),
    el('p', {}, `${getMonthLabel(month)} · where the money went`)
  ));

  container.appendChild(el('div', { className: 'btn-group section report-actions' },
    el('button', { className: 'btn btn-sm btn-secondary', onClick: () => exportCSV(spentByCategory) }, 'Export CSV'),
    el('button', { className: 'btn btn-sm btn-secondary', onClick: () => window.print() }, 'Print / PDF'),
  ));

  container.appendChild(el('div', { className: 'grid grid-3 section report-summary' },
    summaryCard('Income', income, 'accent'),
    summaryCard('Budgeted', totalBudgeted),
    summaryCard('Spent', totalSpent, totalSpent > totalBudgeted ? 'negative' : ''),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, `This month vs ${getMonthLabel(prevMonth)}`),
    el('div', { className: 'card' },
      el('p', { className: 'month-compare-summary' },
        `Spent ${formatCurrency(totalSpent)} this month vs ${formatCurrency(prevSpentTotal)} last month — `,
        el('strong', {
          className: spendDelta > 0 ? 'text-negative' : spendDelta < 0 ? 'text-positive' : '',
        }, spendDelta === 0
          ? 'unchanged'
          : `${spendDelta > 0 ? '+' : ''}${formatCurrency(spendDelta)}`),
        '.',
      ),
      el('div', { className: 'month-compare-list' },
        ...spentByCategory
          .map(c => ({ ...c, delta: c.spent - c.prevSpent }))
          .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
          .slice(0, 12)
          .map(c => el('div', { className: 'month-compare-row' },
            el('span', { className: 'month-compare-name' }, `${c.icon || '✉️'} ${c.name}`),
            el('span', { className: 'month-compare-vals' },
              el('span', { title: getMonthLabel(prevMonth) }, formatCurrency(c.prevSpent)),
              el('span', { className: 'month-compare-arrow' }, '→'),
              el('span', { title: getMonthLabel(month) }, formatCurrency(c.spent)),
              el('span', {
                className: `month-compare-delta ${c.delta > 0 ? 'text-negative' : c.delta < 0 ? 'text-positive' : 'text-muted'}`,
              }, c.delta === 0 ? '—' : `${c.delta > 0 ? '+' : ''}${formatCurrency(c.delta)}`),
            ),
          )),
      ),
      el('p', { className: 'tx-form-hint mt-3' },
        'Last month → this month, with the change in spending.',
      ),
    ),
  ));

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Summary'),
    el('div', { className: 'card' },
      el('p', { className: 'mb-0 lh-relaxed' },
        `This month you planned ${formatCurrency(income)} in income and budgeted ${formatCurrency(totalBudgeted)} across ${categories.length} envelopes. `,
        `You've spent ${formatCurrency(totalSpent)} so far, leaving ${formatCurrency(totalBudgeted - totalSpent)} in your planned budget. `,
        store.getTotalDebt() > 0
          ? (() => {
            const held = store.getPausedDebts().length;
            const n = store.getActiveDebts().length;
            const snow = store.getSnowballDebts().length;
            return `You have ${formatCurrency(store.getTotalDebt())} total debt across ${n} balance${n === 1 ? '' : 's'}`
              + (held
                ? ` (${snow} in the snowball, ${held} on hold).`
                : '.');
          })()
          : 'You are debt free — keep building wealth!'
      )
    )
  ));

  const trends = store.getMonthlyTrends(trendMonths);
  const periodName = trendMonths === 12 ? 'last 12 months' : `last ${trendMonths} months`;

  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title-row' },
      el('div', { className: 'section-title' }, 'Trends'),
      periodSwitcher(),
    ),
    el('div', { className: 'card' },
      el('div', { className: 'chart-container chart-wrap chart-wrap--tall' },
        el('canvas', {
          id: 'trend-chart', role: 'img',
          'aria-label': `Income, spending and budget, ${periodName}. Figures listed below.`,
          'aria-describedby': 'trend-text',
        }),
      ),
      el('div', { className: 'table-wrap report-desktop-list mt-4' },
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
      el('div', { className: 'report-mobile-list mt-4', id: 'trend-text' },
        ...trends.map(t => el('div', { className: 'report-row' },
          el('div', { className: 'report-row-top' },
            el('strong', {}, getMonthLabel(t.month)),
            el('span', {}, formatCurrency(t.spent)),
          ),
          el('div', { className: 'report-row-meta' },
            `In ${formatCurrency(t.income)} · Budgeted ${formatCurrency(t.budgeted)} · Debt ${formatCurrency(t.debtPaid)}`
          ),
        )),
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
      el('div', { className: 'section-title' }, 'Top 5 categories'),
      el('div', { className: 'card' },
        el('div', { className: 'chart-container chart-wrap' },
          el('canvas', {
            id: 'category-trend-chart', role: 'img',
            'aria-label': `Spending trend for ${topCategoryNames.join(', ')}, ${periodName}.`,
          }),
        ),
      ),
    ));
  }

  container.appendChild(el('div', { className: 'grid grid-2 section' },
    el('div', { className: 'card' },
      el('div', { className: 'section-title' }, 'Spending by category'),
      el('div', { className: 'chart-container chart-wrap' },
        el('canvas', {
          id: 'spending-chart', role: 'img',
          'aria-label': 'Spending by category this month. Category breakdown listed below.',
          'aria-describedby': 'category-text',
        })
      )
    ),
    el('div', { className: 'card' },
      el('div', { className: 'section-title' }, 'Budget vs actual'),
      el('div', { className: 'chart-container chart-wrap' },
        el('canvas', {
          id: 'budget-chart', role: 'img',
          'aria-label': 'Budgeted versus spent for the 8 largest envelopes. Category breakdown listed below.',
          'aria-describedby': 'category-text',
        })
      )
    ),
  ));

  const sortedCats = [...spentByCategory].sort((a, b) => b.spent - a.spent);
  container.appendChild(el('div', { className: 'section' },
    el('div', { className: 'section-title' }, 'Category breakdown'),
    el('div', { className: 'card' },
      el('div', { className: 'table-wrap report-desktop-list' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Category'),
            el('th', {}, 'Budgeted'),
            el('th', {}, 'Actual'),
            el('th', {}, 'Difference'),
            el('th', {}, '% Used'),
          )),
          el('tbody', {},
            ...sortedCats.map(c => el('tr', {},
              el('td', {}, c.name),
              el('td', {}, formatCurrency(c.budgeted)),
              el('td', {}, formatCurrency(c.spent)),
              el('td', { className: c.remaining >= 0 ? 'text-positive' : 'text-negative' },
                formatCurrency(c.remaining)
              ),
              el('td', {}, c.budgeted > 0 ? `${Math.round((c.spent / c.budgeted) * 100)}%` : '—'),
            ))
          )
        )
      ),
      el('div', { className: 'report-mobile-list', id: 'category-text' },
        ...sortedCats.map(c => {
          const pct = c.budgeted > 0 ? Math.round((c.spent / c.budgeted) * 100) : null;
          return el('div', { className: 'report-row' },
            el('div', { className: 'report-row-top' },
              el('strong', {}, c.name),
              el('span', {}, formatCurrency(c.spent)),
            ),
            el('div', { className: 'report-row-meta' },
              `Budgeted ${formatCurrency(c.budgeted)} · `,
              el('span', { className: c.remaining >= 0 ? 'text-positive' : 'text-negative' },
                `${c.remaining >= 0 ? '' : ''}${formatCurrency(c.remaining)} left`
              ),
              pct != null ? ` · ${pct}%` : '',
            ),
          );
        }),
      ),
    )
  ));

  if (store.getActiveDebts().length || state.archivedDebts?.length) {
    container.appendChild(el('div', { className: 'section' },
      el('div', { className: 'section-title' }, 'Debt balances'),
      el('div', { className: 'card' },
        el('div', { className: 'chart-container chart-wrap' },
          el('canvas', {
            id: 'debt-chart', role: 'img',
            'aria-label': `Current balance for each debt: ${store.getActiveDebts().map(d => `${d.name} ${formatCurrency(Number(d.balance) || 0)}`).join(', ') || 'none'}.`,
          })
        )
      )
    ));
  }

  requestAnimationFrame(() => {
    applyChartTheme();
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

/** Destroy prior Chart.js instances so page re-renders don't leak. */
const chartRegistry = new Map();

function mountChart(canvasId, config) {
  if (typeof Chart === 'undefined') return null;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const prev = chartRegistry.get(canvasId);
  if (prev) {
    try { prev.destroy(); } catch { /* ignore */ }
    chartRegistry.delete(canvasId);
  }
  const chart = new Chart(canvas, config);
  chartRegistry.set(canvasId, chart);
  return chart;
}

function renderCharts(spentByCategory, state) {
  if (typeof Chart === 'undefined') return;

  const colors = palette();
  const [cPrimary, cAccent] = colors;

  mountChart('spending-chart', {
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
      cutout: '62%',
      plugins: { legend: { position: window.innerWidth < 640 ? 'bottom' : 'right', labels: { font: { size: 11 } } } },
    },
  });

  const top = [...spentByCategory].sort((a, b) => b.budgeted - a.budgeted).slice(0, 8);
  mountChart('budget-chart', {
    type: 'bar',
    data: {
      labels: top.map(c => c.name),
      datasets: [
        { label: 'Budgeted', data: top.map(c => c.budgeted), backgroundColor: cAccent, borderRadius: 4 },
        { label: 'Actual', data: top.map(c => c.spent), backgroundColor: cPrimary, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true } },
      plugins: { legend: { position: 'top' } },
    },
  });

  // Chart includes on-hold debts so total picture is honest
  const debts = store.getActiveDebts();
  mountChart('debt-chart', {
    type: 'bar',
    data: {
      labels: debts.map(d => d.paused ? `${d.name} (hold)` : d.name),
      datasets: [{
        label: 'Balance',
        data: debts.map(d => Number(d.balance)),
        backgroundColor: debts.map(d => d.paused ? cssVar('--text-subtle', '#a8a29e') : cssVar('--negative', '#b42318')),
        borderRadius: 4,
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

function renderTrendCharts(trends, topCategoryNames) {
  if (typeof Chart === 'undefined') return;

  const pal = palette();
  mountChart('trend-chart', {
    type: 'line',
    data: {
      labels: trends.map(t => getMonthLabel(t.month).split(' ')[0]),
      datasets: [
        { label: 'Income', data: trends.map(t => t.income), borderColor: pal[1], backgroundColor: pal[1], tension: 0.3 },
        { label: 'Spent', data: trends.map(t => t.spent), borderColor: pal[0], backgroundColor: pal[0], tension: 0.3 },
        { label: 'Budgeted', data: trends.map(t => t.budgeted), borderColor: cssVar('--text-subtle', '#94a3b8'), backgroundColor: cssVar('--text-subtle', '#94a3b8'), borderDash: [4, 4], tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { y: { beginAtZero: true } },
    },
  });

  if (topCategoryNames.length) {
    const colors = pal;
    mountChart('category-trend-chart', {
      type: 'line',
      data: {
        labels: trends.map(t => getMonthLabel(t.month).split(' ')[0]),
        datasets: topCategoryNames.map((name, i) => ({
          label: name,
          data: trends.map(t => t.byCategory[name] || 0),
          borderColor: colors[i % colors.length],
          backgroundColor: colors[i % colors.length],
          tension: 0.2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } },
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