import { safeRequest } from '../lib/safeRequest.js';
import { hmacHex } from '../lib/crypto.js';
import { applyTransform } from '../lib/transform.js';
import { getMailer } from './mailer.js';
import { config } from '../config.js';

/** Thrown for failures retrying cannot fix (4xx, bad config); the worker stops retrying. */
export class PermanentError extends Error {
  constructor(msg, extra = {}) {
    super(msg);
    Object.assign(this, extra, { permanent: true });
  }
}

const RETRYABLE_4XX = new Set([408, 425, 429]);

function judge(res) {
  if (res.statusCode >= 200 && res.statusCode < 300) return res;
  const err = `HTTP ${res.statusCode}`;
  const extra = { statusCode: res.statusCode, responseSnippet: res.body };
  if (res.statusCode >= 400 && res.statusCode < 500 && !RETRYABLE_4XX.has(res.statusCode)) {
    throw new PermanentError(err, extra);
  }
  throw Object.assign(new Error(err), extra);
}

async function sendHttp(cfg, output, ctx) {
  const body = typeof output === 'string' ? output : JSON.stringify(output);
  const headers = {
    'content-type': typeof output === 'string' ? 'text/plain' : 'application/json',
    'user-agent': 'HookRelay/0.1',
    'x-hookrelay-event-id': String(ctx.eventId),
    'x-hookrelay-delivery-id': String(ctx.deliveryId),
    ...(cfg.headers || {}),
  };
  if (cfg.signingSecret) {
    const ts = Math.floor(Date.now() / 1000);
    headers['x-hookrelay-timestamp'] = String(ts);
    headers['x-hookrelay-signature'] = `v1=${hmacHex(cfg.signingSecret, `${ts}.${body}`)}`;
  }
  return judge(await safeRequest({ url: cfg.url, method: cfg.method || 'POST', headers, body }));
}

async function sendSlack(cfg, output) {
  const payload = typeof output === 'string' ? { text: output } : output;
  return judge(await safeRequest({
    url: cfg.webhookUrl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
}

async function sendEmail(cfg, output, ctx) {
  const mailer = getMailer();
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const subject = applyTransform(cfg.subject || 'HookRelay event', ctx.templateContext);
  const t0 = Date.now();
  try {
    const info = await mailer.sendMail({ from: config.emailFrom, to: cfg.to, subject: String(subject), text });
    return { statusCode: 250, body: info.messageId || 'sent', durationMs: Date.now() - t0 };
  } catch (e) {
    // 5xx SMTP responses are permanent rejections; everything else (connect, 4xx) is retryable.
    if (e.responseCode >= 500) throw new PermanentError(e.message);
    throw e;
  }
}

export async function runAction(action, output, ctx) {
  switch (action.type) {
    case 'http': return sendHttp(action.config, output, ctx);
    case 'slack': return sendSlack(action.config, output, ctx);
    case 'email': return sendEmail(action.config, output, ctx);
    default: throw new PermanentError(`unknown action type ${action.type}`);
  }
}
