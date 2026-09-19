# db/ — MySQL 8 schema and migrations

## What this folder is
The MySQL 8 data model: `schema.prisma` and the generated SQL in `migrations/`. It is named `db/` to follow the assignment's recommended layout; Prisma finds it through `"prisma": { "schema": "db/schema.prisma" }` in `package.json`, so every `prisma` command works from the repo root without a flag.

Ownership rule: Shopify owns catalog fields (title, status, price…), so `products` and `variants` are a copy that the sync and webhooks may overwrite. The app owns `product_enrichments`, which the sync and webhooks never touch.

```
shops 1--* products 1--* variants
  |            \--0..1 product_enrichments
  |--* sync_runs
  |--* developer_api_keys
  \--* webhook_receipts   (shop optional: a delivery can arrive for an unknown shop)
shop_sessions              (Shopify library's table, linked by shop domain, not by key)
```
Deleting a product cascades to its variants and enrichment, but products are soft-deleted (`deletedAt`), so in practice an enrichment survives a Shopify delete and comes back if the product does.

Database runs from `docker-compose.yml` (container `enrichment-hub-mysql`, host port **3307**, user `app`/`app`, db `enrichment_hub`; test db `enrichment_hub_test`). SQLite is not allowed by the assignment.

Models use PascalCase in code and snake_case tables via `@@map`.

| Model → table | Key constraints | Written by |
|---|---|---|
| `Session` → `shop_sessions` | Field names fixed by `PrismaSessionStorage`; do not rename | Shopify library |
| `Shop` → `shops` | `shopDomain` unique (lowercase). `uninstalledAt = null` means installed; rows are never deleted | `services/shop.server.ts` |
| `Product` → `products` | unique `(shopId, shopifyProductGid)`; indexes `(shopId, title)`, `(shopId, status)`; `deletedAt` soft delete | sync and product webhooks |
| `Variant` → `variants` | `shopifyVariantGid` unique; `price Decimal(12,2)`; cascade with product. No inventory field (scope is `read_products` only) | sync and `products/update` webhook (both through `upsertProductWithVariants`) |
| `ProductEnrichment` → `product_enrichments` | `productId` unique (one per product); `badgeText` ≤40; `badgeColor` `#RRGGBB`; `internalNote` private | admin UI and `/api/v1`. NEVER the sync or webhooks |
| `WebhookReceipt` → `webhook_receipts` | `webhookId` unique for dedupe; status RECEIVED/PROCESSED/FAILED | `repositories/webhook-receipt.server.ts`, one row per delivery for all four topics. `error` also holds skip notes on `PROCESSED` rows |
| `SyncRun` → `sync_runs` | type FULL/RECONCILE; status RUNNING/SUCCEEDED/FAILED; counters; `cursor` | `services/sync.server.ts` |
| `DeveloperApiKey` → `developer_api_keys` | `keyHash` = SHA-256 hex, unique; plaintext never stored | `repositories/api-key.server.ts` via `npm run api-key` (create/revoke) and the API auth (`lastUsedAt`) |

## Changing the schema
1. Edit `schema.prisma`.
2. `npx prisma migrate dev --name <what_changed>` (needs the Docker MySQL running). This creates a new folder in `migrations/`.
3. Never edit or delete an existing migration. Production-style apply: `npm run setup` (`prisma generate && prisma migrate deploy`).
