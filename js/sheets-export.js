import { toCSV, downloadFile, getCurrentMonth } from './utils.js';
import { store } from './store.js';

function categoryName(state, id) {
  if (!id) return '';
  return state.categories.find(c => c.id === id)?.name || '';
}

function buildTransactionsCSV(state) {
  const rows = [];
  (state.transactions || []).forEach(t => {
    if (store.isSplitTransaction(t)) {
      t.splits.forEach(split => {
        rows.push({
          Date: t.date || '',
          Description: t.description || '',
          Type: t.type || '',
          Amount: Number(split.amount) || 0,
          Category: categoryName(state, split.categoryId),
          BankCategory: t.importCategory || '',
          SplitOf: Number(t.amount) || 0,
        });
      });
      return;
    }
    rows.push({
      Date: t.date || '',
      Description: t.description || '',
      Type: t.type || '',
      Amount: Number(t.amount) || 0,
      Category: categoryName(state, t.categoryId),
      BankCategory: t.importCategory || '',
      SplitOf: '',
    });
  });
  return toCSV(rows, ['Date', 'Description', 'Type', 'Amount', 'Category', 'BankCategory', 'SplitOf']);
}

function buildEnvelopesCSV(state) {
  const rows = (state.categories || []).map(c => ({
    Name: c.name,
    Icon: c.icon || '',
    MonthlyBudget: Number(c.monthlyBudget) || 0,
    CarryOver: Number(c.carryOver) || 0,
    Spent: store.getCategorySpent(c.id),
    Remaining: store.getCategoryRemaining(c.id),
    SinkingFund: c.isSinkingFund ? 'Yes' : 'No',
    LinkedDebts: store.getDebtsForCategory(c.id).map(d => d.name).join('; '),
    LinkedBills: store.getBillsForCategory(c.id).map(b => b.name).join('; '),
  }));
  return toCSV(rows, [
    'Name', 'Icon', 'MonthlyBudget', 'CarryOver', 'Spent', 'Remaining',
    'SinkingFund', 'LinkedDebts', 'LinkedBills',
  ]);
}

function buildBillsCSV(state) {
  const rows = (state.bills || []).map(b => ({
    Name: b.name,
    Amount: Number(b.amount) || 0,
    DueDate: b.dueDate || '',
    Status: b.status || 'pending',
    PaidDate: b.paidDate || '',
    PaidAmount: b.paidAmount != null ? b.paidAmount : '',
    Category: categoryName(state, b.categoryId),
    Recurring: b.recurring ? 'Yes' : 'No',
    AutoPay: b.autoPay ? 'Yes' : 'No',
  }));
  return toCSV(rows, [
    'Name', 'Amount', 'DueDate', 'Status', 'PaidDate', 'PaidAmount',
    'Category', 'Recurring', 'AutoPay',
  ]);
}

function buildDebtsCSV(state) {
  const active = (state.debts || []).filter(d => !d.archived);
  const archived = state.archivedDebts || [];
  const rows = [
    ...active.map(d => ({
      Name: d.name,
      Balance: Number(d.balance) || 0,
      MinPayment: Number(d.minPayment) || 0,
      InterestRate: Number(d.interestRate) || 0,
      DueDate: d.dueDate || '',
      Envelope: categoryName(state, d.categoryId),
      Status: 'Active',
      PaidOffDate: '',
      Notes: d.notes || '',
    })),
    ...archived.map(d => ({
      Name: d.name,
      Balance: 0,
      MinPayment: Number(d.minPayment) || 0,
      InterestRate: Number(d.interestRate) || 0,
      DueDate: d.dueDate || '',
      Envelope: categoryName(state, d.categoryId),
      Status: 'Paid Off',
      PaidOffDate: d.paidOffDate || '',
      Notes: d.notes || '',
    })),
  ];
  return toCSV(rows, [
    'Name', 'Balance', 'MinPayment', 'InterestRate', 'DueDate',
    'Envelope', 'Status', 'PaidOffDate', 'Notes',
  ]);
}

function buildIncomeCSV(state) {
  const rows = (state.incomeSources || []).map(s => ({
    Source: s.name,
    Type: s.type || '',
    MonthlyAmount: Number(s.amount) || 0,
  }));
  return toCSV(rows, ['Source', 'Type', 'MonthlyAmount']);
}

function buildSummaryCSV(state) {
  const month = getCurrentMonth();
  const rows = [{
    ExportDate: new Date().toISOString().slice(0, 10),
    Month: month,
    CheckingBalance: Number(state.balances?.checking) || 0,
    EmergencyFund: Number(state.balances?.emergencyFund) || 0,
    MonthlyIncome: store.getTotalIncome(getCurrentMonth()),
    TotalBudgeted: store.getTotalBudgeted(),
    TotalSpent: store.getTotalSpent(),
    TotalDebt: store.getTotalDebt(),
    SnowballSurplus: store.getSurplusForSnowball(),
    BabyStep: store.detectBabyStep(),
    ActiveDebts: store.getActiveDebts().length,
    UpcomingBills: (state.bills || []).filter(b => b.status !== 'paid').length,
    TransactionCount: (state.transactions || []).length,
  }];
  return toCSV(rows, [
    'ExportDate', 'Month', 'CheckingBalance', 'EmergencyFund', 'MonthlyIncome',
    'TotalBudgeted', 'TotalSpent', 'TotalDebt', 'SnowballSurplus', 'BabyStep',
    'ActiveDebts', 'UpcomingBills', 'TransactionCount',
  ]);
}

export function exportForGoogleSheets() {
  const state = store.getState();
  const stamp = new Date().toISOString().slice(0, 10);
  const files = [
    { name: `summary-${stamp}.csv`, content: buildSummaryCSV(state) },
    { name: `transactions-${stamp}.csv`, content: buildTransactionsCSV(state) },
    { name: `envelopes-${stamp}.csv`, content: buildEnvelopesCSV(state) },
    { name: `bills-${stamp}.csv`, content: buildBillsCSV(state) },
    { name: `debts-${stamp}.csv`, content: buildDebtsCSV(state) },
    { name: `income-${stamp}.csv`, content: buildIncomeCSV(state) },
  ];

  files.forEach((file, i) => {
    setTimeout(() => downloadFile(file.content, file.name, 'text/csv'), i * 400);
  });

  return files.length;
}