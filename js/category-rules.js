/** Merchant / description rules for auto-categorizing transactions */

export function normalizePattern(pattern) {
  return String(pattern || '').toLowerCase().trim();
}

/**
 * Extract a stable merchant token for "always use this envelope" rules.
 * Uses up to 3 significant words so INGLES GAS EXPRESS ≠ INGLES MARKETS.
 * (Old rules that saved only "ingles" still work but lose to longer matches.)
 */
export function guessMerchantPattern(description) {
  let text = String(description || '').trim();
  if (!text) return '';
  // Drop common bank noise prefixes
  text = text
    .replace(/^(pos|debit|credit|purchase|withdrawal|ach|web|check|chk|visa|mc|amex)\s+/i, '')
    .replace(/\s+#\d+\b/g, ' ')
    .replace(/\s+\d{4,}\s*$/g, ' ')
    .trim();
  // Words with 3+ letters/digits (keep gas/markets/express distinction)
  const words = text
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z0-9*&'-]/gi, ''))
    .filter(w => w.replace(/[^a-zA-Z0-9]/gi, '').length >= 3);
  if (!words.length) {
    const fallback = text.toLowerCase().replace(/[^a-z0-9*&'\s-]/gi, '').trim();
    return fallback.slice(0, 64);
  }
  // Brand + up to 2 more tokens (e.g. "ingles gas express", "ingles markets")
  const tokens = words.slice(0, 3).map(w => w.toLowerCase());
  return tokens.join(' ').slice(0, 64);
}

export function descriptionMatchesPattern(description, pattern) {
  const p = normalizePattern(pattern);
  if (!p) return false;
  return String(description || '').toLowerCase().includes(p);
}

/**
 * Prefer the most specific rule (longest pattern). Ties → newest createdAt.
 * So "ingles gas" beats a broad legacy "ingles" for pump charges.
 */
export function findMatchingRule(description, rules = []) {
  const matches = (rules || []).filter(rule =>
    descriptionMatchesPattern(description, rule.pattern)
  );
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const la = normalizePattern(a.pattern).length;
    const lb = normalizePattern(b.pattern).length;
    if (lb !== la) return lb - la;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return matches[0];
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
