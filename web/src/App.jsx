import React, { useEffect, useState } from 'react';
import { api, getKey, setKey } from './api.js';
import Login from './Login.jsx';
import Endpoints from './Endpoints.jsx';
import Events from './Events.jsx';

function Stats() {
  const [s, setS] = useState(null);
  useEffect(() => {
    const load = () => api('GET', '/stats').then(setS).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const d = s.deliveries24h;
  return (
    <div className="stats">
      <div><b>{s.events24h}</b><span>events / 24h</span></div>
      <div><b>{s.rejected24h}</b><span>rejected</span></div>
      <div><b>{d.success || 0}</b><span>delivered</span></div>
      <div><b>{(d.retrying || 0) + (d.pending || 0)}</b><span>in flight</span></div>
      <div className={d.failed ? 'bad' : ''}><b>{d.failed || 0}</b><span>failed</span></div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getKey());
  const [tab, setTab] = useState('events');
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;
  return (
    <div className="app">
      <header>
        <h1>HookRelay</h1>
        <nav>
          <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Event log</button>
          <button className={tab === 'endpoints' ? 'active' : ''} onClick={() => setTab('endpoints')}>Endpoints &amp; rules</button>
        </nav>
        <button className="ghost" onClick={() => { setKey(''); setAuthed(false); }}>Sign out</button>
      </header>
      <Stats />
      {tab === 'events' ? <Events /> : <Endpoints />}
    </div>
  );
}
