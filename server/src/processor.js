import { UnrecoverableError } from 'bullmq';
import { Delivery, Event, Rule } from './models.js';
import { applyTransform } from './lib/transform.js';
import { runAction } from './actions/index.js';
import { publish } from './redis.js';
import { config } from './config.js';

const errText = (e) => `${e.code ? `${e.code}: ` : ''}${e.message}`.slice(0, 500);

/**
 * Processes one delivery job. A thrown error makes BullMQ retry with exponential backoff;
 * UnrecoverableError (permanent failures, e.g. HTTP 4xx) stops retrying immediately.
 */
export async function processDelivery(job) {
  const delivery = await Delivery.findById(job.data.deliveryId);
  if (!delivery) throw new UnrecoverableError('delivery not found (expired?)');
  if (delivery.status === 'success') return;

  const [event, rule] = await Promise.all([Event.findById(delivery.eventId), Rule.findById(delivery.ruleId)]);
  if (!event || !rule) {
    await finish(delivery, 'failed', 'event or rule no longer exists');
    throw new UnrecoverableError('event or rule missing');
  }

  const attemptNo = delivery.attemptCount + 1;
  const started = new Date();
  const templateContext = {
    body: event.body,
    headers: event.headers,
    event: { id: String(event._id), receivedAt: event.receivedAt, endpointId: String(event.endpointId) },
  };

  let attempt;
  try {
    const output = applyTransform(rule.transform, templateContext);
    delivery.output = output;
    const res = await runAction(rule.action, output, {
      eventId: event._id, deliveryId: delivery._id, templateContext,
    });
    attempt = { n: attemptNo, startedAt: started, durationMs: res.durationMs, statusCode: res.statusCode, responseSnippet: res.body };
    delivery.attempts.push(attempt);
    delivery.attemptCount = attemptNo;
    await finish(delivery, 'success');
  } catch (err) {
    attempt = {
      n: attemptNo, startedAt: started, durationMs: Date.now() - started.getTime(),
      statusCode: err.statusCode, error: errText(err), responseSnippet: err.responseSnippet,
    };
    delivery.attempts.push(attempt);
    delivery.attemptCount = attemptNo;
    const maxAttempts = job.opts.attempts ?? config.maxAttempts;
    const final = err.permanent || attemptNo >= maxAttempts;
    if (final) {
      await finish(delivery, 'failed', attempt.error);
      if (err.permanent) throw new UnrecoverableError(attempt.error);
    } else {
      const delay = config.backoffBaseMs * 2 ** (attemptNo - 1);
      delivery.nextRetryAt = new Date(Date.now() + delay);
      await finish(delivery, 'retrying', attempt.error);
    }
    throw err;
  }
}

async function finish(delivery, status, lastError) {
  delivery.status = status;
  if (lastError) delivery.lastError = lastError;
  if (status === 'success') { delivery.lastError = undefined; delivery.nextRetryAt = undefined; }
  if (status === 'success' || status === 'failed') { delivery.completedAt = new Date(); delivery.nextRetryAt = undefined; }
  delivery.markModified('output');
  await delivery.save();
  await publish(delivery.accountId, 'delivery', delivery.toObject());
}
