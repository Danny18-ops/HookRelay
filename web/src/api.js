const KEY = 'hookrelay.apiKey';

export const getKey = () => localStorage.getItem(KEY) || '';
export const setKey = (k) => (k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY));

export async function api(method, path, body, key = getKey()) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.reason || data?.error || res.statusText);
    err.status = res.status;
    err.issues = data?.issues;
    throw err;
  }
  return data;
}

/**
 * Subscribe to the live SSE stream. EventSource can't send an Authorization header (and putting
 * the API key in a URL would leak it into logs), so this reads the stream with fetch instead.
 * Reconnects with a short delay until the returned function is called.
 */
export function openStream(onMessage, onState = () => {}) {
  const ctrl = new AbortController();
  (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch('/api/stream', { headers: { authorization: `Bearer ${getKey()}` }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        onState(true);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line) onMessage(JSON.parse(line.slice(6)));
          }
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
      }
      onState(false);
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => ctrl.abort();
}
