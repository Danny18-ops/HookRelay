import crypto from 'node:crypto';
import { config } from '../config.js';

export const randomToken = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const hmacBase64 = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64');

/** AES-256-GCM for secrets at rest. Format: iv.tag.ciphertext (base64). */
export function encrypt(plain, key = config.encryptionKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob, key = config.encryptionKey) {
  const [iv, tag, enc] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
