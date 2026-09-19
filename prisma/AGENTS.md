# prisma/ — MySQL 8 schema and migrations

Database runs from `docker-compose.yml` (container `enrichment-hub-mysql`, host port **3307**, user `app`/`app`, db `enrichment_hub`; test db `enrichment_hub_test`). SQLite is not allowed by the assignment.

Models use PascalCase in code and snake_case tables via `@@map`.

| Model → table | Key constraints | Written by |
|---|---|---|
| `Session` → `shop_sessions` | Field names fixed by `PrismaSessionStorage`; do not rename | Shopify library |
| `Shop` → `shops` | `shopDomain` unique (lowercase). `uninstalledAt = null` means installed; rows are never deleted | `services/shop.server.ts` |
| `Product` → `products` | unique `(shopId, shopifyProductGid)`; indexes `(shopId, title)`, `(shopId, status)`; `deletedAt` soft delete | sync and product webhooks |
| `Variant` → `variants` | `shopifyVariantGid` unique; `price Decimal(12,2)`; cascade with product. No inventory field (scope is `read_products` only) | sync only |
| `ProductEnrichment` → `product_enrichments` | `productId` unique (one per product); `badgeText` ≤40; `badgeColor` `#RRGGBB`; `internalNote` private | admin UI (and future API). NEVER the sync |
| `WebhookReceipt` → `webhook_receipts` | `webhookId` unique for dedupe; status RECEIVED/PROCESSED/FAILED | `repositories/webhook-receipt.server.ts`, one row per delivery for all four topics. `error` also holds skip notes on `PROCESSED` rows |
| `SyncRun` → `sync_runs` | type FULL/RECONCILE; status RUNNING/SUCCEEDED/FAILED; counters; `cursor` | `services/sync.server.ts` |
| `DeveloperApiKey` → `developer_api_keys` | `keyHash` = SHA-256 hex, unique; plaintext never stored | nothing yet (Phase 5) |

## Changing the schema
1. Edit `schema.prisma`.
2. `npx prisma migrate dev --name <what_changed>` (needs the Docker MySQL running). This creates a new folder in `migrations/`.
3. Never edit or delete an existing migration. Production-style apply: `npm run setup` (`prisma generate && prisma migrate deploy`).
