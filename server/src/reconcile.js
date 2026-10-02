import { Delivery } from './models.js';
import { enqueueDelivery } from './queue.js';

/**
 * Safety net for the Mongo-write / Redis-enqueue gap: if Redis was unreachable at ingest
 * time, the delivery row exists but has no job. Re-adding is safe because jobId = deliveryId.
 */
export async function reconcilePending(olderThanMs = 2 * 60_000) {
  const stale = await Delivery.find({
    status: 'pending',
    attemptCount: 0,
    createdAt: { $lt: new Date(Date.now() - olderThanMs) },
  }).limit(200);
  for (const d of stale) await enqueueDelivery(d._id);
  return stale.length;
}
