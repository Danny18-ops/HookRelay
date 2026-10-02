import { getPath } from './path.js';

const WHOLE = /^\{\{\s*([^{}|]+?)\s*(?:\|\s*default\s*:\s*(.*?))?\s*\}\}$/;
const ANY = /\{\{\s*([^{}|]+?)\s*(?:\|\s*default\s*:\s*(.*?))?\s*\}\}/g;

const stringify = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const parseDefault = (d) => (d === undefined ? undefined : d.replace(/^(['"])(.*)\1$/, '$2'));

function renderString(str, ctx) {
  const whole = str.match(WHOLE);
  if (whole) {
    const v = getPath(ctx, whole[1]);
    // A lone placeholder keeps the original JSON type (number, object, ...).
    return v === undefined || v === null ? parseDefault(whole[2]) ?? null : v;
  }
  return str.replace(ANY, (_, path, def) => {
    const v = getPath(ctx, path);
    return stringify(v === undefined || v === null ? parseDefault(def) : v);
  });
}

/**
 * Render a template (string | array | object) against ctx = { body, headers, event }.
 * `{{body.user.name}}` and `{{body.x | default:'n/a'}}` are supported. A null/undefined
 * template passes the raw body through unchanged.
 */
export function applyTransform(template, ctx) {
  if (template === undefined || template === null || template === '') return ctx.body;
  const walk = (t) => {
    if (typeof t === 'string') return renderString(t, ctx);
    if (Array.isArray(t)) return t.map(walk);
    if (t && typeof t === 'object') return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, walk(v)]));
    return t;
  };
  return walk(template);
}
