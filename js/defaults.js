import { generateId } from './utils.js';
import { createBonusIncomeSource } from './income-sources.js';

export const DEFAULT_CATEGORIES = [
  { name: 'Mortgage', icon: '🏡' },
  { name: 'Groceries', icon: '🛒' },
  { name: 'Eating Out / Fast Food', icon: '🍔' },
  { name: 'Gas & Transportation', icon: '⛽' },
  { name: 'Household / Misc', icon: '🏠' },
  { name: 'Medical / Health', icon: '🏥' },
  { name: 'Entertainment', icon: '🎬' },
  { name: 'Clothing', icon: '👕' },
  { name: 'Subscriptions', icon: '📱' },
  { name: 'Giving / Tithe', icon: '💝' },
  { name: 'Home Improvement', icon: '🔧' },
  { name: 'Kids Activities', icon: '⚽' },
  { name: 'Personal Care', icon: '💇' },
  { name: 'Utilities', icon: '💡' },
  { name: 'Insurance', icon: '🛡️' },
  { name: 'Education', icon: '📚' },
];

export const SINKING_FUND_DEFAULTS = [
  { name: 'Christmas', icon: '🎄' },
  { name: 'Car Maintenance', icon: '🚗' },
  { name: 'Home Repairs', icon: '🔨' },
  { name: 'Vacation', icon: '✈️' },
];

export const BUILT_IN_CATEGORY_NAMES = new Set(
  [...DEFAULT_CATEGORIES, ...SINKING_FUND_DEFAULTS].map(c => c.name.toLowerCase())
);

export const BABY_STEPS = [
  { step: 1, title: 'Starter Emergency Fund', target: '$1,000', description: "Save $1,000 fast for life's little emergencies." },
  { step: 2, title: 'Debt Snowball', target: 'Pay off all debt', description: 'Pay off all debt (except the house) using the snowball method.' },
  { step: 3, title: 'Full Emergency Fund', target: '3–6 months expenses', description: 'Save 3–6 months of expenses in a fully funded emergency fund.' },
  { step: 4, title: 'Invest 15%', target: 'Retirement', description: 'Invest 15% of household income into retirement.' },
  { step: 5, title: "Kids' College", target: 'Education fund', description: "Save for your children's college fund." },
  { step: 6, title: 'Pay Off Home', target: 'Mortgage free', description: 'Pay off your home early.' },
  { step: 7, title: 'Build Wealth & Give', target: 'Live and give', description: 'Build wealth and give generously.' },
];

export const MOTIVATIONAL_MESSAGES = [
  'Every dollar needs a job before it gets lazy!',
  'Live like no one else, so later you can live like no one else.',
  'A budget is telling your money where to go instead of wondering where it went.',
  'The debt snowball works because it changes behavior.',
  "Financial peace isn't a theory — it's something you do.",
  'Small steps today lead to big freedom tomorrow.',
  "You're closer to debt-free than you were yesterday!",
];

export function createDefaultState() {
  const id = () => generateId();
  const categories = DEFAULT_CATEGORIES.map(c => ({
    id: id(),
    name: c.name,
    icon: c.icon,
    parentId: null,
    isSinkingFund: false,
    monthlyBudget: 0,
    carryOver: 0,
  }));

  SINKING_FUND_DEFAULTS.forEach(c => {
    categories.push({
      id: id(),
      name: c.name,
      icon: c.icon,
      parentId: null,
      isSinkingFund: true,
      monthlyBudget: 0,
      carryOver: 0,
    });
  });

  return {
    version: 1,
    setupComplete: false,
    settings: {
      darkMode: false,
      palette: 'forest',
      daveRamseyMode: true,
      passwordHash: null,
      familySize: 7,
    },
    incomeSources: [
      {
        id: id(), name: 'Primary', amount: 0, type: 'job',
        matchTerms: [],
        paySchedule: { mode: 'dates', checks: [], recurring: { frequency: 'biweekly', day1: 1, day2: null }, perCheckAmount: null },
      },
      {
        id: id(), name: 'Secondary', amount: 0, type: 'job',
        matchTerms: [],
        paySchedule: { mode: 'recurring', checks: [], recurring: { frequency: 'monthly', day1: 1, day2: null }, perCheckAmount: null },
      },
      {
        id: id(), name: 'Tertiary', amount: 0, type: 'other',
        matchTerms: [],
        paySchedule: { mode: 'recurring', checks: [], recurring: { frequency: 'monthly', day1: 1, day2: null }, perCheckAmount: null },
      },
      createBonusIncomeSource(),
    ],
    balances: {
      checking: 0,
      emergencyFund: 0,
      savings: [],
    },
    babyStep: 1,
    categories,
    bills: [],
    debts: [],
    transactions: [],
    archivedDebts: [],
    celebrations: [],
    notes: '',
    notesUpdatedAt: null,
    removedDefaultCategories: [],
    categoryRules: [],
    monthBudgetSnapshots: {},
    monthCloseLog: [],
    reconciliation: { bankBalance: null, asOfDate: null },
    lastMonthProcessed: null,
  };
}