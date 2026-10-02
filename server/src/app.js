import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { ingestRouter } from './routes/ingest.js';
import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: true }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/in', ingestRouter());
  app.use('/api', apiRouter());

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'validation failed', issues: err.issues });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });
  return app;
}
