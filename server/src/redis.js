import { Redis } from 'ioredis';
import { config } from './config.js';

// BullMQ requires maxRetriesPerRequest: null on its connections.
export const makeRedis = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export const redis = makeRedis();

const channel = (accountId) => `hr:account:${accountId}`;

/** Fan a live-update message out to every API process streaming this account's logs. */
export const publish = (accountId, type, data) =>
  redis.publish(channel(accountId), JSON.stringify({ type, data })).catch(() => {});

export async function subscribe(accountId, onMessage) {
  const sub = makeRedis();
  await sub.subscribe(channel(accountId));
  sub.on('message', (_c, m) => onMessage(m));
  return () => sub.quit().catch(() => {});
}
