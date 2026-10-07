/**
 * Past-month Remaining must include that month's opening carry.
 * Run: node scripts/test-history-opening-carry.mjs
 */
import { getCurrentMonth, getPreviousMonth, addMonths } from '../js/utils.js';

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}
function near(a, b, eps = 0.02) {
  return Math.abs(Number(a) - Number(b)) < eps;
}

globalThis.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const { store } = await import('../js/store.js');

const current = getCurrentMonth();
const prev = getPreviousMonth(current);
const prev2 = getPreviousMonth(prev);

function quietBooks() {
  store.state.transactions = [];
  store.state.bills = [];
  store.state.debts = [];
  store.state.archivedDebts = [];
  store.state.balances.checking = 0;
  store.state.upcomingHolds = [];
  store.state.monthPlanExtras = {};
  store.state.monthEnvelopeMoves = {};
  store.state.monthBonusAllocations = {};
  store.state.monthBudgetSnapshots = {};
  store.state.monthOpeningCarrySnapshots = {};
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
  store.state.lastMonthProcessed = current;
}

function ensureCat(name, extras = {}) {
  let cat = store.state.categories.find(c => c.name === name);
  if (!cat) {
    cat = {
      id: `test-${name.toLowerCase().replace(/\s+/g, '-')}`,
      name,
      icon: '✉️',
      monthlyBudget: 0,
      carryOver: 0,
      kind: 'expense',
      isSinkingFund: !!extras.isSinkingFund,
      parentId: null,
    };
    store.state.categories.push(cat);
  }
  Object.assign(cat, extras);
  return cat;
}

function addExpense(catId, month, amount, id) {
  store.state.transactions.push({
    id,
    date: `${month}-15`,
    amount: Math.abs(amount),
    type: 'expense',
    categoryId: catId,
    description: `test ${id}`,
  });
}

// --- (a) current month unchanged ---
quietBooks();
const medical = ensureCat('Medical');
medical.monthlyBudget = 200;
medical.carryOver = -1970.6;
addExpense(medical.id, current, 500, 'med-cur');
const currentRem = store.getCategoryRemaining(medical.id, current);
expect(near(currentRem, 200 + (-1970.6) + 0 - 500), `current remaining should use live carry, got ${currentRem}`);
expect(near(store.getOpeningCarryForMonth(medical.id, current), -1970.6), 'current opening carry is live carryOver');
const currentPool = store.getCategoryPool(medical.id, current);
expect(near(currentPool, 200 + (-1970.6)), `current pool includes live carry, got ${currentPool}`);

// --- (b) viewing M−1 remaining equals what became M carry after rollover ---
quietBooks();
const med = ensureCat('Medical');
med.monthlyBudget = 200;
// Simulate: after Sept→Oct rollover, live carry is Sept end remaining.
// Reconstruct Sept: opening −1970.60, budget 200, spent 200 → end rem −1970.60
// Wait live proof: Sept UI (without carry) −1970.60, Oct carry −3941.20
// So Sept without = −1970.60, Sept opening = −1970.60, Sept with = −3941.20 = Oct carry
med.carryOver = -3941.2; // live Oct opening = Sept end with carry
med.monthlyBudget = 200; // Oct plan (also used as fallback for Sept if no snap)
store.state.monthBudgetSnapshots[prev] = { [med.id]: 200 };
store.state.monthBudgetSnapshots[current] = { [med.id]: 200 };
// Sept spent such that without-carry remaining = −1970.60: 200 + 0 - spent = -1970.60 → spent = 2170.60
addExpense(med.id, prev, 2170.6, 'med-sept');
const septWithout = store.getCategoryActivityWithoutCarry(med.id, prev);
expect(near(septWithout, -1970.6), `Sept activity without carry should be -1970.60, got ${septWithout}`);
const septOpening = store.getOpeningCarryForMonth(med.id, prev);
expect(near(septOpening, -1970.6), `derived Sept opening should be -1970.60, got ${septOpening}`);
const septRem = store.getCategoryRemaining(med.id, prev);
expect(near(septRem, -3941.2), `Sept remaining with opening carry should equal Oct carry (-3941.20), got ${septRem}`);
expect(near(septRem, med.carryOver), 'M−1 remaining must equal live M carry after rollover');

// Current month still uses live carry only (Oct)
addExpense(med.id, current, 100, 'med-oct');
const octRem = store.getCategoryRemaining(med.id, current);
expect(near(octRem, 200 + (-3941.2) - 100), `Oct remaining unchanged formula, got ${octRem}`);

// --- (c) Medical-style negative stack across two past months via snapshot ---
quietBooks();
const med2 = ensureCat('Medical');
med2.monthlyBudget = 100;
// After rolling into current: live carry = end of prev
// Set up snapshots for prev2 and prev openings
store.state.monthOpeningCarrySnapshots[prev2] = { [med2.id]: -500 };
store.state.monthOpeningCarrySnapshots[prev] = { [med2.id]: -800 };
store.state.monthBudgetSnapshots[prev2] = { [med2.id]: 100 };
store.state.monthBudgetSnapshots[prev] = { [med2.id]: 100 };
addExpense(med2.id, prev2, 400, 'med-p2'); // activity: 100-400 = -300; end = -500 + -300 = -800
addExpense(med2.id, prev, 200, 'med-p1'); // activity: 100-200 = -100; end = -800 + -100 = -900
med2.carryOver = -900; // live = end of prev
expect(near(store.getOpeningCarryForMonth(med2.id, prev2), -500), 'snapshot opening for prev2');
expect(near(store.getCategoryRemaining(med2.id, prev2), -800), `prev2 remaining stacked, got ${store.getCategoryRemaining(med2.id, prev2)}`);
expect(near(store.getOpeningCarryForMonth(med2.id, prev), -800), 'snapshot opening for prev');
expect(near(store.getCategoryRemaining(med2.id, prev), -900), `prev remaining equals live carry, got ${store.getCategoryRemaining(med2.id, prev)}`);
expect(near(store.getCategoryPool(med2.id, prev), 100 + (-800)), 'past-month pool includes opening carry');

// --- (d) sinking-fund positive stack (Happy Wife / Vacation style) ---
quietBooks();
const vacation = ensureCat('Vacation', { isSinkingFund: true });
vacation.monthlyBudget = 300;
// After rollover: live carry = prior end remaining (funded pile)
// Prior: opening 4500, budget 300, spent 5020 → end = 4500+300-5020 = -220? 
// Better: funded pile — opening 4720, budget 300, spent 0 → end 5020 = live carry
vacation.carryOver = 5020;
store.state.monthBudgetSnapshots[prev] = { [vacation.id]: 300 };
store.state.monthOpeningCarrySnapshots[prev] = { [vacation.id]: 4720 };
const vacRemPrev = store.getCategoryRemaining(vacation.id, prev);
expect(near(vacRemPrev, 4720 + 300), `Vacation Sept remaining includes opening, got ${vacRemPrev}`);
expect(near(vacRemPrev, 5020), 'Vacation M−1 remaining equals live M carry when no Sept spend');
expect(near(store.getCategoryPool(vacation.id, prev), 5020), 'Vacation past pool is true available');
const vacRemCur = store.getCategoryRemaining(vacation.id, current);
expect(near(vacRemCur, 300 + 5020), `Vacation current remaining unchanged, got ${vacRemCur}`);

// Happy Wife positive stack via derivation (no snapshot)
quietBooks();
const hw = ensureCat('Happy Wife', { isSinkingFund: true });
hw.monthlyBudget = 50;
hw.carryOver = 400; // Oct live = Sept end
store.state.monthBudgetSnapshots[prev] = { [hw.id]: 50 };
addExpense(hw.id, prev, 0, 'hw-none');
// Sept without = 50; opening = 400 - 50 = 350; remaining with = 400
const hwOpening = store.getOpeningCarryForMonth(hw.id, prev);
expect(near(hwOpening, 350), `Happy Wife derived Sept opening 350, got ${hwOpening}`);
expect(near(store.getCategoryRemaining(hw.id, prev), 400), 'Happy Wife Sept remaining = Oct carry');

// --- Rollover still replaces carry (does not double-add) ---
quietBooks();
const roll = ensureCat('RollTest');
roll.monthlyBudget = 100;
roll.carryOver = 40;
store.state.monthBudgetSnapshots[prev] = { [roll.id]: 100 };
store.state.lastMonthProcessed = prev;
addExpense(roll.id, prev, 25, 'roll-spend');
// Force rollover path
store.state.lastMonthProcessed = prev;
store.processMonthRollover();
expect(store.state.lastMonthProcessed === current, 'rollover advances lastMonthProcessed');
// remaining was 100+40-25 = 115; carry should be replaced with 115, not 40+115
expect(near(roll.carryOver, 115), `rollover replaces carry with remaining (115), got ${roll.carryOver}`);
expect(
  store.state.monthOpeningCarrySnapshots?.[prev]?.[roll.id] === 40
  || near(store.state.monthOpeningCarrySnapshots?.[prev]?.[roll.id], 40),
  'rollover snapshot stores opening carry (40)',
);
const viewedPrev = store.getCategoryRemaining(roll.id, prev);
expect(near(viewedPrev, 115), `after rollover, viewing prev remaining is honest (115), got ${viewedPrev}`);

// Do NOT apply live carry to every past month: prev2 with no activity should not get 115
store.state.monthBudgetSnapshots[prev2] = { [roll.id]: 100 };
const prev2Rem = store.getCategoryRemaining(roll.id, prev2);
// Derived: walk back from live 115. prev activity without = we had spend on prev only.
// prev2 without carry activity = 100 (budget, no spend). opening_prev was 40 = end of prev2.
// So prev2 remaining = 40? opening_prev2 = end_prev2 - without? 
// end_prev = 115 = live. opening_prev = 115 - (100-25) = 115 - 75 = 40.
// end_prev2 = opening_prev = 40. opening_prev2 = 40 - 100 = -60. remaining_prev2 = -60?
// Actually if prev2 had budget 100 and no spend and opening that leads to end 40:
// 100 + opening - 0 = 40 → opening = -60. Yes.
expect(near(prev2Rem, 40), `prev2 end/remaining derived as opening of prev (40), got ${prev2Rem}`);
expect(!near(prev2Rem, roll.carryOver) || near(40, 115), 'must not blindly apply live carry (115) to prev2');

if (failures.length) {
  console.error('FAIL', failures.length);
  failures.forEach(f => console.error(' -', f));
  process.exit(1);
}
console.log('OK history-opening-carry', {
  current,
  prev,
  medicalSeptRem: -3941.2,
  vacationFunded: 5020,
});
