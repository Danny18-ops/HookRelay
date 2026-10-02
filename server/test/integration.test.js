import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const run = crypto.randomBytes(4).toString('hex');
process.env.MONGO_URL = process.env.MONGO_URL || `mongodb://127.0.0.1:27017/hookrelay_test_${run}`;
process.env.QUEUE_NAME = `test-${run}`;
process.env.BACKOFF_BASE_MS = '40';
process.env.MAX_ATTEMPTS = '4';
process.env.ALLOW_PRIVATE_TARGETS = 'true';

const { config } = await import('../src/config.js');
const { connectDb, disconnectDb } = await import('../src/models.js');
const { createApp } = await import('../src/app.js');
const { startWorker } = await import('../src/worker.js');
const { deliveryQueue } = await import('../src/queue.js');
const { redis } = await import('../src/redis.js');
const { safeRequest } = await import('../src/lib/safeRequest.js');

let api, worker, targetServer, base, target;
const received = [];
let failuresLeft = 0;
let targetStatus = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await sleep(30);
  }
}
const j = async (method, path, body, key) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

before(async () => {
  await connectDb();
  api = createApp().listen(0);
  base = `http://127.0.0.1:${api.address().port}`;
  worker = startWorker();
  targetServer = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: b });
      if (failuresLeft > 0) { failuresLeft--; res.writeHead(500).end('boom'); return; }
      res.writeHead(targetStatus).end('ok');
    });
  }).listen(0);
  target = `http://127.0.0.1:${targetServer.address().port}/hook`;
});

after(async () => {
  await worker.stop();
  await deliveryQueue.obliterate({ force: true }).catch(() => {});
  await deliveryQueue.close();
  const mongoose = (await import('mongoose')).default;
  await mongoose.connection.dropDatabase().catch(() => {});
  await disconnectDb();
  await redis.quit();
  api.close(); targetServer.close();
});

const sign = (secret, raw) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
let key, endpoint, rule;

async function setup(extra = {}) {
  const su = await j('POST', '/api/signup', { name: 'acme' });
  key = su.json.apiKey;
  const ep = await j('POST', '/api/endpoints', { name: 'gh', provider: 'github', secret: 's3cret', ...extra }, key);
  endpoint = ep.json;
  const r = await j('POST', `/api/endpoints/${endpoint.id}/rules`, {
    name: 'push to target',
    filter: { match: 'all', conditions: [{ path: 'body.action', op: 'eq', value: 'opened' }] },
    transform: { title: 'PR: {{body.title}}', number: '{{body.number}}' },
    action: { type: 'http', config: { url: target, signingSecret: 'out-secret' } },
  }, key);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  rule = r.json;
}

async function send(body, { secret = 's3cret', headers = {} } = {}) {
  const raw = JSON.stringify(body);
  const res = await fetch(endpoint.ingestUrl.replace(config.publicUrl, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret, raw), ...headers },
    body: raw,
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

const deliveriesFor = async (eventId) => (await j('GET', `/api/events/${eventId}`, undefined, key)).json.deliveries;

test('management API requires auth and hides secrets', async () => {
  await setup();
  assert.equal((await j('GET', '/api/endpoints')).status, 401);
  assert.equal((await j('GET', '/api/endpoints', undefined, 'hr_bogus')).status, 401);
  const list = await j('GET', '/api/endpoints', undefined, key);
  assert.equal(list.json[0].hasSecret, true);
  assert.equal(JSON.stringify(list.json).includes('s3cret'), false);
  assert.equal(JSON.stringify(list.json).includes('secretEnc'), false);
});

test('rejects bad signature, stores it as rejected, never delivers', async () => {
  const before = received.length;
  const r = await send({ action: 'opened' }, { secret: 'wrong' });
  assert.equal(r.status, 401);
  const events = (await j('GET', '/api/events?status=rejected', undefined, key)).json.items;
  assert.equal(events.length, 1);
  assert.equal(events[0].signatureValid, false);
  await sleep(150);
  assert.equal(received.length, before);
});

test('valid event is transformed, signed, delivered and logged', async () => {
  const before = received.length;
  const r = await send({ action: 'opened', title: 'Fix bug', number: 7 }, { headers: { 'x-github-delivery': 'd-1' } });
  assert.equal(r.status, 202);
  assert.equal(r.json.deliveries, 1);
  await until(() => received.length === before + 1);
  const got = received.at(-1);
  assert.deepEqual(JSON.parse(got.body), { title: 'PR: Fix bug', number: 7 });
  const ts = got.headers['x-hookrelay-timestamp'];
  const expected = crypto.createHmac('sha256', 'out-secret').update(`${ts}.${got.body}`).digest('hex');
  assert.equal(got.headers['x-hookrelay-signature'], `v1=${expected}`);
  const [d] = await until(async () => {
    const ds = await deliveriesFor(r.json.id);
    return ds[0]?.status === 'success' ? ds : null;
  });
  assert.equal(d.attemptCount, 1);
  assert.equal(d.attempts[0].statusCode, 200);
});

test('duplicate delivery id is acknowledged but not re-processed (idempotency)', async () => {
  const before = received.length;
  const r = await send({ action: 'opened', title: 'Fix bug', number: 7 }, { headers: { 'x-github-delivery': 'd-1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.duplicate, true);
  await sleep(150);
  assert.equal(received.length, before);
});

test('non-matching filter creates no deliveries', async () => {
  const r = await send({ action: 'closed' }, { headers: { 'x-github-delivery': 'd-2' } });
  assert.equal(r.status, 202);
  assert.equal(r.json.deliveries, 0);
});

test('5xx is retried with backoff until it succeeds', async () => {
  failuresLeft = 2;
  const r = await send({ action: 'opened', title: 'flaky', number: 1 }, { headers: { 'x-github-delivery': 'd-3' } });
  const [d] = await until(async () => {
    const ds = await deliveriesFor(r.json.id);
    return ds[0]?.status === 'success' ? ds : null;
  });
  assert.equal(d.attemptCount, 3);
  assert.deepEqual(d.attempts.map((a) => a.statusCode), [500, 500, 200]);
  assert.match(d.attempts[0].error, /HTTP 500/);
});

let failedDelivery;
test('4xx is permanent: fails after a single attempt, then can be retried manually', async () => {
  targetStatus = 400;
  const r = await send({ action: 'opened', title: 'bad', number: 2 }, { headers: { 'x-github-delivery': 'd-4' } });
  const [d] = await until(async () => {
    const ds = await deliveriesFor(r.json.id);
    return ds[0]?.status === 'failed' ? ds : null;
  });
  assert.equal(d.attemptCount, 1);
  failedDelivery = d;

  targetStatus = 200;
  const retry = await j('POST', `/api/deliveries/${d._id}/retry`, {}, key);
  assert.equal(retry.status, 202);
  await until(async () => {
    const ds = await deliveriesFor(r.json.id);
    return ds.find((x) => String(x._id) === retry.json.id)?.status === 'success';
  });
  assert.equal((await j('POST', `/api/deliveries/${retry.json.id}/retry`, {}, key)).status, 409);
});

test('exhausting all attempts marks the delivery failed', async () => {
  failuresLeft = 100;
  const r = await send({ action: 'opened', title: 'down', number: 3 }, { headers: { 'x-github-delivery': 'd-5' } });
  const [d] = await until(async () => {
    const ds = await deliveriesFor(r.json.id);
    return ds[0]?.status === 'failed' ? ds : null;
  });
  failuresLeft = 0;
  assert.equal(d.attemptCount, config.maxAttempts);
});

test('replay re-delivers a stored event', async () => {
  const events = (await j('GET', '/api/events?status=accepted', undefined, key)).json.items;
  const ev = events.find((e) => e.body?.title === 'Fix bug');
  const before = received.length;
  const rp = await j('POST', `/api/events/${ev._id}/replay`, {}, key);
  assert.equal(rp.status, 202);
  assert.equal(rp.json.deliveries.length, 1);
  await until(() => received.length === before + 1);
  const detail = (await j('GET', `/api/events/${ev._id}`, undefined, key)).json;
  assert.equal(detail.deliveries.length, 2);
  assert.ok(detail.deliveries.some((d) => d.replayOf));
  // rejected events can't be replayed
  const rej = (await j('GET', '/api/events?status=rejected', undefined, key)).json.items[0];
  assert.equal((await j('POST', `/api/events/${rej._id}/replay`, {}, key)).status, 409);
});

test('per-endpoint rate limiting returns 429 with Retry-After', async () => {
  const ep = await j('POST', '/api/endpoints', { name: 'limited', rateLimitPerMinute: 3 }, key);
  const url = ep.json.ingestUrl.replace(config.publicUrl, base);
  const codes = [];
  let last;
  for (let i = 0; i < 5; i++) {
    last = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ i }) });
    codes.push(last.status);
  }
  assert.deepEqual(codes, [202, 202, 202, 429, 429]);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});

test('tenant isolation', async () => {
  const other = (await j('POST', '/api/signup', { name: 'evil' })).json.apiKey;
  assert.equal((await j('GET', '/api/endpoints', undefined, other)).json.length, 0);
  assert.equal((await j('GET', `/api/endpoints/${endpoint.id}/rules`, undefined, other)).status, 404);
  const events = (await j('GET', '/api/events', undefined, key)).json.items;
  assert.equal((await j('GET', `/api/events/${events[0]._id}`, undefined, other)).status, 404);
  assert.equal((await j('POST', `/api/events/${events[0]._id}/replay`, {}, other)).status, 404);
});

test('rule validation and dry-run endpoint', async () => {
  const bad = await j('POST', `/api/endpoints/${endpoint.id}/rules`, { name: 'x', action: { type: 'http', config: { url: 'not-a-url' } } }, key);
  assert.equal(bad.status, 400);
  const t = await j('POST', '/api/rules/test', {
    filter: { match: 'all', conditions: [{ path: 'body.n', op: 'gt', value: 1 }] },
    transform: { msg: 'n={{body.n}}' }, payload: { n: 5 },
  }, key);
  assert.deepEqual(t.json, { matched: true, output: { msg: 'n=5' } });
});

test('SSRF guard blocks private targets when not allowed', async () => {
  config.allowPrivateTargets = false;
  try {
    await assert.rejects(safeRequest({ url: 'http://127.0.0.1:1/x', method: 'POST', body: '{}' }), /blocked/);
    await assert.rejects(safeRequest({ url: 'http://localhost:1/x', method: 'POST', body: '{}' }), /blocked/);
    await assert.rejects(safeRequest({ url: 'http://169.254.169.254/latest', method: 'POST', body: '{}' }), /blocked/);
  } finally { config.allowPrivateTargets = true; }
});

test('reconciler enqueues deliveries orphaned by a failed enqueue', async () => {
  const { Delivery } = await import('../src/models.js');
  const { reconcilePending } = await import('../src/reconcile.js');
  const events = (await j('GET', '/api/events?status=accepted', undefined, key)).json.items;
  const ev = events.find((e) => e.body?.title === 'Fix bug');
  const before = received.length;
  const d = await Delivery.create({
    accountId: ev.accountId, endpointId: ev.endpointId, eventId: ev._id, ruleId: rule._id,
    ruleName: 'x', actionType: 'http', createdAt: new Date(Date.now() - 10 * 60_000),
  });
  assert.ok(await reconcilePending() >= 1);
  await until(async () => (await Delivery.findById(d._id)).status === 'success');
  assert.equal(received.length, before + 1);
});
