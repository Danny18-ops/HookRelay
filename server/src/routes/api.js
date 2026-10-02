import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Account, Delivery, Endpoint, Event, Rule } from '../models.js';
import { config } from '../config.js';
import { encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { PROVIDERS } from '../lib/signature.js';
import { OPS, matchesFilter } from '../lib/filter.js';
import { applyTransform } from '../lib/transform.js';
import { requireAuth } from '../auth.js';
import { rateLimit } from '../lib/rateLimit.js';
import { enqueueDelivery } from '../queue.js';
import { subscribe } from '../redis.js';
import { fanOut } from './ingest.js';

const oid = (v) => mongoose.isValidObjectId(v);
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const ruleBody = z.object({
  name: z.string().min(1).max(100),
  enabled: z.boolean().optional(),
  filter: z.object({
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(z.object({ path: z.string().min(1), op: z.enum(OPS), value: z.any().optional() })).max(20),
  }).default({ match: 'all', conditions: [] }),
  transform: z.any().nullable().optional(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('http'), config: z.object({
      url: z.string().url(), method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
      headers: z.record(z.string()).optional(), signingSecret: z.string().optional() }) }),
    z.object({ type: z.literal('slack'), config: z.object({ webhookUrl: z.string().url() }) }),
    z.object({ type: z.literal('email'), config: z.object({ to: z.string().email(), subject: z.string().max(200).optional() }) }),
  ]),
});

const endpointBody = z.object({
  name: z.string().min(1).max(100),
  provider: z.enum(PROVIDERS).default('none'),
  secret: z.string().min(1).max(500).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(100000).optional(),
  active: z.boolean().optional(),
});

const present = (e) => ({
  id: e._id, name: e.name, provider: e.provider, hasSecret: !!e.secretEnc, active: e.active,
  rateLimitPerMinute: e.rateLimitPerMinute, ingestUrl: `${config.publicUrl}/in/${e.token}`, createdAt: e.createdAt,
});

function paginate(req) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const q = {};
  if (req.query.before && oid(req.query.before)) q._id = { $lt: req.query.before };
  return { limit, q };
}

export function apiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // --- signup (public) ---
  router.post('/signup', wrap(async (req, res) => {
    if (!config.allowSignup) return res.status(403).json({ error: 'signup disabled' });
    const rl = await rateLimit(`signup:${req.ip}`, 10, 3600_000);
    if (!rl.allowed) return res.status(429).json({ error: 'too many signups' });
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
    const apiKey = `hr_${randomToken(24)}`;
    const account = await Account.create({ name, apiKeyHash: sha256(apiKey), apiKeyPrefix: apiKey.slice(0, 7) });
    res.status(201).json({ account: { id: account._id, name }, apiKey });
  }));

  router.use(requireAuth);
  router.get('/me', (req, res) => res.json({ id: req.account._id, name: req.account.name, keyPrefix: req.account.apiKeyPrefix }));

  // --- endpoints ---
  router.get('/endpoints', wrap(async (req, res) => {
    res.json((await Endpoint.find({ accountId: req.account._id }).sort({ createdAt: -1 })).map(present));
  }));

  router.post('/endpoints', wrap(async (req, res) => {
    const b = endpointBody.parse(req.body);
    let secret = b.secret;
    let generated = false;
    if (b.provider === 'generic' && !secret) { secret = randomToken(24); generated = true; }
    if (b.provider !== 'none' && !secret) return res.status(400).json({ error: `provider ${b.provider} requires a secret` });
    const e = await Endpoint.create({
      accountId: req.account._id, name: b.name, provider: b.provider, token: randomToken(16),
      secretEnc: secret && b.provider !== 'none' ? encrypt(secret) : undefined,
      rateLimitPerMinute: b.rateLimitPerMinute ?? config.defaultIngestRateLimitPerMinute,
    });
    res.status(201).json({ ...present(e), ...(generated ? { generatedSecret: secret } : {}) });
  }));

  const findEndpoint = async (req, res) => {
    if (!oid(req.params.id)) { res.status(404).json({ error: 'not found' }); return null; }
    const e = await Endpoint.findOne({ _id: req.params.id, accountId: req.account._id });
    if (!e) res.status(404).json({ error: 'not found' });
    return e;
  };

  router.patch('/endpoints/:id', wrap(async (req, res) => {
    const e = await findEndpoint(req, res); if (!e) return;
    const b = endpointBody.partial().parse(req.body);
    if (b.name !== undefined) e.name = b.name;
    if (b.active !== undefined) e.active = b.active;
    if (b.rateLimitPerMinute !== undefined) e.rateLimitPerMinute = b.rateLimitPerMinute;
    if (b.provider !== undefined) e.provider = b.provider;
    if (b.secret !== undefined) e.secretEnc = encrypt(b.secret);
    if (e.provider !== 'none' && !e.secretEnc) return res.status(400).json({ error: 'provider requires a secret' });
    await e.save();
    res.json(present(e));
  }));

  router.delete('/endpoints/:id', wrap(async (req, res) => {
    const e = await findEndpoint(req, res); if (!e) return;
    await Promise.all([Rule.deleteMany({ endpointId: e._id }), e.deleteOne()]);
    res.status(204).end();
  }));

  // --- rules ---
  router.get('/endpoints/:id/rules', wrap(async (req, res) => {
    const e = await findEndpoint(req, res); if (!e) return;
    res.json(await Rule.find({ endpointId: e._id }).sort({ createdAt: 1 }));
  }));

  router.post('/endpoints/:id/rules', wrap(async (req, res) => {
    const e = await findEndpoint(req, res); if (!e) return;
    const b = ruleBody.parse(req.body);
    res.status(201).json(await Rule.create({ ...b, accountId: req.account._id, endpointId: e._id }));
  }));

  router.put('/rules/:id', wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const b = ruleBody.parse(req.body);
    const r = await Rule.findOneAndUpdate({ _id: req.params.id, accountId: req.account._id }, b, { new: true });
    r ? res.json(r) : res.status(404).json({ error: 'not found' });
  }));

  router.delete('/rules/:id', wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const r = await Rule.findOneAndDelete({ _id: req.params.id, accountId: req.account._id });
    r ? res.status(204).end() : res.status(404).json({ error: 'not found' });
  }));

  // Dry-run a filter + transform against a sample payload (powers the rule builder preview).
  router.post('/rules/test', wrap(async (req, res) => {
    const b = z.object({
      filter: ruleBody.shape.filter, transform: z.any().nullable().optional(),
      payload: z.any(), headers: z.record(z.any()).default({}),
    }).parse(req.body);
    const ctx = { body: b.payload, headers: b.headers, event: { id: 'evt_test', receivedAt: new Date().toISOString() } };
    const matched = matchesFilter(b.filter, ctx);
    res.json({ matched, output: matched ? applyTransform(b.transform, ctx) : null });
  }));

  // --- events & deliveries ---
  router.get('/events', wrap(async (req, res) => {
    const { limit, q } = paginate(req);
    q.accountId = req.account._id;
    if (req.query.endpointId && oid(req.query.endpointId)) q.endpointId = req.query.endpointId;
    if (['accepted', 'rejected'].includes(req.query.status)) q.status = req.query.status;
    const events = await Event.find(q, { rawBody: 0 }).sort({ _id: -1 }).limit(limit);
    res.json({ items: events, nextBefore: events.length === limit ? events.at(-1)._id : null });
  }));

  router.get('/events/:id', wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const event = await Event.findOne({ _id: req.params.id, accountId: req.account._id });
    if (!event) return res.status(404).json({ error: 'not found' });
    const deliveries = await Delivery.find({ eventId: event._id }).sort({ createdAt: 1 });
    res.json({ event, deliveries });
  }));

  router.post('/events/:id/replay', wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const event = await Event.findOne({ _id: req.params.id, accountId: req.account._id });
    if (!event) return res.status(404).json({ error: 'not found' });
    if (event.status === 'rejected') return res.status(409).json({ error: 'rejected events cannot be replayed' });
    const ruleId = req.body?.ruleId && oid(req.body.ruleId) ? req.body.ruleId : undefined;
    const deliveries = await fanOut(event, { replayOf: event._id, ruleId });
    res.status(202).json({ deliveries: deliveries.map((d) => d._id) });
  }));

  router.get('/deliveries', wrap(async (req, res) => {
    const { limit, q } = paginate(req);
    q.accountId = req.account._id;
    if (['pending', 'retrying', 'success', 'failed'].includes(req.query.status)) q.status = req.query.status;
    if (req.query.endpointId && oid(req.query.endpointId)) q.endpointId = req.query.endpointId;
    const items = await Delivery.find(q).sort({ _id: -1 }).limit(limit);
    res.json({ items, nextBefore: items.length === limit ? items.at(-1)._id : null });
  }));

  // Retry a single failed delivery as a fresh attempt chain (the failed one stays as audit history).
  router.post('/deliveries/:id/retry', wrap(async (req, res) => {
    if (!oid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const d = await Delivery.findOne({ _id: req.params.id, accountId: req.account._id });
    if (!d) return res.status(404).json({ error: 'not found' });
    if (d.status !== 'failed') return res.status(409).json({ error: `delivery is ${d.status}, only failed deliveries can be retried` });
    const nd = await Delivery.create({
      accountId: d.accountId, endpointId: d.endpointId, eventId: d.eventId, ruleId: d.ruleId,
      ruleName: d.ruleName, actionType: d.actionType, replayOf: d._id,
    });
    await enqueueDelivery(nd._id);
    res.status(202).json({ id: nd._id });
  }));

  router.get('/stats', wrap(async (req, res) => {
    const since = new Date(Date.now() - 86400_000);
    const [events, rejected, byStatus] = await Promise.all([
      Event.countDocuments({ accountId: req.account._id, receivedAt: { $gte: since } }),
      Event.countDocuments({ accountId: req.account._id, receivedAt: { $gte: since }, status: 'rejected' }),
      Delivery.aggregate([
        { $match: { accountId: req.account._id, createdAt: { $gte: since } } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);
    res.json({ events24h: events, rejected24h: rejected,
      deliveries24h: Object.fromEntries(byStatus.map((s) => [s._id, s.n])) });
  }));

  // --- live log stream (SSE). Auth via Authorization header, so clients use fetch streaming. ---
  router.get('/stream', wrap(async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(': connected\n\n');
    const unsub = await subscribe(String(req.account._id), (msg) => res.write(`data: ${msg}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); unsub(); });
  }));

  return router;
}
