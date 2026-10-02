import { Account } from './models.js';
import { sha256 } from './lib/crypto.js';
import { rateLimit } from './lib/rateLimit.js';
import { config } from './config.js';

/** Bearer API-key auth; keys are stored only as SHA-256 hashes. */
export async function requireAuth(req, res, next) {
  try {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'missing bearer API key' });
    const account = await Account.findOne({ apiKeyHash: sha256(m[1]) });
    if (!account) return res.status(401).json({ error: 'invalid API key' });
    const rl = await rateLimit(`api:${account._id}`, config.apiRateLimitPerMinute);
    if (!rl.allowed) return res.set('Retry-After', String(rl.retryAfterSec)).status(429).json({ error: 'rate limit exceeded' });
    req.account = account;
    next();
  } catch (e) { next(e); }
}
