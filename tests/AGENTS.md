# tests/ — Vitest

| Command | Runs | Needs |
|---|---|---|
| `npm test` | `*.test.ts` except `*.integration.test.ts` | nothing |
| `npm run test:integration` | only `*.integration.test.ts`, against real MySQL | Docker MySQL + `TEST_DATABASE_URL` (see `.env.example`) |

`scripts/run-integration.mjs` refuses any database that is not local or whose name does not end in `_test`, applies migrations, then runs Vitest with `RUN_MYSQL_TESTS=1`. `vitest.config.ts` switches the include pattern on that variable. Files run one at a time (`fileParallelism: false`).

| File | Covers |
|---|---|
| `graphql-client.test.ts` | Error classification, bounded retries, throttle wait, deadlines, abort |
| `product-mapping.test.ts` | GID/price validation, mapping |
| `sync.test.ts` | Sync decisions with everything mocked (cursor failure, re-auth Response) |
| `enrichment-validation.test.ts` | Badge text, colour, active, all-errors-at-once |
| `sync.integration.test.ts` | Real MySQL, mocked Shopify: pagination, idempotent re-run, enrichment survives, shop isolation, 130 variants, rollback, stale/revive, concurrent starts, abandoned run |
| `enrichment.integration.test.ts` | One enrichment per product, cross-shop access denied, idempotent remove, filters, keyset pagination |
| `webhook.test.ts` | `canReclaim` table, GID from payload, stale-event comparison |
| `webhook.integration.test.ts` | Real MySQL + fake `admin.graphql`: update/create, variant removal, duplicate, stale skip, in-transaction guard, null product, FAILED → retry with same id, tenant isolation, delete idempotency, inactive/unknown shop, concurrent claims, abandoned RECEIVED, log content. Also calls the route `action`s with requests signed by `crypto` HMAC, so the REAL `authenticate.webhook` runs: valid, forged, tampered body (401, no rows), duplicate, `app/uninstalled` receipt |
| `fixtures.ts` | `product(id, variants)` builds a GraphQL product node |

## Rules
- Integration tests create their own shops (random domain) and delete only those in `afterAll`. Never truncate or reset a database.
- Shopify is always mocked here. Live checks are the manual checklist in `docs/PHASES.md`.
- `webhook.integration.test.ts` sets `SHOPIFY_API_SECRET` etc. inside `vi.hoisted`, because `shopify.server.ts` reads env at import time and ES imports run before normal statements.
- It deletes only the receipts whose ids it generated.
- Not covered yet: `/api/v1` request tests (the feature does not exist). `products/update` through the route with a real session is not automated (needs a live token); it is on the manual checklist.
