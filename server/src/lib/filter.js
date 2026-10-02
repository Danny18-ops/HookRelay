import { getPath } from './path.js';

export const OPS = ['eq', 'neq', 'contains', 'startsWith', 'exists', 'gt', 'lt'];

function check(actual, op, expected) {
  switch (op) {
    case 'exists': return actual !== undefined && actual !== null;
    case 'eq': return String(actual) === String(expected);
    case 'neq': return String(actual) !== String(expected);
    case 'contains':
      if (Array.isArray(actual)) return actual.map(String).includes(String(expected));
      return actual !== undefined && actual !== null && String(actual).includes(String(expected));
    case 'startsWith': return actual !== undefined && actual !== null && String(actual).startsWith(String(expected));
    case 'gt': return Number(actual) > Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    default: return false;
  }
}

/**
 * filter: { match: 'all'|'any', conditions: [{ path, op, value }] }
 * context: { body, headers } — paths are rooted at it, e.g. `body.type`.
 * An empty filter matches everything.
 */
export function matchesFilter(filter, context) {
  const conditions = filter?.conditions ?? [];
  if (conditions.length === 0) return true;
  const results = conditions.map((c) => check(getPath(context, c.path), c.op, c.value));
  return filter.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}
