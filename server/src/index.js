import { config } from './config.js';
import { connectDb } from './models.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';

await connectDb();
const server = createApp().listen(config.port, () => console.log(`[api] listening on :${config.port}`));
// Embedded worker keeps single-process dev simple; set EMBED_WORKER=false and run `npm run worker` in prod.
const w = process.env.EMBED_WORKER === 'false' ? null : startWorker();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { server.close(); await w?.stop(); process.exit(0); });
}
