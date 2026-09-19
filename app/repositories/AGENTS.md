# app/repositories/ — Prisma queries, always scoped by shop

| File | Function | Behaviour |
|---|---|---|
| `product.server.ts` | `upsertProductWithVariants(tx, shopId, mapped, syncedAt)` | Upsert on unique `(shopId, shopifyProductGid)`; clears `deletedAt`; upserts variants by `shopifyVariantGid`; deletes variants Shopify no longer returns (skipped if the list was truncated). Returns `{ inserted }`. Takes a transaction client |
| | `markStaleProducts(tx, shopId, runStartedAt)` | Soft-deletes live products with `syncedAt < runStartedAt`. Returns count |
| | `upsertProductIfNewer(tx, shopId, mapped, syncedAt)` | Webhook path. `SELECT ... FOR UPDATE` on the product row, then skips if the incoming `updatedAtShopify` is older than the stored one, else calls `upsertProductWithVariants`. Returns `{ skipped, inserted }` |
| | `softDeleteProductByGid(tx, shopId, gid)` | Sets `deletedAt` on one live product. Variants and enrichment stay. Returns rows changed (0 = unknown or already deleted) |
| `webhook-receipt.server.ts` | `claimReceipt(input)` | Returns `"claimed"` or `"duplicate"`. INSERT first; on unique violation (P2002) re-claims only a `FAILED` receipt or a `RECEIVED` older than 60s, using a conditional `updateMany` that matches the exact state read, so one concurrent caller wins |
| | `canReclaim(existing, now)` | Pure decision used above |
| | `markReceiptProcessed(txOrDb, webhookId, note?)` / `markReceiptFailed(webhookId, message)` | Set status + `processedAt`. `error` holds the failure message (max 1000 chars) or a skip note |
| `enrichment.server.ts` | `listProducts(shopId, { query, status, hasBadge, afterId, limit })` | Hides soft-deleted rows. Title `contains`. Keyset pagination on `id` (fetches limit+1). Includes `enrichment` in the same call (no N+1). Returns `{ products, nextCursor }`. Default 20, max 100 |
| | `getProductById(shopId, id)` / `getProductByGid(shopId, gid)` | Include enrichment + variants. Return null when the product belongs to another shop |
| | `saveEnrichment(shopId, productId, input)` | Upsert on unique `productId`. Returns `{ enrichment, created }` or null if product not in shop |
| | `removeEnrichment(shopId, productId)` | Deletes the row, idempotent. Returns false if product not in shop |

## Rules
- Every product/enrichment function takes `shopId` first and filters by it. Do not add a query without it.
- `webhook_receipts.webhookId` (unique) is the idempotency boundary for webhooks. Receipts are keyed by `webhookId`, not by shop, because the id is globally unique and the shop may be unknown.
- `internalNote` is private. Anything serving the storefront must select only `badgeText`, `badgeColor`, `active`.
- Input is validated before it gets here (`services/enrichment-validation.ts`); repositories do not validate.
