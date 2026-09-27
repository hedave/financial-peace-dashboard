/**
 * Behavior checks for the review fixes.
 * Run after the import suite. Uses a fake localStorage and the real store.
 */
import { nameInDescription, findAutoPayBillForTransaction } from '../js/bill-matcher.js';
import { parseUsaaPdfText } from '../js/pdf-import.js';
import { getPreviousMonth } from '../js/utils.js';
import { stateForCloud } from '../js/cloud-sync.js';

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}

expect(nameInDescription('Car', 'CARD PAYMENT') === false, 'bill word "car" must not match "card"');
expect(nameInDescription('Citi', 'CITI CARD PAYMENT') === true, 'Citi should match CITI CARD PAYMENT');
expect(nameInDescription('Citi', 'CITICARD 123') === true, 'Citi should match CITICARD');
expect(nameInDescription('Ford', 'STANFORD PARK') === false, 'Ford must not match Stanford');

const shortBill = {
  id: 'b-car', name: 'Car', amount: 200, status: 'unpaid', autoPay: true, dueDate: '2026-09-20',
};
expect(
  findAutoPayBillForTransaction(
    { type: 'expense', amount: 5, description: 'CARD PAYMENT', date: '2026-09-18' },
    [shortBill],
  ) == null,
  'a $5 card charge must not complete the Car auto-pay bill',
);
expect(
  findAutoPayBillForTransaction(
    { type: 'expense', amount: 5, description: 'CITI CARD PAYMENT', date: '2026-09-18' },
    [{ id: 'b-citi', name: 'Citi', amount: 200, status: 'unpaid', autoPay: true, dueDate: '2026-09-20' }],
  )?.id === 'b-citi',
  'unique Citi auto-pay still matches when the payment amount differs',
);

const pdfRows = parseUsaaPdfText('Jan 2, 2026 Grocery Store -$12.50\n');
expect(pdfRows.length === 1, `same-line PDF row should import, got ${pdfRows.length}`);
expect(pdfRows[0]?.type === 'expense' && pdfRows[0]?.amount === 12.5, 'PDF row should be a $12.50 expense');

const redacted = parseUsaaPdfText('Jan 3, 2026 HOLD 80092562 -$4.00\n');
expect(
  redacted.length === 1 && !String(redacted[0]?.description || '').includes('[REDACTED]'),
  'an 8-digit hold token should survive PDF parse',
);

globalThis.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const { store } = await import('../js/store.js');

function quietBooks() {
  store.state.transactions = [];
  store.state.bills = [];
  store.state.debts = [];
  store.state.archivedDebts = [];
  store.state.balances.checking = 0;
  store.state.upcomingHolds = [];
  store.state.monthPlanExtras = {};
  store.state.monthEnvelopeMoves = {};
  store.state.settings.surplusCashBuffer = 0;
  store.state.incomeSources.forEach(s => {
    s.amount = 0;
    if (s.paySchedule) {
      s.paySchedule.checks = [];
      s.paySchedule.perCheckAmount = null;
    }
  });
  store.state.categories.forEach(c => {
    c.monthlyBudget = 0;
    c.carryOver = 0;
  });
}

quietBooks();
const catId = store.state.categories[0].id;
const liveCat = () => store.state.categories.find(c => c.id === catId);
store.state.debts = [
  { id: 'a', name: 'Small', balance: 100, minPayment: 40, categoryId: null, paused: false, archived: false },
  { id: 'b', name: 'Large', balance: 300, minPayment: 30, categoryId: null, paused: false, archived: false },
];
const months = store.estimateMonthsToDebtFree();
expect(months === 6, `two-debt snowball at minimums should take 6 months, got ${months}`);

quietBooks();
liveCat().monthlyBudget = 1;
store.state.debts = [
  { id: 'd', name: 'Card', balance: 2000, minPayment: 500, categoryId: catId, paused: false, archived: false },
];
const outside = store.getRemainingMinDebtPaymentsOutsideBudget();
expect(
  Math.abs(outside - 499) < 0.02,
  `$1 envelope must leave $499 of the minimum outside the plan, got ${outside}`,
);

quietBooks();
liveCat().monthlyBudget = 40;
store.state.balances.checking = 500;
store.state.debts = [
  { id: 'snow', name: 'Snow', balance: 80, minPayment: 10, categoryId: catId, paused: false, archived: false },
];
const beforeBudget = liveCat().monthlyBudget;
const paid = store.allocateSurplusToDebt(25);
expect(paid && paid.pay === 25, 'snowball payment should record $25');
expect(liveCat().monthlyBudget === beforeBudget, `snowball payment must not change the ongoing plan, budget is ${liveCat().monthlyBudget}`);
const extra = store.state.monthPlanExtras?.[store.state.lastMonthProcessed]?.[catId]
  || Object.values(store.state.monthPlanExtras || {}).reduce((s, bag) => s + (Number(bag?.[catId]) || 0), 0);
expect(Math.abs(extra - 25) < 0.02, `this month's plan extra should be $25, got ${extra}`);

quietBooks();
liveCat().monthlyBudget = 100;
store.state.balances.checking = 500;
store.state.transactions = [{
  id: 'pend',
  date: `${store.state.lastMonthProcessed}-15`,
  amount: 40,
  type: 'expense',
  categoryId: catId,
  description: 'Pending grocery',
  clearingStatus: 'pending',
}];
const forecast = store.getMonthEndSnowballForecast();
expect(
  Math.abs(forecast.safe - 400) < 0.02,
  `pending $40 still in checking should leave safe snowball at $400, got ${forecast.safe}`,
);

const cloudCopy = stateForCloud({
  settings: { passwordHash: 'abc', surplusCashBuffer: 50 },
  notes: 'hi',
});
expect(cloudCopy.settings.passwordHash == null, 'cloud payload must omit the app password');
expect(cloudCopy.settings.surplusCashBuffer === 50, 'cloud payload keeps the rest of settings');
expect(cloudCopy.notes === 'hi', 'cloud payload keeps notes');

quietBooks();
liveCat().monthlyBudget = 25;
liveCat().carryOver = 0;
store.state.lastMonthProcessed = getPreviousMonth(store.state.lastMonthProcessed);
store.state._localDirtyAt = 0;
store.processMonthRollover();
expect(Number(store.state._localDirtyAt) > 0, 'month rollover should stamp the local clock');
expect(Math.abs(liveCat().carryOver - 25) < 0.02, `rollover should bake $25 leftover into carry, got ${liveCat().carryOver}`);
expect(liveCat().monthlyBudget === 25, 'rollover must leave the ongoing monthly plan alone');

const board = store.state.noteBoards[0];
board.stickies.push({
  id: 'old-note',
  title: '',
  text: 'Amazon 58',
  color: 'yellow',
  updatedAt: '2026-09-01T15:04:00.000Z',
});
store.update(() => {}, { notes: true });
const oldNote = store.getNoteBoards()[0].stickies.find(n => n.id === 'old-note');
expect(
  oldNote?.createdAt === '2026-09-01T15:04:00.000Z',
  `an older note should keep its saved time as the added time, got ${oldNote?.createdAt}`,
);

const freshId = store.addStickyNote(board.id, { text: 'Amazon $58' });
const fresh = () => store.getNoteBoards().find(b => b.id === board.id).stickies.find(n => n.id === freshId);
expect(fresh()?.createdAt && fresh().createdAt === fresh().updatedAt, 'a new sticky stamps added and edited together');
const addedAt = fresh().createdAt;
store.patchStickyNote(board.id, freshId, { color: 'pink' });
expect(fresh().color === 'pink' && fresh().updatedAt === addedAt, 'a color change is not an edit');
store.patchStickyNote(board.id, freshId, { text: 'Amazon $58' });
expect(fresh().updatedAt === addedAt, 'typing the same text is not an edit');
fresh().createdAt = '2026-09-01T15:04:00.000Z';
fresh().updatedAt = '2026-09-01T15:04:00.000Z';
store.patchStickyNote(board.id, freshId, { text: 'Amazon $58.20' });
expect(fresh().createdAt === '2026-09-01T15:04:00.000Z', 'editing keeps the original added time');
expect(fresh().updatedAt !== '2026-09-01T15:04:00.000Z', 'editing records a new edited time');

if (failures.length) {
  console.error('test-review-fixes failed:');
  failures.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('test-review-fixes ok');
