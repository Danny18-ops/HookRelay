import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature, extractIdempotencyKey } from '../src/lib/signature.js';
import { matchesFilter } from '../src/lib/filter.js';
import { applyTransform } from '../src/lib/transform.js';
import { isPrivateAddress } from '../src/lib/safeRequest.js';
import { encrypt, decrypt } from '../src/lib/crypto.js';

const hex = (s, d) => crypto.createHmac('sha256', s).update(d).digest('hex');

test('github signature', () => {
  const raw = '{"a":1}';
  const ok = verifySignature({ provider: 'github', secret: 's', rawBody: raw, headers: { 'x-hub-signature-256': `sha256=${hex('s', raw)}` } });
  assert.equal(ok.ok, true);
  assert.equal(verifySignature({ provider: 'github', secret: 's', rawBody: raw + ' ', headers: { 'x-hub-signature-256': `sha256=${hex('s', raw)}` } }).ok, false);
  assert.equal(verifySignature({ provider: 'github', secret: 's', rawBody: raw, headers: {} }).ok, false);
});

test('stripe signature + tolerance', () => {
  const raw = '{"id":"evt_1"}';
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const header = `t=${t},v1=${hex('whsec', `${t}.${raw}`)}`;
  assert.equal(verifySignature({ provider: 'stripe', secret: 'whsec', rawBody: raw, headers: { 'stripe-signature': header }, now }).ok, true);
  const old = verifySignature({ provider: 'stripe', secret: 'whsec', rawBody: raw, headers: { 'stripe-signature': header }, now: now + 10 * 60_000 });
  assert.equal(old.ok, false);
  assert.match(old.reason, /tolerance/);
});

test('shopify + generic signatures', () => {
  const raw = 'x=1';
  const b64 = crypto.createHmac('sha256', 'k').update(raw).digest('base64');
  assert.equal(verifySignature({ provider: 'shopify', secret: 'k', rawBody: raw, headers: { 'x-shopify-hmac-sha256': b64 } }).ok, true);
  assert.equal(verifySignature({ provider: 'generic', secret: 'k', rawBody: raw, headers: { 'x-signature-256': hex('k', raw) } }).ok, true);
  assert.equal(verifySignature({ provider: 'generic', secret: 'k', rawBody: raw, headers: { 'x-signature-256': 'sha256=bad' } }).ok, false);
});

test('idempotency keys only from trusted sources', () => {
  assert.equal(extractIdempotencyKey({ provider: 'github', headers: { 'x-github-delivery': 'g1' }, body: {} }), 'g1');
  assert.equal(extractIdempotencyKey({ provider: 'stripe', headers: {}, body: { id: 'evt_1' } }), 'evt_1');
  assert.equal(extractIdempotencyKey({ provider: 'generic', headers: {}, body: { id: 'order-1' } }), null);
});

test('filter', () => {
  const ctx = { body: { type: 'invoice.paid', amount: 50, tags: ['a', 'b'] }, headers: {} };
  const f = (conditions, match = 'all') => matchesFilter({ match, conditions }, ctx);
  assert.equal(f([]), true);
  assert.equal(f([{ path: 'body.type', op: 'eq', value: 'invoice.paid' }]), true);
  assert.equal(f([{ path: 'body.amount', op: 'gt', value: 100 }]), false);
  assert.equal(f([{ path: 'body.tags', op: 'contains', value: 'b' }]), true);
  assert.equal(f([{ path: 'body.nope', op: 'exists' }]), false);
  assert.equal(f([{ path: 'body.type', op: 'eq', value: 'x' }, { path: 'body.amount', op: 'lt', value: 100 }], 'any'), true);
});

test('transform keeps types for lone placeholders, stringifies in text, supports default', () => {
  const ctx = { body: { user: { name: 'Ada' }, amount: 42, items: [{ sku: 'A1' }] }, headers: {} };
  const out = applyTransform({ text: 'Hi {{body.user.name}}, {{body.amount}} due', amount: '{{body.amount}}', sku: '{{body.items[0].sku}}', note: '{{body.note | default:\'none\'}}' }, ctx);
  assert.deepEqual(out, { text: 'Hi Ada, 42 due', amount: 42, sku: 'A1', note: 'none' });
  assert.deepEqual(applyTransform(null, ctx), ctx.body);
  assert.equal(applyTransform('{{body.__proto__.x}}', ctx), null);
});

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('secret encryption roundtrip', () => {
  const blob = encrypt('whsec_123');
  assert.notEqual(blob, 'whsec_123');
  assert.equal(decrypt(blob), 'whsec_123');
});
