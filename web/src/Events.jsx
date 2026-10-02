import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, openStream } from './api.js';
import JsonViewer from './JsonViewer.jsx';

const fmt = (d) => new Date(d).toLocaleTimeString();

const SUMMARY_ORDER = ['failed', 'retrying', 'pending', 'success'];
function summarize(ds = []) {
  const counts = {};
  ds.forEach((d) => { counts[d.status] = (counts[d.status] || 0) + 1; });
  return counts;
}

function Detail({ id, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setData(await api('GET', `/events/${id}`)), [id]);
  useEffect(() => { setData(null); load(); }, [load]);
  // Refresh when the live stream reports this event's deliveries changing.
  useEffect(() => onChanged?.(load), [load, onChanged]);
  if (!data) return <div className="card muted">Loading…</div>;
  const { event, deliveries } = data;
  const act = async (fn) => { setBusy(true); try { await fn(); await load(); } finally { setBusy(false); } };

  return (
    <div className="card">
      <div className="row between">
        <h3>Event <code>{event._id}</code></h3>
        {event.status === 'accepted' && <button disabled={busy} onClick={() => act(() => api('POST', `/events/${event._id}/replay`, {}))}>↻ Replay</button>}
      </div>
      <div className="muted small">
        {new Date(event.receivedAt).toLocaleString()} · {event.method} · {event.contentType || 'no content-type'} ·
        signature {event.signatureValid === null ? 'not checked' : event.signatureValid ? 'valid' : 'INVALID'}
      </div>
      {event.status === 'rejected' && <p className="err">Rejected: {event.rejectReason}</p>}

      <h4>Deliveries</h4>
      {deliveries.length === 0 && <p className="muted">No rules matched this event.</p>}
      {deliveries.map((d) => (
        <div className="delivery" key={d._id}>
          <div className="row between">
            <div><b>{d.ruleName}</b> <span className="badge">{d.actionType}</span> <span className={`badge ${d.status}`}>{d.status}</span>
              {d.replayOf && <span className="badge muted">replay</span>}</div>
            {d.status === 'failed' && <button className="ghost" disabled={busy} onClick={() => act(() => api('POST', `/deliveries/${d._id}/retry`, {}))}>Retry</button>}
          </div>
          {d.nextRetryAt && d.status === 'retrying' && <div className="muted small">next attempt {fmt(d.nextRetryAt)}</div>}
          <table className="attempts"><tbody>
            {d.attempts.map((a) => (
              <tr key={a.n}>
                <td>#{a.n}</td><td>{fmt(a.startedAt)}</td><td>{a.statusCode ?? '—'}</td><td>{a.durationMs}ms</td>
                <td className={a.error ? 'err' : ''}>{a.error || 'ok'}</td>
              </tr>
            ))}
          </tbody></table>
          {d.output !== undefined && <details><summary>Payload sent</summary><JsonViewer value={d.output} /></details>}
        </div>
      ))}

      <h4>Payload</h4>
      <JsonViewer value={event.body} />
      <details><summary>Headers</summary><JsonViewer value={event.headers} /></details>
      <details><summary>Raw body</summary><pre>{event.rawBody}</pre></details>
    </div>
  );
}

export default function Events() {
  const [events, setEvents] = useState([]);
  const [deliveries, setDeliveries] = useState({}); // eventId -> [delivery]
  const [selected, setSelected] = useState(null);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState('all');
  const listeners = React.useRef(new Set());

  const ingestDeliveries = useCallback((list) => setDeliveries((prev) => {
    const next = { ...prev };
    for (const d of list) {
      const arr = (next[d.eventId] || []).filter((x) => x._id !== d._id);
      next[d.eventId] = [...arr, d];
    }
    return next;
  }), []);

  const load = useCallback(async () => {
    const [e, d] = await Promise.all([api('GET', '/events?limit=100'), api('GET', '/deliveries?limit=200')]);
    setEvents(e.items); ingestDeliveries(d.items);
  }, [ingestDeliveries]);

  useEffect(() => {
    // Refetch every time the stream (re)connects: anything published between the initial load
    // and the subscription, or while disconnected, would otherwise be missing from the list.
    return openStream((msg) => {
      if (msg.type === 'event') setEvents((prev) => (prev.some((x) => x._id === msg.data._id) ? prev : [msg.data, ...prev].slice(0, 200)));
      if (msg.type === 'delivery') { ingestDeliveries([msg.data]); listeners.current.forEach((fn) => fn(msg.data.eventId)); }
    }, (up) => { setLive(up); if (up) load().catch(() => {}); });
  }, [ingestDeliveries, load]);

  // Let the open detail pane reload itself when one of its deliveries changes.
  const subscribeDetail = useCallback((load) => {
    const fn = (eventId) => { if (eventId === selected) load(); };
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, [selected]);

  const shown = useMemo(() => events.filter((e) => {
    const s = summarize(deliveries[e._id]);
    if (filter === 'failed') return s.failed;
    if (filter === 'rejected') return e.status === 'rejected';
    return true;
  }), [events, deliveries, filter]);

  return (
    <div className="split wide">
      <div>
        <div className="row between">
          <span className={`live ${live ? 'on' : ''}`}>{live ? '● live' : '○ reconnecting…'}</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All events</option><option value="failed">With failures</option><option value="rejected">Rejected</option>
          </select>
        </div>
        <div className="card list">
          {shown.length === 0 && <p className="muted">No events yet. POST to an endpoint URL and it shows up here instantly.</p>}
          {shown.map((e) => {
            const s = summarize(deliveries[e._id]);
            return (
              <div key={e._id} className={`item ${selected === e._id ? 'sel' : ''}`} onClick={() => setSelected(e._id)}>
                <span className="muted small">{fmt(e.receivedAt)}</span>
                <span className="grow trunc">{typeof e.body === 'object' && e.body ? (e.body.type || e.body.action || Object.keys(e.body).slice(0, 3).join(', ')) : String(e.body ?? '').slice(0, 40)}</span>
                {e.status === 'rejected' && <span className="badge failed">rejected</span>}
                {SUMMARY_ORDER.filter((k) => s[k]).map((k) => <span key={k} className={`badge ${k}`}>{s[k]} {k}</span>)}
              </div>
            );
          })}
        </div>
      </div>
      <div>{selected ? <Detail id={selected} onChanged={subscribeDetail} /> : <div className="card muted">Select an event to inspect its payload, delivery attempts and replay it.</div>}</div>
    </div>
  );
}
