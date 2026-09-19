# Phase 2 verification

## Automated evidence

Verified in this workspace:

| Check | Result |
|---|---|
| `npm test` | 23 focused tests passed |
| `npm run test:integration` | 10 tests passed against real MySQL 8 |
| `npm run typecheck` | Passed after replacing unsupported navigation markup with the installed App Bridge NavMenu component |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| Shopify AI Toolkit GraphQL validation | ShopIdentity, ProductsPage and ProductVariantsPage valid for 2026-07; read_products only |

The integration suite uses mocked Shopify responses and a real MySQL database. It proves database behavior, not a live Shopify installation or browser flow.

Run locally:

```sh
docker compose up -d mysql
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
```

Set `TEST_DATABASE_URL` in `.env` using `.env.example`. For the provided Docker service, an explicit test invocation is:

```sh
TEST_DATABASE_URL='mysql://app:app@127.0.0.1:3307/enrichment_hub_test' npm run test:integration
```

These are local disposable database credentials from docker-compose.yml. The runner refuses non-local databases and names without the `_test` suffix. It applies existing migrations and removes only its own generated shop fixtures; it does not reset any database.

## Live development-store check

Current attempt: blocked before starting a sync because the local database had no unexpired offline Shopify session. No Shopify catalog data was changed. Open the installed app in Shopify Admin to refresh its session, then complete this checklist. Earlier live testing recorded in LEARNING.md predates these changes.

- [ ] Open the app inside the development store's Shopify Admin. Confirm shop identity and the Sync now button appear.
- [ ] With at least 20 test products (or the full available smaller catalog), click Sync now. Expect SUCCEEDED and matching local product/variant counts.
- [ ] Click Sync now again without changing the catalog. Expect zero insertions, existing products updated, and unchanged total counts.
- [ ] Rename one test product in Shopify Admin, sync, and verify its local title updates while its local row ID remains the same.
- [ ] Test a product with more than 25 variants. Verify all variants are copied.
- [ ] Remove a disposable test product in Shopify, sync, and verify its local row is soft-deleted only after success. Do this only with intentionally disposable development data.
- [ ] Check Reconcile completes the same workflow and records type RECONCILE.
- [ ] Check expired-session behavior through the app: authentication recovers or requests reauthentication; no generic unknown-error loop.

Badge preservation, transaction rollback, conflict protection, failure recovery and tenant isolation are already covered by the automated real-MySQL suite. A badge editor and product webhook delivery are later phases.

## Known limits

- No background queue. A 60-second cooperative work budget is checked between operations, API requests abort after at most 10 seconds (or remaining budget), and database transactions allow at most 30 seconds. Database connection failures can affect total wall-clock time. This is not a strict end-to-end latency guarantee.
- A process crash can leave a run marked RUNNING; a subsequent start replaces it after 15 minutes. Replaced runs are prevented from committing new pages.
- Cursor checkpoints are diagnostic; retries begin from page one.
- A changing Shopify catalog is not a snapshot. Extra variant pages are checked against the product's updatedAt; other concurrent changes may require another reconciliation.
- Failed product counts describe received nodes that did not commit, not products on pages that were never received.
