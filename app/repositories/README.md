# app/repositories/ — Prisma queries, always scoped by shop

## What this folder is
The only place that runs Prisma queries for products, enrichments, webhook receipts, API keys and description generations. Keeping the queries here makes tenant isolation checkable in one folder: every product and enrichment function takes `shopId` as its first argument and filters by it, so a caller cannot reach another shop's rows by changing an id.

| File | Function | Behaviour |
|---|---|---|
| `product.server.ts` | `upsertProductWithVariants(tx, shopId, mapped, syncedAt)` | Upsert on unique `(shopId, shopifyProductGid)`; clears `deletedAt`; upserts variants by `shopifyVariantGid`; deletes variants Shopify no longer returns (skipped if the list was truncated). Returns `{ inserted }`. Takes a transaction client |
| | `markStaleProducts(tx, shopId, runStartedAt)` | Soft-deletes live products with `syncedAt < runStartedAt`. Returns count |
| | `upsertProductIfNewer(tx, shopId, mapped, syncedAt)` | Webhook path. `SELECT ... FOR UPDATE` on the product row, then skips if the incoming `updatedAtShopify` is older than the stored one, else calls `upsertProductWithVariants`. Returns `{ skipped, inserted }` |
| | `softDeleteProductByGid(tx, shopId, gid)` | Sets `deletedAt` on one live product. Variants and enrichment stay. Returns rows changed (0 = unknown or already deleted) |
| `webhook-receipt.server.ts` | `claimReceipt(input)` | Returns `"claimed"` or `"duplicate"`. INSERT first; on unique violation (P2002) re-claims only a `FAILED` receipt or a `RECEIVED` older than 60s, using a conditional `updateMany` that matches the exact state read, so one concurrent caller wins |
| | `canReclaim(existing, now)` | Pure decision used above |
| | `markReceiptProcessed(txOrDb, webhookId, note?)` / `markReceiptFailed(webhookId, message)` | Set status + `processedAt`. `error` holds the failure message (max 1000 chars) or a skip note |
| `api-key.server.ts` | `insertApiKey`, `findApiKeyByHash` (includes `shop`: this is how the API finds its tenant), `listApiKeys(shopId)`, `revokeApiKeys(shopId, keyPrefix)` (idempotent), `touchApiKeyLastUsed(id, olderThan)` (conditional, so no write per request) | Plaintext keys never reach this layer |
| `enrichment.server.ts` | `listProducts(shopId, { query, status, hasBadge, afterId, limit })` | Hides soft-deleted rows. Title `contains`. Keyset pagination on `id` (fetches limit+1). Includes `enrichment` in the same call (no N+1). Returns `{ products, nextCursor }`. Default 20, max 100 |
| | `getProductById(shopId, id)` / `getProductByGid(shopId, gid)` | Include enrichment + variants. Return null when the product belongs to another shop |
| | `getPublicBadge(shopId, gid)` | STOREFRONT read. `select`s only `badgeText`, `badgeColor`, `active`, so `internalNote` is never loaded. Null unless product is ACTIVE, not deleted, and the badge is active |
| | `getPublicBadges(shopId, gids[])` | STOREFRONT read for grids: one `findMany` with `shopId` + `IN`, same filters (ACTIVE, not deleted, enrichment active) and the same public-only `select`. Returns only qualifying products, as `{ shopifyProductGid, badgeText, badgeColor }` |
| | `saveEnrichment(shopId, productId, input)` | Upsert on unique `productId`. Returns `{ enrichment, created }` or null if product not in shop |
| | `removeEnrichment(shopId, productId)` | Deletes the row, idempotent. Returns false if product not in shop |
| `ai-generation.server.ts` | `createJob(shopId, input, client?)` | Job + input in one create. Unique `(shopId, idempotencyKey)`: on P2002 returns the existing job with `created: false`, so a retried request is never a second billable call. Null when the product (live, same shop) or `previousJobId` (same shop and product) is not found |
| | `findJobByIdempotencyKey(shopId, key, client?)` | The job a retried request gets back |
| | `getJob(shopId, jobId)`, `listJobsForProduct(shopId, productId, limit)`, `latestJobStatusByProduct(shopId, productIds)` | Shop-scoped reads. `getJob` includes input and output. `latestJobStatusByProduct` is ONE `findMany` (newest first, `productId IN`) reduced to a `Map<productId, {status, reviewStatus}>` for the catalogue column |
| | `countActiveJobs(shopId)`, `countJobsSince(shopId, since)` | Spend limits counted from rows, so they survive restarts. `createJob`, the counters and `failAbandonedJobs`, `leaseQueuedJob(maxRunningPerShop, graceMs)` (oldest due QUEUED job of a shop under its RUNNING limit, moved to RUNNING in the same transaction with `FOR UPDATE SKIP LOCKED`), `recoverAbandonedApplies` (APPLYING older than `APPLY_ABANDON_MS` → APPROVED with an error note, so Apply can be retried) accept a transaction client, so the service can run them under one lock on the shop row |
| | `markJobRunning`, `completeJob`, `failJob`, `failAbandonedJobs(shopId, now?)` | Conditional `updateMany` on the expected `status`, so one concurrent caller wins. `completeJob` sets SUCCEEDED + `reviewStatus` DRAFT + first `draftHtml` and inserts the output row in one transaction. `failJob` bounds the error to 1000 chars. Abandoned = RUNNING/QUEUED older than `JOB_ABANDON_MS` (5 min) |
| | `saveDraft(shopId, jobId, html)` | Only while SUCCEEDED + DRAFT. Never touches `ai_generation_outputs` |
| | `moveReviewStatus(client, shopId, jobId, from, to)` | Checks `canMoveReview`, then updates `WHERE reviewStatus = from`. Accepts a transaction client so Apply can commit the move together with the version row |
| `description-version.server.ts` | `createVersion(client, shopId, input)`, `listVersions(shopId, productId)`, `getVersion(shopId, productId, versionId)` | Append-only: no update or delete. A restore is a new row with `restoredFromId` |
| `publication-action.server.ts` | `createPublicationAction`, `completePublicationAction(shopId, id, result)`, `listPublicationActions` | Row is written before the Shopify call; completion happens once (`WHERE status = REQUESTED`) and keeps Shopify's `userErrors` |

## Rules
- `ai_generation_outputs` is write-once. The merchant's edits go to `ai_generation_jobs.draftHtml`; the model's words stay as audit evidence.
- State changes are conditional updates on the expected current state, never read-then-write.
- Every product/enrichment function takes `shopId` first and filters by it. Do not add a query without it.
- `webhook_receipts.webhookId` (unique) is the idempotency boundary for webhooks. Receipts are keyed by `webhookId`, not by shop, because the id is globally unique and the shop may be unknown.
- `internalNote` is private. Anything serving the storefront must select only `badgeText`, `badgeColor`, `active`.
- Input is validated before it gets here (`services/enrichment-validation.ts`); repositories do not validate.
