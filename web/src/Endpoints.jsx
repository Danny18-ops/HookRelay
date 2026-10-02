import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import RuleBuilder from './RuleBuilder.jsx';

function EndpointCard({ ep, onChanged }) {
  const [rules, setRules] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | rule
  const [sample, setSample] = useState(null);
  const load = useCallback(async () => setRules(await api('GET', `/endpoints/${ep.id}/rules`)), [ep.id]);
  useEffect(() => { load(); }, [load]);

  async function startEdit(r) {
    // Prefill the preview with the endpoint's most recent real payload.
    const { items } = await api('GET', `/events?endpointId=${ep.id}&status=accepted&limit=1`);
    setSample(items[0]?.body ?? null);
    setEditing(r);
  }

  return (
    <div className="card">
      <div className="row between">
        <h3>{ep.name} <span className={`badge ${ep.active ? 'ok' : 'muted'}`}>{ep.active ? 'active' : 'paused'}</span> <span className="badge">{ep.provider}</span></h3>
        <div className="row">
          <button className="ghost" onClick={async () => { await api('PATCH', `/endpoints/${ep.id}`, { active: !ep.active }); onChanged(); }}>{ep.active ? 'Pause' : 'Resume'}</button>
          <button className="ghost danger" onClick={async () => { if (confirm(`Delete ${ep.name} and its rules?`)) { await api('DELETE', `/endpoints/${ep.id}`); onChanged(); } }}>Delete</button>
        </div>
      </div>
      <code className="block">{location.origin}{new URL(ep.ingestUrl).pathname}</code>
      <div className="muted small">Rate limit {ep.rateLimitPerMinute}/min · signature secret {ep.hasSecret ? 'set' : 'not set'}</div>

      <h4>Rules</h4>
      {rules.length === 0 && <p className="muted">No rules yet — events will be stored but not delivered anywhere.</p>}
      {rules.map((r) => (
        <div className="row between rule" key={r._id}>
          <div>
            <b>{r.name}</b> <span className="badge">{r.action.type}</span>
            <div className="muted small">{r.filter.conditions.length ? r.filter.conditions.map((c) => `${c.path} ${c.op} ${c.value ?? ''}`).join(r.filter.match === 'any' ? ' OR ' : ' AND ') : 'every event'}</div>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => startEdit(r)}>Edit</button>
            <button className="ghost danger" onClick={async () => { await api('DELETE', `/rules/${r._id}`); load(); }}>Delete</button>
          </div>
        </div>
      ))}
      {!editing && <button onClick={() => startEdit('new')}>+ Add rule</button>}
      {editing && (
        <RuleBuilder endpoint={ep} rule={editing === 'new' ? null : editing} sample={sample}
          onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
      )}
    </div>
  );
}

export default function Endpoints() {
  const [eps, setEps] = useState([]);
  const [form, setForm] = useState({ name: '', provider: 'none', secret: '' });
  const [err, setErr] = useState('');
  const [generated, setGenerated] = useState('');
  const load = useCallback(async () => setEps(await api('GET', '/endpoints')), []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    setErr(''); setGenerated('');
    try {
      const r = await api('POST', '/endpoints', { name: form.name, provider: form.provider, ...(form.secret ? { secret: form.secret } : {}) });
      if (r.generatedSecret) setGenerated(r.generatedSecret);
      setForm({ name: '', provider: 'none', secret: '' });
      load();
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <div>
      <form className="card row" onSubmit={create}>
        <input className="grow" placeholder="Endpoint name (e.g. Stripe prod)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
          {['none', 'github', 'stripe', 'shopify', 'generic'].map((p) => <option key={p}>{p}</option>)}
        </select>
        {form.provider !== 'none' && <input className="grow" placeholder={form.provider === 'generic' ? 'Signing secret (blank = generate)' : 'Signing secret'} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />}
        <button disabled={!form.name}>Create endpoint</button>
      </form>
      {err && <p className="err">{err}</p>}
      {generated && <div className="card">Generated signing secret (shown once): <code>{generated}</code><div className="muted small">Sign the raw body with HMAC-SHA256 and send it as <code>X-Signature-256</code>.</div></div>}
      {eps.map((ep) => <EndpointCard key={ep.id} ep={ep} onChanged={load} />)}
    </div>
  );
}
