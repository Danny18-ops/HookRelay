import React, { useState } from 'react';
import { api, setKey } from './api.js';

export default function Login({ onLogin }) {
  const [key, setK] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [created, setCreated] = useState(null);

  async function signIn(k) {
    try {
      await api('GET', '/me', undefined, k);
      setKey(k);
      onLogin();
    } catch (e) { setErr(e.message); }
  }

  async function signUp(e) {
    e.preventDefault();
    try {
      const r = await api('POST', '/signup', { name }, '');
      setCreated(r.apiKey);
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <div className="login">
      <h1>HookRelay</h1>
      <p className="muted">Receive, transform and reliably deliver webhooks.</p>
      {created ? (
        <div className="card">
          <p>Your API key — copy it now, it is shown only once:</p>
          <code className="block">{created}</code>
          <button onClick={() => signIn(created)}>Continue</button>
        </div>
      ) : (
        <>
          <form className="card" onSubmit={(e) => { e.preventDefault(); signIn(key.trim()); }}>
            <label>API key<input value={key} onChange={(e) => setK(e.target.value)} placeholder="hr_..." /></label>
            <button disabled={!key}>Sign in</button>
          </form>
          <form className="card" onSubmit={signUp}>
            <label>New workspace name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <button disabled={!name}>Create workspace</button>
          </form>
        </>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
