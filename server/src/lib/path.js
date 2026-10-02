/** Read a dotted path like `body.items[0].sku` from an object. */
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return undefined;
    cur = cur[p];
  }
  return cur;
}
