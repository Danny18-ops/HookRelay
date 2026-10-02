# HookRelay

A webhook relay and automation platform (think a small Hookdeck/Zapier). It receives webhooks from
Stripe, GitHub, Shopify or anything else, filters and transforms the payload with user-defined rules,
and **reliably delivers** the result to an HTTP URL, Slack or email — with retries, idempotency, rate
limiting, a full audit log, and one-click replay.

```
 Provider ──POST──▶ /in/:token ──▶ verify HMAC ──▶ rate limit ──▶ dedupe ──▶ store Event (Mongo)
                                                                                │ match rules
                                                                                ▼
 Dashboard ◀──SSE (Redis pub/sub)──────────────  Delivery rows ──▶ BullMQ queue (Redis)
                                                                                │
                                              worker: transform ▶ action ▶ record attempt
                                              fail ▶ exponential backoff ▶ … ▶ failed (replayable)
```

## Run it

```bash
docker compose up -d                       # MongoDB + Redis
cd server && cp .env.example .env && npm install && ALLOW_PRIVATE_TARGETS=true npm run dev   # API + embedded worker on :4000
cd web && npm install && npm run dev       # dashboard on :5173 (proxies /api and /in)
```

Open http://localhost:5173, create a workspace (you get an API key, shown once), create an endpoint,
add a rule, then send it a webhook:

```bash
BODY='{"type":"order.created","id":"o_1","total":42}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -X POST http://localhost:5173/in/<token> -H "content-type: application/json" \
     -H "x-signature-256: $SIG" -H "idempotency-key: o_1" -d "$BODY"
```

Production: set `EMBED_WORKER=false` and run `npm run worker` as separate process(es); workers scale horizontally.

## Features

- **Ingestion** — raw-body capture; HMAC verification for GitHub (`X-Hub-Signature-256`), Stripe
  (`Stripe-Signature`, with timestamp tolerance), Shopify (`X-Shopify-Hmac-Sha256`) and a generic
  `X-Signature-256`. Constant-time compares. Invalid signatures are stored as *rejected* events (visible
  in the log for debugging) but never delivered.
- **Idempotency** — sender-supplied IDs (`X-GitHub-Delivery`, `X-Shopify-Webhook-Id`, Stripe `evt_…`,
  `Idempotency-Key`) are enforced by a unique sparse index, so provider retries return `200 duplicate`
  instead of double-firing actions. Payload-derived keys are deliberately *not* guessed.
- **Rules** — filter conditions (`eq, neq, contains, startsWith, exists, gt, lt`; all/any) and a template
  transform (`{{body.user.name}}`, type-preserving for whole-value placeholders, `| default:'x'`).
  `POST /api/rules/test` dry-runs a rule; the UI uses it for a live preview.
- **Actions** — HTTP (optionally signed with `X-HookRelay-Signature: v1=HMAC(secret, "<ts>.<body>")`),
  Slack incoming webhook, email (SMTP via `SMTP_URL`; logs only when unset).
- **Reliable delivery** — one `Delivery` per (event, rule), run by BullMQ with exponential backoff
  (`BACKOFF_BASE_MS * 2^(n-1)`, `MAX_ATTEMPTS`). 5xx / network errors / 408 / 425 / 429 retry; other 4xx are
  permanent and fail immediately. Every attempt (status, latency, error, response snippet) is recorded.
- **Replay & retry** — replay an event through all (or one) rule, or retry a failed delivery. Replays create
  new deliveries linked via `replayOf`, so history is never overwritten.
- **Rate limiting** — Redis sliding-window counter per endpoint (ingest) and per API key (management API),
  with `Retry-After`.
- **Security** — API keys stored as SHA-256 hashes; signing secrets AES-256-GCM encrypted at rest; headers
  like `Authorization`/`Cookie` redacted from stored events; per-tenant isolation on every query;
  **SSRF guard** on outbound requests (private/loopback/link-local blocked, validated inside the socket's DNS
  lookup to defeat DNS rebinding, no redirect following).
- **Retention** — events and deliveries carry a TTL index (`RETENTION_DAYS`, default 14).
- **Dashboard** — live event log (SSE over Redis pub/sub, so it works across multiple API instances), collapsible
  JSON payload viewer, per-attempt delivery timeline, replay/retry buttons, rule builder with preview.

## Design notes / tradeoffs

- **Mongo write then Redis enqueue isn't atomic.** If Redis is down at ingest time the delivery row exists with
  no job; a reconciler sweeps stale `pending` deliveries every minute and re-enqueues them. Safe because
  `jobId = deliveryId`.
- **At-least-once delivery.** A worker crash after the target responded but before the attempt is saved will
  re-send. Receivers should dedupe on the `X-HookRelay-Event-Id` / `X-HookRelay-Delivery-Id` headers.
- The SSE endpoint authenticates with the `Authorization` header, so the dashboard reads it via `fetch`
  streaming rather than `EventSource` (which would force the API key into a URL).

## Tests

```bash
cd server && npm test      # needs MongoDB + Redis running (see docker compose)
```

Unit tests cover signatures, filter, transform, SSRF address checks and secret encryption. Integration tests
boot the real app + BullMQ worker against a flaky local target and verify transform + outbound signing,
bad-signature rejection, idempotency, retry-until-success, permanent 4xx failure, retry exhaustion, manual
retry, replay, rate limiting, tenant isolation, the SSRF guard and the orphan reconciler.

## API (Bearer API key)

| | |
|---|---|
| `POST /api/signup` | create workspace → API key (public) |
| `GET/POST /api/endpoints`, `PATCH/DELETE /api/endpoints/:id` | manage ingest endpoints |
| `GET/POST /api/endpoints/:id/rules`, `PUT/DELETE /api/rules/:id`, `POST /api/rules/test` | rules + dry run |
| `GET /api/events`, `GET /api/events/:id`, `POST /api/events/:id/replay` | log + replay |
| `GET /api/deliveries`, `POST /api/deliveries/:id/retry` | deliveries |
| `GET /api/stats`, `GET /api/stream` | 24h stats, live SSE |
