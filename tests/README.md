# tests/ — Vitest

## What this folder is
All automated tests. Two kinds: unit tests that need nothing, and integration tests that run the real route handlers and repositories against a real MySQL test database. Shopify itself is always mocked; checks against a live development store are the manual lists in `docs/VERIFICATION.md`.

How the assignment's required tests map to files: badge validation → `enrichment-validation.test.ts`; GraphQL mapping → `product-mapping.test.ts`; a sync decision path → `sync.test.ts`; repository upserts and repeated sync/webhook → `sync.integration.test.ts`, `webhook.integration.test.ts`; request tests (401, tenant scoping, valid write, bad payload, missing product) → `api.integration.test.ts`; raw-body webhook signature tests → `webhook.integration.test.ts`; storefront badge states → `storefront.integration.test.ts` plus the manual theme checklist.

| Command | Runs | Needs |
|---|---|---|
| `npm test` | `*.test.ts` except `*.integration.test.ts` | nothing |
| `npm run test:integration` | only `*.integration.test.ts`, against real MySQL | Docker MySQL + `TEST_DATABASE_URL` (see `.env.example`) |

`scripts/run-integration.mjs` refuses any database that is not local or whose name does not end in `_test`, applies migrations, then runs Vitest with `RUN_MYSQL_TESTS=1`. `vitest.config.ts` switches the include pattern on that variable. Files run one at a time (`fileParallelism: false`).

| File | Covers |
|---|---|
| `graphql-client.test.ts` | Error classification, bounded retries, throttle wait, deadlines, abort |
| `product-mapping.test.ts` | GID/price validation, mapping |
| `sync.test.ts` | Sync decisions with everything mocked (mapping failure, missing cursor, re-auth Response, expired work budget) |
| `enrichment-validation.test.ts` | Badge text, colour, active, all-errors-at-once |
| `sync.integration.test.ts` | Real MySQL, mocked Shopify: pagination, idempotent re-run, enrichment survives, shop isolation, 130 variants, rollback, stale/revive, concurrent starts, abandoned run |
| `enrichment.integration.test.ts` | One enrichment per product, cross-shop access denied, idempotent remove, filters, keyset pagination |
| `webhook.test.ts` | `canReclaim` table, GID from payload, stale-event comparison |
| `webhook.integration.test.ts` | Real MySQL + fake `admin.graphql`: update/create, variant removal, duplicate, stale skip, in-transaction guard, null product, FAILED → retry with same id, tenant isolation, delete idempotency, inactive/unknown shop, concurrent claims, abandoned RECEIVED, log content. Also calls the route `action`s with requests signed by `crypto` HMAC, so the REAL `authenticate.webhook` runs: valid, forged, tampered body (401, no rows), duplicate, `app/uninstalled` receipt |
| `api.test.ts` | Key format/hash, rate limiter with injected clock, product id parsing, cursor round-trip |
| `api.integration.test.ts` | Calls the `/api/v1` route `loader`/`action` with real `Request`s against MySQL: identical 401 for 5 bad-credential kinds, hash-only storage, `lastUsedAt` throttle, failed-login and per-key 429, 405, list filters/pagination, strict 400s, detail, PUT 201/200/422/400/413, cross-shop 404, DELETE 204 twice, sync 202 + background finish, 409 conflict, 409 no session with no run created. `shopify.server` is mocked (only `unauthenticated.admin`) |
| `badge-contrast.test.ts` | Text colour choice; 4.5:1 contrast holds across 4096 sampled colours |
| `storefront.integration.test.ts` | Calls the proxy route with a query signed like Shopify's app proxy (sorted `key=value`, HMAC-SHA256 hex, app secret), so the REAL `authenticate.public.appProxy` runs: active badge (no `internalNote` in body or logs, cache header), 9 identical empty cases incl. cross-shop, tampered/unsigned → 400, 429. Batch route `proxy.badges` with `ids` inside the signed query: several products → map by Shopify id, every unavailable kind absent (checked from both shops), uninstalled/unknown shop → `{}`, 9 malformed/oversized lists → 400 `no-store` and exactly 50 allowed, tampered/unsigned → 400, rate limit shared with the single route and counted per request |
| `fixtures.ts` | `product(id, variants)` builds a GraphQL product node |

## Rules
- Integration tests create their own shops (random domain) and delete only those in `afterAll`. Never truncate or reset a database.
- Shopify is always mocked here. Live checks are the manual checklist in `docs/VERIFICATION.md`.
- `webhook.integration.test.ts` and `storefront.integration.test.ts` set `SHOPIFY_API_SECRET` etc. inside `vi.hoisted`, because `shopify.server.ts` reads env at import time and ES imports run before normal statements.
- The webhook test deletes only the receipts whose ids it generated.
- API tests call `resetRateLimitsForTests()` in `beforeEach`, because the limiters are module-level state.
- Liquid and the block's JS cannot run in Vitest. `shopify theme check --path extensions/product-badge` lints them; rendering is on the manual checklist in `docs/VERIFICATION.md`.
- Not covered yet: `products/update` through the route with a real session is not automated (needs a live token); it is on the manual checklist.
