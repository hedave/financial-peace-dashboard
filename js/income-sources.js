import { generateId } from './utils.js';
import { normalizePaySchedule } from './pay-schedule.js';

export const BONUS_INCOME_NAME = 'Bonus Income';

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

/** Default CSV description matchers by source name/type hints */
const MATCH_HINTS = [
  { hints: ['noaa', 'agriculture', 'primary job'], terms: ['us department of agriculture'] },
  { hints: ['va', 'veteran', 'disability'], terms: ['us department of veterans affairs'] },
  { hints: ['calpers', 'cal pers', 'retirement'], terms: ['public employee retirement system'] },
];

export function applyDefaultMatchTerms(source) {
  if (!source || isBonusIncomeSource(source)) return;
  if (!Array.isArray(source.matchTerms)) source.matchTerms = [];

  const name = String(source.name || '').toLowerCase();
  const type = String(source.type || '').toLowerCase();

  MATCH_HINTS.forEach(({ hints, terms }) => {
    const applies = hints.some(h => name.includes(h) || type === h);
    if (!applies) return;
    terms.forEach(term => {
      const key = term.toLowerCase();
      if (!source.matchTerms.some(t => String(t).toLowerCase() === key)) {
        source.matchTerms.push(term);
      }
    });
  });
}

export function ensureBonusIncomeSource(incomeSources) {
  if (!Array.isArray(incomeSources)) return incomeSources;
  if (incomeSources.some(isBonusIncomeSource)) return incomeSources;
  return [...incomeSources, createBonusIncomeSource()];
}