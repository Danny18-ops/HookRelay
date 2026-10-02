import 'dotenv/config';
import crypto from 'node:crypto';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

const encryptionKey = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : crypto.createHash('sha256').update('hookrelay-insecure-dev-key').digest();

if (encryptionKey.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
}

export const config = {
  port: int(process.env.PORT, 4000),
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/hookrelay',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:4000').replace(/\/$/, ''),
  encryptionKey,
  // Delivery retries: attempt n waits backoffBaseMs * 2^(n-1)
  maxAttempts: int(process.env.MAX_ATTEMPTS, 6),
  backoffBaseMs: int(process.env.BACKOFF_BASE_MS, 5000),
  workerConcurrency: int(process.env.WORKER_CONCURRENCY, 10),
  deliveryTimeoutMs: int(process.env.DELIVERY_TIMEOUT_MS, 10000),
  // Log cleanup relies on Mongo TTL indexes. Only disable for Mongo-compatible stores lacking them (e.g. FerretDB).
  ttlIndexes: process.env.DISABLE_TTL_INDEXES !== 'true',
  retentionDays: int(process.env.RETENTION_DAYS, 14),
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 1024 * 1024),
  apiRateLimitPerMinute: int(process.env.API_RATE_LIMIT_PER_MINUTE, 300),
  defaultIngestRateLimitPerMinute: int(process.env.INGEST_RATE_LIMIT_PER_MINUTE, 120),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  // Outbound targets on private/loopback ranges are blocked unless explicitly allowed (dev only).
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === 'true',
  queueName: process.env.QUEUE_NAME || 'deliveries',
  smtpUrl: process.env.SMTP_URL || '',
  emailFrom: process.env.EMAIL_FROM || 'HookRelay <noreply@hookrelay.local>',
};
