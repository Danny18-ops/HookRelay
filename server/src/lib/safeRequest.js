import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config.js';

export function isPrivateAddress(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * dns.lookup replacement that refuses private addresses. Validating inside the lookup
 * the socket actually uses closes the DNS-rebinding window a separate pre-check would leave.
 */
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad && !config.allowPrivateTargets) {
      const e = new Error(`blocked: ${hostname} resolves to private address ${bad.address}`);
      e.code = 'EBLOCKED';
      return cb(e);
    }
    return Array.isArray(address) ? cb(null, list) : cb(null, address, family);
  });
}

export class HttpResult {
  constructor({ statusCode, body, durationMs }) {
    Object.assign(this, { statusCode, body, durationMs });
  }
}

/** Outbound HTTP with timeout, no redirect following, and capped response capture. */
export function safeRequest({ url, method = 'POST', headers = {}, body, timeoutMs = config.deliveryTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(Object.assign(new Error('invalid URL'), { permanent: true })); }
    if (!['http:', 'https:'].includes(u.protocol)) {
      return reject(Object.assign(new Error('only http(s) URLs are allowed'), { permanent: true }));
    }
    if (net.isIP(u.hostname) && isPrivateAddress(u.hostname) && !config.allowPrivateTargets) {
      return reject(Object.assign(new Error(`blocked: private address ${u.hostname}`), { permanent: true }));
    }
    const started = Date.now();
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, headers: { ...headers, 'content-length': Buffer.byteLength(body ?? '') }, lookup: guardedLookup, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < 4096) chunks.push(c);
          size += c.length;
        });
        res.on('end', () =>
          resolve(new HttpResult({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 4096),
            durationMs: Date.now() - started,
          })),
        );
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => {
      if (e.code === 'EBLOCKED') e.permanent = true;
      reject(e);
    });
    if (body) req.write(body);
    req.end();
  });
}
