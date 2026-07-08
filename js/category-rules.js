/** Merchant / description rules for auto-categorizing transactions */

export function normalizePattern(pattern) {
  return String(pattern || '').toLowerCase().trim();
}

export function descriptionMatchesPattern(description, pattern) {
  const p = normalizePattern(pattern);
  if (!p) return false;
  return String(description || '').toLowerCase().includes(p);
}

export function findMatchingRule(description, rules = []) {
  return rules.find(rule => descriptionMatchesPattern(description, rule.pattern)) || null;
}

/**
 * Apply a category rule to a transaction object (mutates copy fields).
 * Returns true if a rule was applied.
 */
export function applyRuleToTransaction(tx, rule) {
  if (!rule || !tx) return false;
  if (tx.type !== 'expense') return false;

  if (rule.type === 'split' && Array.isArray(rule.categoryIds) && rule.categoryIds.length) {
    const total = Math.abs(Number(tx.amount)) || 0;
    if (!total) return false;
    const count = rule.categoryIds.length;
    let assigned = 0;
    tx.splits = rule.categoryIds.map((categoryId, i) => {
      const amt = i === count - 1
        ? Math.round((total - assigned) * 100) / 100
        : Math.round((total / count) * 100) / 100;
      assigned += amt;
      return { categoryId, amount: amt };
    });
    tx.categoryId = null;
    tx.importCategory = null;
    return true;
  }

  if (rule.categoryId) {
    tx.categoryId = rule.categoryId;
    tx.importCategory = null;
    delete tx.splits;
    return true;
  }

  return false;
}

export function buildRuleLabel(rule, categories) {
  if (rule.type === 'split' && rule.categoryIds?.length) {
    const names = rule.categoryIds
      .map(id => categories.find(c => c.id === id)?.name)
      .filter(Boolean);
    return `Split → ${names.join(' + ')}`;
  }
  const cat = categories.find(c => c.id === rule.categoryId);
  return cat ? cat.name : rule.pattern;
}