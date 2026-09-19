# Learning Notes — Merchant Product Enrichment Hub

One section per phase: **what** we built, **why**, and **alternatives**.

---

## Phase 1 — MySQL, schema, tenant (shop) context

### 1. `docker-compose.yml` + `docker/mysql-init.sql`
- Runs MySQL 8.0 in a container on host port **3307** (container port 3306). 3307 avoids clashing with your other `infra-mysql-1` container or a Homebrew MySQL.
- `volumes: mysql-data` → data survives container restarts.
- `healthcheck` → lets us wait until MySQL actually accepts connections.
- `mysql-init.sql` runs only the *first* time the volume is created: it creates a test DB and grants the `app` user permission to create databases. Prisma's `migrate dev` needs that to build a temporary **shadow database**, which it uses to detect schema drift.
- **Alternatives:** Homebrew MySQL (no Docker, but setup differs per machine), or a hosted DB like PlanetScale or RDS (needs internet and accounts). Docker gives reviewers a one-command setup, which the assignment asks for (30-minute setup).

### 2. `.env` / `.env.example`
- `DATABASE_URL` tells Prisma where MySQL is. `.env` is git-ignored (secrets never get committed); `.env.example` has placeholders and *is* committed. We added `!.env.example` to `.gitignore` because the template ignored `.env.*`.
- Shopify keys are not in `.env`: `shopify app dev` injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SCOPES` at runtime from your Partner app.

### 3. `prisma/schema.prisma`
**Prisma** is an ORM: you describe tables once, and it generates (a) SQL migrations and (b) a typed client (`db.product.findMany(...)`).
- `provider = "mysql"` was `"sqlite"`. The assignment rejects SQLite.
- We deleted the old SQLite migration: migrations are database-specific, so we started fresh with `prisma/migrations/<timestamp>_init_mysql_schema/migration.sql`. **Open that file.** It's the real SQL (CREATE TABLE, UNIQUE, INDEX, FOREIGN KEY).
- `@@map("products")` → code uses `Product`, and the MySQL table is named `products` (snake_case, as the assignment names them).

Model by model:
| Model | Key design choice | Why |
|---|---|---|
| `Session` → `shop_sessions` | Field names unchanged; `accessToken @db.Text` | Shopify's `PrismaSessionStorage` reads and writes this table by those exact names. In MySQL a plain `String` is VARCHAR(191), too short for tokens, so we use TEXT. |
| `Shop` | `shopDomain @unique`, `uninstalledAt` nullable | One row per store = the **tenant**. `uninstalledAt = null` means installed. We don't delete the row on uninstall, so history and reinstall stay simple. |
| `Product` | `@@unique([shopId, shopifyProductGid])` | The DB itself refuses duplicates, so a re-sync can only update. Scoped by shop, so two shops can't collide. |
| | `shopifyProductGid String` | Shopify IDs look like `gid://shopify/Product/123`. They're strings, not our numeric IDs (an explicit assignment rule). |
| | `@@index([shopId, title])`, `([shopId, status])` | Fast search/filter *within one shop*. Every query starts with `shopId`, so it's the first column. |
| | `deletedAt` (soft delete) | When Shopify deletes a product we mark it deleted instead of removing it, so its enrichment isn't lost silently and we keep an audit trail. |
| `Variant` | `shopifyVariantGid @unique`, `price Decimal(12,2)` | Never use float for money (rounding errors). Cascade-deletes with its product. |
| `ProductEnrichment` | `productId @unique` | Enforces "one enrichment per product" in the DB. The sync never writes this table → **enrichments survive re-sync** (data ownership rule). `internalNote` is private. |
| `WebhookReceipt` | `webhookId @unique` + `status` | Shopify may resend the same webhook. Inserting the same ID twice fails → we know it's a duplicate. `status/error` let us diagnose and retry. |
| `SyncRun` | counters + `cursor` | Shows progress. `cursor` = the last page saved (checkpoint for restarts). |
| `DeveloperApiKey` | `keyHash Char(64) @unique` | We store only the SHA-256 hash, like passwords. The DB leaking ≠ keys leaking. |

- **Alternatives to Prisma:** Drizzle (lighter, SQL-like), Knex (query builder), or raw `mysql2` with prepared statements. We kept Prisma because the Shopify template already uses it for sessions: one tool, typed queries, and parameterized SQL by default (SQL-injection safe).
- **Alternative IDs:** UUIDs instead of autoincrement ints. Ints are smaller and faster for joins, and we never expose them publicly (the API uses Shopify GIDs).

### 4. `app/services/shop.server.ts` (tenant layer)
- `normalizeShopDomain`: lowercases, so `My-Store.myshopify.com` and `my-store.myshopify.com` are the same tenant.
- `recordInstall`: an **upsert**. First install → create; reinstall → clear `uninstalledAt`. Idempotent.
- `recordUninstall`: marks the shop uninstalled **and** deletes its sessions in one **transaction** (both happen or neither does). Deleting sessions means we can no longer call Shopify for that shop.
- `requireActiveShop`: the **tenant guard**. It takes the shop domain from a *verified* session and returns our DB row, or 403. Every later query uses `shop.id` from here, so a caller can never pick another shop by changing a URL parameter.
- The `.server.ts` suffix tells React Router this code must never ship to the browser.

### 5. `app/shopify.server.ts` → `hooks.afterAuth`
- The Shopify library runs `afterAuth` right after OAuth succeeds (install or re-auth). We use it to create the Shop row. **Alternative:** create the row lazily on the first page load. `afterAuth` is the official lifecycle hook, so it's more predictable.
- `apiVersion: ApiVersion.July26` = **pinned API version** (2026-07). Upgrading means changing this line (and `webhooks.api_version` in the toml) and re-testing.

### 6. `shopify.app.toml`
- `scopes = "read_products"`: **least privilege**. We only read the catalog. (The template asked for write access to products and metaobjects, which we don't use, so it's removed along with the demo metafield/metaobject definitions.)
- Changing scopes → Shopify asks the merchant to approve again on next open.

### 7. `app/routes/app._index.tsx`
- `loader` runs on the server for each page load. `authenticate.admin(request)` validates the session token that Shopify's admin iframe sends. If it's invalid or missing, it redirects to OAuth. Then it calls `requireActiveShop` and shows the shop domain, install time, scopes and local product count.
- `<s-page>`, `<s-section>` = **Polaris web components** (Shopify's admin UI kit), so the app looks native inside the admin.

### How the install flow works now
```
Open app in admin → authenticate.admin → no session? → OAuth (Shopify verifies HMAC/state)
  → access token saved in shop_sessions (PrismaSessionStorage)
  → afterAuth → recordInstall → shops row (uninstalledAt = null)
Uninstall → Shopify sends app/uninstalled webhook → HMAC verified → recordUninstall
```

### 8. What we learned while testing Phase 1
- **Managed installation + token exchange.** On a dev store, `shopify app dev` installs the app and auto-grants the toml scopes at startup, so there's no consent screen and no OAuth redirect. When the app loads, the admin sends a signed **session token (JWT)**, and the library swaps it server-to-server for an **access token**. The old redirect OAuth (`/auth/callback?code=`) is only a fallback.
- **The Preview URL gives a 404 after uninstall** because the app no longer exists on that store. Pressing `p` only opens the URL; restarting `shopify app dev` is what reinstalls.
- **There is no "installed" webhook.** Install and reinstall are detected through `afterAuth` (on a new token). Uninstall is detected through the `app/uninstalled` webhook.
- **Scope changes on an existing install** fire `app/scopes_update`, not `afterAuth`. We first forgot to update `shops.scopes` there, which caused a stale value (bug found and fixed). Lesson: when you copy data into your own table, update it at *every* place where the source changes.
- **Pinned version must match everywhere:** `ApiVersion.July26` in `shopify.server.ts` and `webhooks.api_version = "2026-07"` in the toml.

---

## Phase 2 — Product sync (Shopify Admin GraphQL → MySQL)

This is Phase 2 of our implementation notes; it corresponds to Phase 4 in the assignment PDF.

### What the merchant gets

The merchant clicks **Sync now** inside our embedded admin app. The server reads Shopify's catalog and saves a local copy. Clicking again refreshes that copy without adding duplicate products. Shopify's product records are not modified.

Example: Shopify product `123` was called “Red T-shirt” when we first copied it. The merchant renames it “Classic T-shirt” in Shopify. The next sync finds the same Shopify ID in our database and updates its local title. Its app-owned “Staff Pick” badge and private note remain untouched.

### Three operations that are easy to confuse

| Operation | Starts where? | What changes? |
|---|---|---|
| Manual sync (this phase) | Merchant clicks our admin app button | Our MySQL copy is refreshed from Shopify queries |
| Webhook (later phase) | Shopify notifies our server after a product event | Our handler will update the MySQL copy |
| Shopify mutation (optional stretch work) | Our server asks Shopify to change data | Shopify's own data changes |

Prisma connects **our server to MySQL**. It does not watch Shopify or automatically copy anything. Our sync service supplies the instructions and data to Prisma. No theme extension, webhook, or Shopify mutation is involved in the manual sync button.

### The flow and the responsible files

```text
Sync now button
  → route action: authenticate request, identify the shop
  → startSyncRun: refuse a conflicting run and record RUNNING
  → GraphQL query: fetch shop identity and a page of products
  → fetch remaining variant pages for products that need them
  → mapping: convert API fields to our database fields, validate
  → transaction: upsert products/variants and save progress together
  → repeat until there are no more product pages
  → mark missing products stale, record SUCCEEDED together
```

| File | Responsibility |
|---|---|
| `app/routes/app._index.tsx` | Authenticate each request, trigger sync, display counts and feedback |
| `app/services/sync.server.ts` | Coordinate pages, transactions, progress, conflicts and failure handling |
| `app/shopify/queries.ts` | Specify the Shopify fields we read |
| `app/shopify/graphql-client.server.ts` | Send requests; classify errors; limit retries, time and throttle waits |
| `app/services/product-mapping.ts` | Convert Shopify IDs/dates/fields into our database representation |
| `app/repositories/product.server.ts` | Perform shop-scoped product upserts, variant updates and stale marking |

### Decisions and why they matter

1. **Match by shop and Shopify product ID, never title.** Titles can change. The unique database constraint makes repeated imports safe. An upsert inserts if missing, otherwise updates the existing row. The `updated` count means existing rows refreshed, including unchanged records.
2. **Page through both products and variants.** Each product page requests 25 products with 25 variants each. Products with more variants get additional pages of 100. `endCursor` is the bookmark used for the next page. Missing/repeated cursors fail the run rather than looping forever. The ID sort helps pagination but does not make a changing catalog a frozen snapshot.
3. **Fetch first, transact second.** API requests happen outside MySQL transactions. All products and variants for one page, plus its progress checkpoint, commit together. No long-held database lock while waiting on Shopify.
4. **Stop on invalid or incomplete data.** A validation error, failed variant request or detected product change during variant pagination fails the run. Earlier committed pages remain. We do not run deletion cleanup on a failed run. This trades partial progress on the rejected page for a simple, safe recovery rule.
5. **Count committed writes only.** Insert/update counters change only after a transaction commits. `fetched` counts received product nodes; `failed` counts fetched nodes that did not commit. API failures before receiving a page can have `failed = 0`; the run status/error still records the failure.
6. **Keep enrichments separate.** Catalog upserts never write to `product_enrichments`. Successful cleanup soft-deletes a missing product by setting `deletedAt`; it keeps that product's enrichment for history. A later reappearance clears `deletedAt`.
7. **One run per shop.** A row lock serializes simultaneous starts. Runs older than 15 minutes can be marked abandoned. Each page rechecks active shop/run state under the same lock, so an abandoned worker cannot commit over a replacement run or an uninstalled shop.
8. **Restart from the beginning.** The saved cursor explains progress; we do not resume from it. A safe full re-run is simpler for a small development catalog. It updates the rows already saved instead of duplicating them.

### Errors and limits

The client recognizes retryable network/server failures and throttling separately from authentication and query errors. It tries at most three times, with 1-second then 2-second backoff. SDK retries are disabled for these calls to avoid multiplying attempts. Both returned GraphQL errors and SDK-thrown errors are checked. Partial data accompanied by GraphQL errors is rejected.

Throttle metadata tells us how many points remain and how quickly they refill. We account for time already elapsed before waiting. Requests have a 10-second abort timeout and share the route's 60-second work budget. Database page transactions have a 30-second timeout. The work budget is checked between operations, so a database operation already in progress can finish after the 60-second mark; this is not a strict HTTP SLA. A crashed database or process may leave RUNNING state until the 15-minute abandonment rule applies.

Other safety bounds are 400 product pages and 100 additional variant pages per product. Catalogs that cannot finish within the budget need a background worker/bulk design; clicking repeatedly will not make an oversized catalog fit the request budget.

Framework-thrown `Response` objects (for example, reauthentication redirects) must reach React Router unchanged. We record failure first and rethrow the original response. Queries do not have mutation `userErrors`; that handling belongs with a future mutation feature.

GraphQL logs include the local shop ID, sync run ID, operation, attempt, duration and cost. Tokens and headers are not passed to the logger. Its redaction is only for sensitive top-level field names; it is not a general scrubber for arbitrary nested objects or message text.

### Checks added in this phase

- `npm test`: mapping validation, price preservation, cursor failure, authentication redirects, error classification, bounded retries, throttle refill, deadlines and abort signals.
- `npm run test:integration`: real MySQL transactions and repositories with mocked Shopify responses; 60-product pagination, repeated imports, title updates, enrichment preservation, shop isolation, 130-variant pagination, obsolete variant removal, rollback counts, safe reruns, deletion/revival, simultaneous starts and abandoned-run protection.
- `npm run typecheck`, `npm run lint`, `npm run build`.
- Shopify AI Toolkit schema validation accepted the three queries against `2026-07`, requiring only `read_products`.

Integration tests require a separate local database ending in `_test`, apply migrations, and delete only fixture shops created by the test process. They never reset the development database. See `docs/PHASES.md` for commands and live-store evidence.

### What is still outside this phase

Product search, badge editing, developer API endpoints/keys, product webhooks, and the storefront theme block. Reconcile currently invokes the same full-sync implementation with a different run type; it is manual and does not mean webhooks are already implemented.

There is no cross-request snapshot of a catalog while the merchant edits it. We detect timestamp changes when fetching extra variant pages and fail safely, but concurrent changes elsewhere may only appear on the next reconciliation. This phase is designed for a small development store.

### Official references used

- [Products query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/products)
- [Product and its variants connection](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Product)

---

## Phase 3 — Product search and badge editor

### What the merchant gets
A **Products** page in the app: search the local catalog by title, filter by status or "has badge", open a product, and save or remove its badge and private note.

### Files
| File | Responsibility |
|---|---|
| `app/routes/app.products._index.tsx` | List page. The loader reads filters from the URL and returns one page of products |
| `app/routes/app.products.$id.tsx` | Editor page. The loader shows the product; the action saves or removes the enrichment |
| `app/services/enrichment-validation.ts` | The badge rules in one place. The Phase 5 API reuses it, so UI and API cannot disagree |
| `app/repositories/enrichment.server.ts` | All database access, always filtered by `shopId` |

### Decisions and why
1. **Filters live in the URL** (`?query=red&status=ACTIVE`). The page can be reloaded or shared, and the loader stays a plain function of the request. Unknown filter values are ignored, never passed to the database.
2. **No N+1.** `findMany` uses `include: { enrichment: true }`, so Prisma loads the badges for the whole page in one extra query instead of one query per row.
3. **Keyset pagination.** We order by `id` and ask for rows with `id > lastSeenId`, fetching one extra row to learn whether a next page exists. `OFFSET 5000` makes MySQL read and throw away 5000 rows; `id > X` jumps there through the index. Rows also cannot repeat when the data changes between pages.
4. **One enrichment per product is enforced twice.** The code uses an upsert on `productId`, and the database has `productId @unique`. A double click on Save updates the same row.
5. **Tenant isolation.** The editor first looks the product up with `{ id, shopId }`. Shop B asking for Shop A's product id gets a 404, the same answer as for an id that does not exist, so ids do not leak.
6. **Remove vs inactive.** "Remove badge" deletes the row and is idempotent. The **Active** checkbox hides a badge from the storefront while keeping its text and note.
7. **Validation at the boundary, errors all at once.** The validator returns every field error together so the form can show them next to each field. Colours are stored uppercase so equal colours compare equal.
8. **Soft-deleted products** are hidden from the list. Opening one directly shows a warning, and its enrichment is kept.
