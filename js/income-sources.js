import { generateId } from './utils.js';
import { normalizePaySchedule } from './pay-schedule.js';

export const BONUS_INCOME_NAME = 'Bonus Income';

/** Legacy default names → generic labels (preserves matchTerms / schedules) */
const LEGACY_INCOME_NAMES = {
  noaa: 'Primary',
  'va disability': 'Secondary',
  calpers: 'Tertiary',
  'cal pers': 'Tertiary',
};

export function isBonusIncomeSource(source) {
  return source?.type === 'bonus';
}

export function isPlannedIncomeSource(source) {
  return source && !isBonusIncomeSource(source);
}

export function createBonusIncomeSource() {
  return {
    id: generateId(),
    name: BONUS_INCOME_NAME,
    amount: 0,
    type: 'bonus',
    matchTerms: [],
    paySchedule: normalizePaySchedule(null),
  };
}

export function createPlannedIncomeSource(name = 'Additional') {
  return {
    id: generateId(),
    name,
    amount: 0,
    type: 'other',
    matchTerms: [],
    paySchedule: {
      mode: 'recurring',
      checks: [],
      recurring: { frequency: 'monthly', day1: 1, day2: null },
      perCheckAmount: null,
    },
  };
}

/** Rename known legacy defaults; leave custom names alone. Keeps match terms. */
export function migrateLegacyIncomeSourceNames(incomeSources) {
  if (!Array.isArray(incomeSources)) return incomeSources;
  incomeSources.forEach(src => {
    if (!src || isBonusIncomeSource(src)) return;
    const key = String(src.name || '').trim().toLowerCase();
    if (LEGACY_INCOME_NAMES[key]) src.name = LEGACY_INCOME_NAMES[key];
  });
  return incomeSources;
}

/**
 * Optional seed of bank-description matchers. Left empty by default —
 * users set match terms per source in Edit dates.
 */
export function applyDefaultMatchTerms(source) {
  if (!source || isBonusIncomeSource(source)) return;
  if (!Array.isArray(source.matchTerms)) source.matchTerms = [];
}

export function ensureBonusIncomeSource(incomeSources) {
  if (!Array.isArray(incomeSources)) return incomeSources;
  if (incomeSources.some(isBonusIncomeSource)) return incomeSources;
  return [...incomeSources, createBonusIncomeSource()];
}
