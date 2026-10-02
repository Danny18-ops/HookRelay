import { hmacHex, hmacBase64, safeEqual } from './crypto.js';

export const PROVIDERS = ['none', 'github', 'stripe', 'shopify', 'generic'];
const STRIPE_TOLERANCE_SEC = 300;

/**
 * Verify an inbound webhook signature against the raw request body.
 * Returns { ok, reason }.
 */
export function verifySignature({ provider, secret, headers, rawBody, now = Date.now() }) {
  if (provider === 'none') return { ok: true };
  if (!secret) return { ok: false, reason: 'no secret configured' };
  const h = (n) => headers[n.toLowerCase()];

  switch (provider) {
    case 'github': {
      const sig = h('x-hub-signature-256');
      if (!sig) return { ok: false, reason: 'missing X-Hub-Signature-256' };
      return safeEqual(sig, `sha256=${hmacHex(secret, rawBody)}`)
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
    }
    case 'shopify': {
      const sig = h('x-shopify-hmac-sha256');
      if (!sig) return { ok: false, reason: 'missing X-Shopify-Hmac-Sha256' };
      return safeEqual(sig, hmacBase64(secret, rawBody))
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
    }
    case 'stripe': {
      const header = h('stripe-signature');
      if (!header) return { ok: false, reason: 'missing Stripe-Signature' };
      const parts = header.split(',').map((p) => p.trim().split('='));
      const t = parts.find(([k]) => k === 't')?.[1];
      const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
      if (!t || v1s.length === 0) return { ok: false, reason: 'malformed Stripe-Signature' };
      if (Math.abs(now / 1000 - Number(t)) > STRIPE_TOLERANCE_SEC) {
        return { ok: false, reason: 'timestamp outside tolerance' };
      }
      const expected = hmacHex(secret, `${t}.${rawBody}`);
      return v1s.some((v) => safeEqual(v, expected))
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
    }
    case 'generic': {
      const sig = h('x-signature-256') || h('x-hookrelay-signature');
      if (!sig) return { ok: false, reason: 'missing X-Signature-256' };
      const expected = hmacHex(secret, rawBody);
      return safeEqual(sig.replace(/^sha256=/, ''), expected)
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
    }
    default:
      return { ok: false, reason: `unknown provider ${provider}` };
  }
}

/**
 * Sender-supplied unique id, used for idempotency. Only trusted identifiers are used: a missing
 * key means "no dedupe" rather than guessing, since dropping a legitimate event is worse than
 * delivering a duplicate. `body.id` is only trusted for Stripe, where it is the unique evt_ id.
 */
export function extractIdempotencyKey({ provider, headers, body }) {
  return (
    headers['idempotency-key'] ||
    headers['x-github-delivery'] ||
    headers['x-shopify-webhook-id'] ||
    (provider === 'stripe' && body && typeof body.id === 'string' ? body.id : null) ||
    null
  );
}
