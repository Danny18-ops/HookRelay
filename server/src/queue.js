import { Queue } from 'bullmq';
import { config } from './config.js';
import { redis } from './redis.js';

export const deliveryQueue = new Queue(config.queueName, {
  connection: redis,
  defaultJobOptions: {
    attempts: config.maxAttempts,
    backoff: { type: 'exponential', delay: config.backoffBaseMs },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 },
  },
});

/** jobId = deliveryId makes enqueueing idempotent, so the reconciler can safely re-add. */
export const enqueueDelivery = (deliveryId) =>
  deliveryQueue.add('deliver', { deliveryId: String(deliveryId) }, { jobId: String(deliveryId) });
