# app/services/ — business logic

| File | Exports | Notes |
|---|---|---|
| `shop.server.ts` | `normalizeShopDomain`, `recordInstall`, `recordUninstall`, `requireActiveShop`, `recordScopesUpdate` | Tenant layer. `requireActiveShop(domain)` returns the `Shop` row or throws 403. `recordUninstall` sets `uninstalledAt` and deletes sessions in one transaction; it is idempotent |
| `sync.server.ts` | `startSyncRun`, `runProductSync`, `completeVariants` (also used by webhooks), `getLatestSyncRun`, `SyncConflictError`, `SYNC_BUDGET_MS` | Full catalog sync. RECONCILE runs the same code with a different `type` |
| `webhook.server.ts` | `processWebhook`, `handleProductUpdate`, `handleProductDelete`, `productGidFromPayload`, `isStaleEvent`, type `VerifiedWebhook` | Webhook pipeline, see below |
| `product-mapping.ts` | `mapProductNode`, `MappingError`, node/record types | Pure. Validates GID and price formats, converts a GraphQL node to DB fields. No DB or network |
| `enrichment-validation.ts` | `validateEnrichment`, `BADGE_TEXT_MAX` (40), `INTERNAL_NOTE_MAX` (2000) | Pure. Returns `{ok:true,value}` or `{ok:false,errors}` with all field errors. Colour must be `#RRGGBB`, stored uppercase. `active` defaults to true. Must be reused by the future `/api/v1` API |

## How the sync works (`sync.server.ts`)
1. `startSyncRun`: `SELECT ... FOR UPDATE` on the shop row. A RUNNING run younger than 15 min → `SyncConflictError`; older → marked FAILED "Abandoned". Creates the `sync_runs` row.
2. Query `ShopIdentity`, save shop GID and name.
3. Loop pages of 25 products. Network calls happen OUTSIDE transactions. `completeVariants` fetches extra variant pages (100) and fails if the product's `updatedAt` changed meanwhile.
4. One transaction per page: `lockActiveRun` (rechecks shop installed + run still RUNNING) → upserts → counters + cursor.
5. Only after the last page: `markStaleProducts` (soft delete rows with `syncedAt` older than run start) + SUCCEEDED. A failed run never marks anything stale.
6. Any error → FAILED with message; committed pages stay. Re-run restarts from page one (cursor is diagnostic only). A thrown `Response` is rethrown after recording failure.

Bounds: 60s work budget checked between operations, 400 product pages, 100 variant pages per product, 30s per transaction.

## How webhooks work (`webhook.server.ts`)
Input is always the verified result of `authenticate.webhook` (the route does that first).
1. `processWebhook`: look up the shop by the verified domain → `claimReceipt` (INSERT `RECEIVED`; unique `webhookId`). Duplicate → log + 200, handler never runs.
2. `requireActiveShop: true` and shop unknown/uninstalled → receipt `PROCESSED` with note "ignored: shop not active", 200.
3. Handler runs and calls `finish(tx, note?)`, which marks the receipt `PROCESSED` inside the handler's transaction. A deliberate skip is `PROCESSED` with a note in `error`.
4. Handler throws → receipt `FAILED` (message cut to 1000 chars, never the payload) → `logger.error` → **500** so Shopify retries with the same `webhookId`; a `FAILED` receipt may be claimed again.

`handleProductUpdate`: the payload supplies only the product id and `updated_at`. Cheap skip if the event is older than our `updatedAtShopify` → otherwise re-fetch with `PRODUCT_BY_ID_QUERY` (client: 1 attempt, 3s timeout, 4s budget, because Shopify fails a delivery after 5s) → `product: null` = skip → `completeVariants` → `mapProductNode` → transaction { `upsertProductIfNewer`; finish }. Unknown local product is created. No offline session → throws → `FAILED` + 500.

`handleProductDelete`: payload is `{ id }` → GID → transaction { `softDeleteProductByGid`; finish }. 0 rows matched is a normal no-op.

Limits: processing is synchronous inside the request; there is no queue or replay. If all of Shopify's retries fail the receipt stays `FAILED` and Reconcile repairs the data. The full sync does not use the newer-than guard, so a sync page fetched before a webhook commit can briefly write the older copy; the next event or Reconcile corrects it.

## Rules
- The sync never writes `product_enrichments`.
- Services take `shopId` as a parameter; they never read it from a request.
