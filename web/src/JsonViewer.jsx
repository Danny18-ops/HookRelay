import React, { useState } from 'react';

function Node({ k, v, depth }) {
  const isObj = v !== null && typeof v === 'object';
  const [open, setOpen] = useState(depth < 2);
  const label = k !== undefined ? <span className="jk">{k}: </span> : null;
  if (!isObj) {
    const cls = v === null ? 'jn' : typeof v === 'string' ? 'js' : 'jv';
    return <div className="jrow">{label}<span className={cls}>{typeof v === 'string' ? JSON.stringify(v) : String(v)}</span></div>;
  }
  const entries = Object.entries(v);
  const [o, c] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  return (
    <div className="jrow">
      <span className="jtoggle" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</span>
      {label}{o}
      {!open && <span className="jdim"> {entries.length} {entries.length === 1 ? 'item' : 'items'} </span>}
      {open && (
        <div className="jchildren">
          {entries.map(([ck, cv]) => <Node key={ck} k={ck} v={cv} depth={depth + 1} />)}
        </div>
      )}
      {c}
    </div>
  );
}

export default function JsonViewer({ value }) {
  return <div className="json"><Node v={value} depth={0} /></div>;
}
