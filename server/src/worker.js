import { Worker } from 'bullmq';
import { config } from './config.js';
import { connectDb } from './models.js';
import { makeRedis } from './redis.js';
import { processDelivery } from './processor.js';
import { reconcilePending } from './reconcile.js';

export function startWorker() {
  const worker = new Worker(config.queueName, processDelivery, {
    connection: makeRedis(),
    concurrency: config.workerConcurrency,
  });
  worker.on('failed', (job, err) =>
    console.warn(`[worker] delivery ${job?.data?.deliveryId} attempt ${job?.attemptsMade} failed: ${err.message}`));
  const timer = setInterval(() => reconcilePending().catch((e) => console.error('[reconcile]', e)), 60_000);
  timer.unref();
  return { worker, stop: async () => { clearInterval(timer); await worker.close(); } };
}

// Run standalone: `npm run worker`
if (import.meta.url === `file://${process.argv[1]}`) {
  await connectDb();
  const { stop } = startWorker();
  console.log('[worker] started');
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop().then(() => process.exit(0)));
}
