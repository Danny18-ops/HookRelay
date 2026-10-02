import express from 'express';
import { Delivery, Endpoint, Event, Rule } from '../models.js';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { extractIdempotencyKey, verifySignature } from '../lib/signature.js';
import { matchesFilter } from '../lib/filter.js';
import { rateLimit } from '../lib/rateLimit.js';
import { enqueueDelivery } from '../queue.js';
import { publish } from '../redis.js';

const SENSITIVE = new Set(['authorization', 'cookie', 'x-api-key']);
const redactHeaders = (h) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE.has(k) ? '[redacted]' : v]));

function parseBody(raw, contentType = '') {
  if (!raw) return null;
  if (contentType.includes('json') || /^[\[{]/.test(raw.trimStart())) {
    try { return JSON.parse(raw); } catch { /* fall through to string */ }
  }
  if (contentType.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return raw;
}

/** Create Delivery rows for every enabled matching rule and queue them. */
export async function fanOut(event, { replayOf, ruleId } = {}) {
  const query = { endpointId: event.endpointId, enabled: true };
  if (ruleId) query._id = ruleId;
  const rules = await Rule.find(query);
  const ctx = { body: event.body, headers: event.headers };
  const matched = rules.filter((r) => ruleId || matchesFilter(r.filter, ctx));
  const deliveries = await Delivery.insertMany(
    matched.map((r) => ({
      accountId: event.accountId, endpointId: event.endpointId, eventId: event._id,
      ruleId: r._id, ruleName: r.name, actionType: r.action.type, replayOf,
    })),
  );
  await Event.updateOne({ _id: event._id }, { $inc: { deliveryCount: deliveries.length } });
  for (const d of deliveries) {
    await enqueueDelivery(d._id).catch((e) => console.error('[enqueue] left for reconciler:', e.message));
    publish(event.accountId, 'delivery', d.toObject());
  }
  return deliveries;
}

export function ingestRouter() {
  const router = express.Router();

  router.post(
    '/:token',
    express.raw({ type: () => true, limit: config.maxBodyBytes }),
    async (req, res, next) => {
      try {
        const endpoint = await Endpoint.findOne({ token: req.params.token });
        if (!endpoint) return res.status(404).json({ error: 'unknown endpoint' });
        if (!endpoint.active) return res.status(410).json({ error: 'endpoint disabled' });

        const rl = await rateLimit(`ingest:${endpoint._id}`, endpoint.rateLimitPerMinute);
        res.set('X-RateLimit-Limit', String(rl.limit)).set('X-RateLimit-Remaining', String(rl.remaining));
        if (!rl.allowed) {
          return res.set('Retry-After', String(rl.retryAfterSec)).status(429).json({ error: 'rate limit exceeded' });
        }

        const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
        const headers = redactHeaders(req.headers);
        const contentType = req.headers['content-type'] || '';
        const base = {
          accountId: endpoint.accountId, endpointId: endpoint._id, method: req.method,
          headers, contentType, rawBody,
        };

        const secret = endpoint.secretEnc ? decrypt(endpoint.secretEnc) : null;
        const sig = verifySignature({ provider: endpoint.provider, secret, headers: req.headers, rawBody });
        if (!sig.ok) {
          const rejected = await Event.create({
            ...base, body: parseBody(rawBody, contentType), status: 'rejected',
            rejectReason: sig.reason, signatureValid: false,
          });
          publish(endpoint.accountId, 'event', rejected.toObject());
          return res.status(401).json({ error: 'invalid signature', reason: sig.reason });
        }

        const body = parseBody(rawBody, contentType);
        const key = extractIdempotencyKey({ provider: endpoint.provider, headers: req.headers, body });
        const dedupeKey = key ? `${endpoint._id}:${key}` : undefined;
        let event;
        try {
          event = await Event.create({
            ...base, body, signatureValid: endpoint.provider === 'none' ? null : true,
            ...(dedupeKey ? { dedupeKey } : {}),
          });
        } catch (e) {
          if (e.code === 11000) {
            const existing = await Event.findOne({ dedupeKey });
            return res.status(200).json({ id: existing?._id, duplicate: true });
          }
          throw e;
        }

        publish(endpoint.accountId, 'event', event.toObject());
        const deliveries = await fanOut(event);
        res.status(202).json({ id: event._id, deliveries: deliveries.length });
      } catch (err) {
        next(err);
      }
    },
  );
  return router;
}
