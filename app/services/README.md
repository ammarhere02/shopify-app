# app/services/ — business logic

## What this folder is
The rules of the app, kept out of the routes so they can be tested without HTTP. Five services matter most:

- **Tenant** (`shop.server.ts`): install, uninstall, and "is this shop allowed right now".
- **Sync** (`sync.server.ts`): copies the Shopify catalog into MySQL, page by page, safely repeatable.
- **Webhooks** (`webhook.server.ts`): one pipeline that records a receipt, drops duplicates and picks the status code.
- **Developer API** (`api.server.ts`, `api-key.server.ts`): API key authentication, rate limits, the error envelope.
- **Storefront badge** (`storefront-badge.server.ts`): the only code allowed to answer the public.

Files without `.server` in the name are pure functions with no database or network, which is why they have plain unit tests.

| File | Exports | Notes |
|---|---|---|
| `shop.server.ts` | `normalizeShopDomain`, `recordInstall`, `recordUninstall`, `requireActiveShop`, `recordScopesUpdate` | Tenant layer. `requireActiveShop(domain)` returns the `Shop` row or throws 403. `recordUninstall` sets `uninstalledAt` and deletes sessions in one transaction; it is idempotent |
| `sync.server.ts` | `startSyncRun`, `runProductSync`, `completeVariants` (also used by webhooks), `getLatestSyncRun`, `SyncConflictError`, `SYNC_BUDGET_MS` | Full catalog sync. RECONCILE runs the same code with a different `type` |
| `webhook.server.ts` | `processWebhook`, `handleProductUpdate`, `handleProductDelete`, `productGidFromPayload`, `isStaleEvent`, type `VerifiedWebhook` | Webhook pipeline, see below |
| `api.server.ts` | `withApiAuth`, `ApiError`, `json`, `productGidFromParam`, `encodeCursor`/`decodeCursor`, `readJsonBody`, `serializeProduct`, `serializeEnrichment`, `resetRateLimitsForTests` | Developer API pipeline, see below |
| `api-key.server.ts` | `generateApiKey`, `hashApiKey`, `createApiKey`, `authenticateApiKey` | Key = `eh_live_` + 32 random bytes (base64url). Only SHA-256 hex + 12-char prefix are stored. `authenticateApiKey` returns the key's shop or a failure reason for logs |
| `storefront-badge.server.ts` | `getStorefrontBadge(shopDomain, idParam, ip)`, `getStorefrontBadges(shopDomain, idsParam, ip)`, `STOREFRONT_CACHE_SECONDS` (60), `STOREFRONT_BATCH_MAX` (50) | PUBLIC surface. Input shop must come from a request verified by `authenticate.public.appProxy`. Unknown/uninstalled shop, bad id, unknown/DRAFT/ARCHIVED/soft-deleted product, no badge, inactive badge → all the same `badge: null`. Rate limit 120/min per shop+IP (in memory). Re-checks the hex colour and adds `textColor`. Batch form: `idsParam` is `"1,2,3"`; 1–50 ids each matching `^[1-9]\d{0,19}$` or the result is `invalid` (checked before any DB work); duplicates count once; one limiter hit per request from the SAME limiter; returns a map keyed by Shopify product id with only the badges to show. `STOREFRONT_BATCH_MAX` must stay ≥ `BATCH_MAX` in the extension's JS |
| `sync-run-view.ts` | `serializeSyncRun` | Public shape of a sync run (no cursor) |
| `product-mapping.ts` | `mapProductNode`, `MappingError`, node/record types | Pure. Validates GID and price formats, converts a GraphQL node to DB fields. No DB or network |
| `enrichment-validation.ts` | `validateEnrichment`, `BADGE_TEXT_MAX` (40), `INTERNAL_NOTE_MAX` (2000) | Pure. Returns `{ok:true,value}` or `{ok:false,errors}` with all field errors. Colour must be `#RRGGBB`, stored uppercase. `active` defaults to true. Used by both the admin editor and `PUT /api/v1/products/:id/enrichment` |

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

## How the developer API works (`api.server.ts`)
`withApiAuth(request, { methods, bucket }, handler)`:
1. New `requestId` (also sent as `X-Request-Id`). Wrong method → 405.
2. IP already has 20 failed logins this minute → 429.
3. `Authorization: Bearer <key>` → hash → `developer_api_keys` row with its shop. Missing, malformed, unknown, revoked, or shop uninstalled → the SAME 401 body + `WWW-Authenticate: Bearer`; the real reason is only logged as `authFailure`.
4. Per-key limit keyed by the key's DB id: 60/min, or 5/min for the `sync` bucket → 429 + `Retry-After`.
5. `lastUsedAt` is written only if older than 60s.
6. Handler gets `{ shop, requestId, request }`. `ApiError` → `{ error: { code, message, details?, requestId } }`; any other exception → 500 `internal_error` with no internals.
7. One `api.request` log line: requestId, method, route, shopId, keyId, status, durationMs. Never the key or the Authorization header.

`internalNote` IS returned by this API (the key belongs to the merchant). `serializeEnrichment` must never be used for the storefront endpoint.

Limits: rate limits live in memory (reset on restart, per process). The 202 sync has no durable worker: a restart leaves the run RUNNING and POST /syncs answers 409 until the 15-minute abandon rule.

## Rules
- The sync never writes `product_enrichments`.
- Services take `shopId` as a parameter; they never read it from a request.
