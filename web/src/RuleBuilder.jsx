import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import JsonViewer from './JsonViewer.jsx';

const OPS = ['eq', 'neq', 'contains', 'startsWith', 'exists', 'gt', 'lt'];
const DEFAULT_TRANSFORM = '{\n  "text": "New event: {{body.type}}"\n}';

function parseTransform(text) {
  if (!text.trim()) return { value: null };
  try { return { value: JSON.parse(text) }; } catch { return { value: text }; } // plain string template
}

function toForm(rule) {
  const c = rule?.action?.config || {};
  return {
    name: rule?.name || '',
    match: rule?.filter?.match || 'all',
    conditions: rule?.filter?.conditions?.length ? rule.filter.conditions : [],
    transform: rule ? (rule.transform == null ? '' : typeof rule.transform === 'string' ? rule.transform : JSON.stringify(rule.transform, null, 2)) : DEFAULT_TRANSFORM,
    type: rule?.action?.type || 'http',
    url: c.url || '', method: c.method || 'POST', signingSecret: c.signingSecret || '',
    webhookUrl: c.webhookUrl || '', to: c.to || '', subject: c.subject || '',
  };
}

function toRule(f) {
  const config = f.type === 'http'
    ? { url: f.url, method: f.method, ...(f.signingSecret ? { signingSecret: f.signingSecret } : {}) }
    : f.type === 'slack' ? { webhookUrl: f.webhookUrl }
    : { to: f.to, ...(f.subject ? { subject: f.subject } : {}) };
  return {
    name: f.name,
    filter: { match: f.match, conditions: f.conditions.filter((c) => c.path).map((c) => ({ ...c, value: c.value ?? '' })) },
    transform: parseTransform(f.transform).value,
    action: { type: f.type, config },
  };
}

export default function RuleBuilder({ endpoint, rule, sample, onSaved, onCancel }) {
  const [f, setF] = useState(() => toForm(rule));
  const [payload, setPayload] = useState(() => JSON.stringify(sample ?? { type: 'example.event', data: { id: 1 } }, null, 2));
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const set = (patch) => setF((p) => ({ ...p, ...patch }));
  const setCond = (i, patch) => set({ conditions: f.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const payloadObj = useMemo(() => { try { return { ok: true, v: JSON.parse(payload) }; } catch { return { ok: false }; } }, [payload]);

  // Live preview: debounce, then dry-run the filter + transform server-side.
  useEffect(() => {
    if (!payloadObj.ok) { setPreview({ error: 'Sample payload is not valid JSON' }); return; }
    const t = setTimeout(async () => {
      try {
        const rule = toRule(f);
        setPreview(await api('POST', '/rules/test', { filter: rule.filter, transform: rule.transform, payload: payloadObj.v, headers: {} }));
      } catch (e) { setPreview({ error: e.message }); }
    }, 300);
    return () => clearTimeout(t);
  }, [f.match, f.conditions, f.transform, payload]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setErr('');
    try {
      const body = toRule(f);
      const saved = rule ? await api('PUT', `/rules/${rule._id}`, body) : await api('POST', `/endpoints/${endpoint.id}/rules`, body);
      onSaved(saved);
    } catch (e) {
      setErr(e.issues ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message);
    }
  }

  return (
    <div className="card builder">
      <h3>{rule ? 'Edit rule' : 'New rule'} <span className="muted">for {endpoint.name}</span></h3>
      <label>Name<input value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>

      <h4>1. When…</h4>
      <div className="row">
        Match
        <select value={f.match} onChange={(e) => set({ match: e.target.value })}>
          <option value="all">all</option><option value="any">any</option>
        </select>
        of these conditions (none = every event)
      </div>
      {f.conditions.map((c, i) => (
        <div className="row" key={i}>
          <input className="grow" placeholder="body.type" value={c.path} onChange={(e) => setCond(i, { path: e.target.value })} />
          <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
          {c.op !== 'exists' && <input className="grow" placeholder="value" value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })} />}
          <button className="ghost" onClick={() => set({ conditions: f.conditions.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button className="ghost" onClick={() => set({ conditions: [...f.conditions, { path: '', op: 'eq', value: '' }] })}>+ condition</button>

      <h4>2. Transform</h4>
      <p className="muted small">JSON template; use <code>{'{{body.path}}'}</code>, <code>{'{{headers.x-name}}'}</code>, <code>{'{{body.x | default:\'n/a\'}}'}</code>. Empty = forward the body unchanged.</p>
      <textarea rows={6} value={f.transform} onChange={(e) => set({ transform: e.target.value })} />

      <h4>3. Then send to…</h4>
      <div className="row">
        <select value={f.type} onChange={(e) => set({ type: e.target.value })}>
          <option value="http">HTTP URL</option><option value="slack">Slack webhook</option><option value="email">Email</option>
        </select>
        {f.type === 'http' && <>
          <select value={f.method} onChange={(e) => set({ method: e.target.value })}><option>POST</option><option>PUT</option><option>PATCH</option></select>
          <input className="grow" placeholder="https://example.com/hook" value={f.url} onChange={(e) => set({ url: e.target.value })} />
        </>}
        {f.type === 'slack' && <input className="grow" placeholder="https://hooks.slack.com/services/..." value={f.webhookUrl} onChange={(e) => set({ webhookUrl: e.target.value })} />}
        {f.type === 'email' && <>
          <input className="grow" placeholder="to@example.com" value={f.to} onChange={(e) => set({ to: e.target.value })} />
          <input className="grow" placeholder="Subject (templated)" value={f.subject} onChange={(e) => set({ subject: e.target.value })} />
        </>}
      </div>
      {f.type === 'http' && (
        <label>Outbound signing secret (optional — adds X-HookRelay-Signature)
          <input value={f.signingSecret} onChange={(e) => set({ signingSecret: e.target.value })} />
        </label>
      )}

      <h4>Preview</h4>
      <div className="split">
        <div><div className="muted small">Sample payload</div><textarea rows={10} value={payload} onChange={(e) => setPayload(e.target.value)} /></div>
        <div>
          <div className="muted small">Result</div>
          {preview?.error && <p className="err">{preview.error}</p>}
          {preview && !preview.error && (preview.matched
            ? <><span className="badge ok">matches</span><JsonViewer value={preview.output} /></>
            : <span className="badge muted">no match — rule would not fire</span>)}
        </div>
      </div>

      {err && <p className="err">{err}</p>}
      <div className="row">
        <button onClick={save} disabled={!f.name}>Save rule</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
