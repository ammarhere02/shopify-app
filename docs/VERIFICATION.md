# Verification — Merchant Product Enrichment Hub

What is implemented, how it is tested, and which checks on a live development store are done or still open. Reasons for each design are in [DESIGN.md](DESIGN.md).

Legend: `[x]` verified · `[ ]` not verified yet

## Summary

| Area | Assignment refs | Implemented | Automated tests | Live dev-store check |
|---|---|---|---|---|
| Install, sessions, tenancy | F-01, F-02, §4.1 | yes | yes | done |
| Catalog sync (Admin GraphQL → MySQL) | F-03, F-04, F-09, F-11, §4.2–4.3 | yes | yes | open |
| Admin UI: product search and enrichment editor | F-05 | yes | yes | open |
| Webhooks and receipts | F-08, §4.4 | yes | yes | partly done |
| Developer API `/api/v1` and API keys | F-06, §4.5 | yes | yes | partly done |
| Storefront badge: app proxy and Theme App Extension | F-07, §4.6 | yes | yes | open |
| Structured logs with correlation ids, no secrets | F-10 | yes | yes (log content asserted) | open |
| AI description: generate, review, edit | AI 01–07 (extension) | yes | yes | partly done |
| AI description: apply, publish, versions, restore | AI 08–12 (extension) | yes | yes | partly done |
| AI description: security and reliability hardening | §9, §12 (extension) | yes | yes | — |
| AI description: batch generation through a durable worker | AI 13 (extension, stretch) | yes | yes | open |
| `products/create` webhook | review finding | yes | yes | open |

Not built: F-12 (metafield mutation, stretch), an admin page for API keys, ETag on the storefront endpoint. The architecture note, ER diagram, endpoint reference and test evidence are in [SUBMISSION.md](SUBMISSION.md). OpenAPI file: [openapi.yaml](openapi.yaml). No demo video; the live checks below were run on the deployed app against the development store.

Automated checks, all passing: `npm test` (127), `npm run test:integration` (170, real MySQL), `npm run typecheck`, `npm run lint`, `npm run build`, `npx shopify theme check --path extensions/product-badge`. Shopify is mocked in automated tests; request signatures (webhook HMAC, app proxy) are real.

---

## Install, sessions, tenancy

- [x] Docker MySQL 8 on port 3307, Prisma migration, all 8 required tables
- [x] `afterAuth` → `recordInstall`; `app/uninstalled` → `recordUninstall` (sessions deleted in a transaction)
- [x] `requireActiveShop` tenant guard; scope reduced to `read_products`
- [x] `app/scopes_update` keeps `shops.scopes` fresh
- [x] Pinned API version `2026-07` in code and toml

Deliberate choice: `variants` has no inventory field. The assignment says "if authorized", and the app only holds `read_products`.

## Catalog sync

- [x] Paginated products and variants, mapping and validation, one transaction per page
- [x] Sync run counters, one run per shop, abandoned-run rule, stale marking (soft delete)
- [x] Bounded retry and backoff, throttle handling, timeouts, redacted structured logs
- [x] Reconcile (same full sync, type `RECONCILE`)
- [x] Unit tests and real-MySQL integration tests

Live dev-store checklist (`npm run dev`, open the app in the dev store admin):
- [x] Shop identity and the Sync now button appear (deployed app, 2026-09-22)
- [x] Sync now → SUCCEEDED; run #1 fetched 16, inserted 16 (the store has 16 products, 23 variants)
- [x] Sync again unchanged → runs #2 and #3: fetched 16, inserted 0, updated 16
- [ ] Rename a product in Shopify, sync → local title updates, same local row id
- [ ] Product with more than 25 variants → all variants copied
- [ ] Delete a disposable product in Shopify, sync → local row soft-deleted
- [ ] Reconcile completes and records type RECONCILE
- [ ] Expired session recovers (re-auth), no error loop

Known limits: the sync runs inside the request (60s budget, no queue); a crashed run stays RUNNING until the 15-minute abandon rule; cursor checkpoints are diagnostic, re-runs start from page one; a changing catalog is not a snapshot.

## Admin UI: product search and enrichment editor

- [x] Product list (`/app/products`): title search, status filter, hasBadge filter, keyset pagination, enrichment loaded in the same query (no N+1)
- [x] Editor (`/app/products/:id`): badge text (≤40), colour `#RRGGBB`, active flag, internal note, remove
- [x] One validation module, `app/services/enrichment-validation.ts`, shared with the developer API
- [x] Repository `app/repositories/enrichment.server.ts`, every query scoped by `shop.id`
- [x] Labelled, keyboard-usable Polaris controls
- [x] Unit tests (validation) and real-MySQL tests (one per product, tenant isolation, filters, pagination)
- [ ] Manual check in the dev store admin
- [x] Catalogue is the home screen (`/app` redirects to `/app/products`); sync tools moved to `/app/sync` with their own nav entry
- [x] Catalogue shows each product's latest AI generation state from one query; filters in one responsive row; table rows collapse to a list on narrow screens; Polaris table pagination
- [x] Product page: badges under the title, AI workflow in the main column, badge editor and variants in the aside; per-action loading, toasts on success, banners on errors
- [x] AI panel split into numbered steps; edits survive Save draft / Approve answers; preview updates on every keystroke without a request; versions and history as tables
- [x] Product workspace: base page width, compact header with thumbnail, 300px inputs column + description workspace, formatted text first with Edit HTML and SEO tabs, generation details collapsed, one main status and a state-driven action bar, History with Generations / Written to Shopify views; badge editor compact in the left column; responsive grids wrapped in `s-query-container` (required for Polaris container queries); shimmer skeleton while generating, live-preview highlight and word count while typing
- [x] Opening a product shows Shopify's admin loading bar, a centred green spinner overlay, the catalogue table's loading state and a spinner on the clicked row (client-side `Link`)
- [x] Workspace on wide screens: left product panel (hero image, thumbnail toggles, collapsible Generate / Storefront badge in one scroll area under the image), a Description panel that stretches to the left column's height, History, and a bottom Product panel (Sales channels beside Product details) and a Description panel plus History panel whose bodies scroll inside fixed maximum heights (the admin iframe grows with content, so viewport-height fitting is not used); one result notice at the top of the page that fades after success
- [ ] Visual check of desktop and narrow layouts in the dev store admin (screenshots needed: product page at desktop and below 760px, Edit HTML tab, catalogue, Sync)

Decisions: list and detail routes; keyset pagination on the local id; prompt `v3` (category-aware structure, concrete opening sentence, banned filler, specifications only when a source supports them, 60-160 words); "remove" deletes the row while `active = false` hides it; soft-deleted products are hidden from the list.

## Webhooks and receipts

- [x] `products/update`, `products/delete`, `app/uninstalled`, `app/scopes_update` subscribed in `shopify.app.toml` (config validates)
- [x] HMAC verification on the raw body via `authenticate.webhook` in all four routes
- [x] `webhook_receipts` claimed first (`webhookId` unique) → duplicate = 200 with no side effects
- [x] Atomic re-claim of `FAILED` receipts and of `RECEIVED` older than 60s
- [x] Update: GraphQL re-fetch, then the same mapping and repository path as the sync; stale events skipped; newer-than guard inside the transaction
- [x] Delete: soft-delete by GID, variants and enrichment kept
- [x] Receipt `RECEIVED → PROCESSED/FAILED`, bounded error text; failure returns 500 so Shopify retries
- [x] Unknown or uninstalled shop → 200 and a receipt note; missing session → FAILED + 500; product gone → skipped
- [x] All webhooks use receipts and the structured logger
- [x] Tests: unit (13) and real MySQL (18), including real-HMAC route tests: valid, forged, tampered, duplicate
- [x] Re-fetch query validated with the Shopify AI Toolkit against 2026-07 (`read_products`)

Live dev-store checklist. Evidence read from the development database on 2026-09-19 (`webhook_receipts`, `products`, `sync_runs`); items without database evidence stay open.
- [x] App reached through a public HTTPS tunnel (real deliveries arrived from Shopify)
- [x] Product webhook subscriptions active (both topics delivered)
- [x] Product edited in Shopify Admin → local row updated with no sync run. Receipt #1 `PRODUCTS_UPDATE`, received 11:21:14.385, `PROCESSED` 11:21:14.956 (0.57s, inside Shopify's 5s limit). Product "Videographer Snowboard": `updatedAtShopify` 11:21:12, `syncedAt` 11:21:14; the last sync run (#4) was at 08:28
- [ ] Same delivery twice → one receipt, no second effect. Not reproduced live; covered by automated tests (service level and signed route request)
- [x] Product deleted in Shopify → local row soft-deleted. Receipt #2 `PRODUCTS_DELETE` `PROCESSED` in 14ms. "Selling Plans Ski Wax": `deletedAt` set, row and its 3 variants still present
- [ ] Enrichment kept after a live delete. Not shown: the deleted product had no badge. Repeat with a disposable product that has a badge (an automated test covers it)
- [ ] Log lines reviewed for `webhook.processed` metadata and absence of payload or secrets
- [x] Receipts reach `PROCESSED` (both rows, `error` NULL, `shopId` set)
- [ ] Safe failure → 500 + `FAILED`, then Shopify's retry → `PROCESSED`. No `FAILED` row exists yet
- [x] Uninstall and reinstall: two `APP_UNINSTALLED` receipts `PROCESSED`, sessions deleted, shop reactivated with the new scopes on reinstall (2026-09-22)

Known limits: synchronous processing, no queue or replay of our own; after Shopify's retries run out a receipt stays `FAILED` and Reconcile repairs the data; no `products/create` subscription (the first update or the next sync creates the row); the full sync does not apply the newer-than guard.

## Developer API `/api/v1`

- [x] API key: `eh_live_` + 32 random bytes, SHA-256 hash and prefix stored, plaintext printed once, revoke, throttled `lastUsedAt`
- [x] Key tool: `npm run api-key -- create|list|revoke <shop-domain> [label|prefix]`
- [x] `withApiAuth`: request id, Bearer auth, tenant from the key, uniform 401, refuses uninstalled shops
- [x] `GET /api/v1/products` (query, status, hasBadge, limit, opaque cursor): 200/400/401
- [x] `GET /api/v1/products/{id}`: 200/400/401/404 (`{id}` = numeric Shopify product id; responses carry full GIDs)
- [x] `PUT /api/v1/products/{id}/enrichment`: 201/200/400/413/422/401/404
- [x] `DELETE /api/v1/products/{id}/enrichment`: idempotent 204, 404 for an unknown product
- [x] `POST /api/v1/syncs`: 202 + `Location`, 400/401/409/429 · `GET /api/v1/syncs/{id}`: 200/400/401/404
- [x] Error envelope `{ error: { code, message, details?, requestId } }` for every failure including 405 and 500; `X-Request-Id` header
- [x] Rate limits: 60/min per key, 5/min per key for sync starts, 20 failed logins/min per IP; `Retry-After`
- [x] Tests: 5 unit and 21 request tests on real MySQL (auth failure, tenant scoping, valid write, invalid payload, missing product, rate limit, sync)

Manual check. Evidence: six Postman captures against the development store on 2026-09-20, in [SUBMISSION.md](SUBMISSION.md#postman-screenshots).
- [x] `npm run api-key -- create <shop-domain> "demo"` produces a working key (used as the Bearer token in the captures)
- [x] `GET <app-url>/api/v1/products` with `Authorization: Bearer <key>` → 200 with synced products; `GET /api/v1/products/{id}` → 200 with variants
- [x] `PUT` a badge → 201 and the next `GET` returns it; `DELETE` → 204 and the next `GET` returns `"enrichment": null`
- [ ] A badge written through the API appears in the admin Products page
- [ ] No key or an invalid key → 401 envelope
- [ ] `POST /api/v1/syncs` → 202, then `GET` the `Location` until `SUCCEEDED`
- [ ] Revoke the key → 401

Known limits: rate limits are in memory (single process, reset on restart); the 202 sync has no durable worker (a restart leaves the run RUNNING, new starts get 409 for up to 15 minutes); the client IP comes from `X-Forwarded-For`, which can be spoofed, so the failed-login limit is a speed bump only; no OpenAPI document yet.

## Storefront badge: app proxy and Theme App Extension

- [x] `[app_proxy]` in toml → `/apps/product-badge/...` → app `/proxy/...`; verified with `authenticate.public.appProxy`; config validates
- [x] Response contains only `text`, `color`, `textColor` (never `internalNote`: the query does not select it); `Cache-Control: public, max-age=60`; identical `{ "badge": null }` for every empty case
- [x] `extensions/product-badge` generated with the CLI; block schema: show/hide, alignment, style (solid/outline), text size, corner radius, all with defaults; product templates only
- [x] Escaped Liquid output, `textContent` insertion, colour re-checked in JS, namespaced CSS, deferred JS from the CDN, hidden until loaded, silent on error, theme-editor-only placeholder
- [x] Badge always carries text (not colour alone); text colour chosen for ≥4.5:1 contrast; outline style uses the theme's text colour
- [x] Rate limit on the storefront endpoints: 120/min per shop + IP, 429 + `Retry-After`
- [x] Tests: contrast unit tests and 4 route tests with a real proxy signature (active, 9 empty cases including cross-shop, tampered/unsigned → 400, 429)

Beyond the assignment (it asks only for a block "suitable for a product template"): **badges on product cards**.
- [x] Second app block **Product Card Badge**, added by the merchant inside the theme's Product card block. Horizon's `_product-card` accepts `@app` blocks and hands each card's product to its children as `closest.product`; the block's `product` setting (`autofill: true`) is connected to it. No theme file is edited and no theme selector is used
- [x] Batch endpoint `/apps/product-badge/badges?ids=1,2,3` → `/proxy/badges`: at most 50 numeric ids, every id validated (else 400, not cached), one shop-scoped query, map keyed by Shopify product id holding only the products with a badge to show, same public fields, same 60s cache, same shared rate limit (one hit per request)
- [x] One script for both blocks: collects every badge container, de-duplicates ids, one request per 50 products; reacts to theme-editor section reloads and to cards added later (filters, load more); optional reserved space so cards do not move
- [x] Tests: 6 more route tests (several products, all unavailable kinds and cross-shop in both directions, uninstalled/unknown shop, malformed and oversized lists, tampered/unsigned, shared rate limit). The single-product endpoint tests are unchanged and still pass

Live dev-store checklist (needs a working tunnel; enter the storefront password first if the dev store is protected):
- [x] Theme editor → product template → Add block → Apps → **Product Badge** added without editing theme code
- [ ] Each setting changes the preview: show/hide, alignment, style, text size, corner radius
- [x] ACTIVE badge ("Limited Edition") shows on the product page (2026-09-22, after re-adding the block following the reinstall)
- [ ] INACTIVE badge (untick Active in the app): nothing renders on the storefront within about 60s
- [ ] MISSING badge: another product shows nothing; the theme editor shows the placeholder only
- [ ] Browser network tab: the badge response holds only `text`, `color`, `textColor`
- [ ] Edit the badge text in the app → the storefront shows it after at most 60s (hard refresh)
- [ ] Opening the app URL `/proxy/products/<id>` directly (no signature) returns 400
- [ ] Product cards (Horizon): Customize → home page → Featured collection → Product card → Add block → Apps → **Product Card Badge**; the Product setting shows a connected dynamic source (if it is empty, connect it to the closest product with the dynamic-source icon). Repeat on the collection template
- [ ] Home page and collection page: only products with an ACTIVE badge show one, each card shows its own product's badge, and the product-page badge still works
- [ ] Network tab on a collection page: ONE `/apps/product-badge/badges?ids=...` request for the whole grid
- [ ] Cards do not move when badges appear (Reserve space on); filtering or loading more products badges the new cards

Known limits: one request per page view (one per 50 products, cached 60s); merchant edits take up to 60s to appear; the rate limit is in memory, single process; themes must support `@app` blocks (Online Store 2.0), and for cards the theme's product card itself must accept `@app` blocks and pass its product down (Horizon does; on Dawn-era themes the card block is not offered); the block shows nothing if JavaScript is disabled.

## AI description: apply to Shopify, publish, versions, restore

Automated (`tests/description-apply.integration.test.ts`, real routes + services + MySQL, Shopify faked as an in-memory product store):
- [x] Apply writes the approved draft with `productUpdate`, records a version with before/after text and Shopify's `updatedAt`, marks the job APPLIED, refreshes `products.updatedAtShopify`; exactly one read and one mutation
- [x] Apply once: second call 409 `invalid_state`; job not approved 409; two simultaneous applies → one 201, one 409, one mutation, one version row
- [x] Stale product (description changed in Shopify) → 409 `stale_product`, no mutation, job back to APPROVED with the reason; Shopify already holding our text is not stale (retry after an interrupted apply)
- [x] Shopify `userErrors` → 422 `shopify_rejected` with field messages, job retryable, no version; transport failure → 500, retryable, then 201
- [x] Job stuck in APPLYING beyond 2 minutes is recovered and applied
- [x] Missing `write_products` → 403 `missing_scope` without touching Shopify; other shop's key → 404; no key → 401
- [x] Restore an older version (new RESTORE row linked by `restoredFromVersionId`, before/after recorded) and "previous" (the merchant's original text before the first apply); bad `which` 422; unknown/other-shop/other-product version 404
- [x] Publish: channel list with the product's state; publish to one → audit row SUCCEEDED; DRAFT product 409 before any call; unknown or malformed channel id 422 with no audit row; `userErrors` → FAILED audit row + 422; missing `write_publications` 403; other shop 404
- [x] Admin resource route: apply / publish / restore with actor `admin:<shop>`, `?publications=1` loader, STALE code returned for the page banner
- [x] Mutations and the publications query validated with the Shopify AI Toolkit against 2026-07 (scopes `write_products`, `write_publications`, `read_publications`)

Live dev-store checklist:
- [x] Before the scopes were granted, the product page showed the "has not granted" warning and Apply was disabled (2026-09-22)
- [x] Scopes granted (2026-09-22): after `shopify app deploy` and updating the server's `SCOPES` variable, reopening the app did not prompt; uninstall + reinstall showed the consent screen. `shops.scopes` is now `write_products,write_publications` (read scopes implied). The reinstall broke the theme's reference to the Product Badge block; it was removed and re-added
- [x] Approve → Apply to product… → confirmation → job #4 `APPLIED`, version #1 (`source AI`, `appliedBy admin:<shop>`), description visible in Shopify admin; the resulting `products/update` webhook was `PROCESSED` without re-writing the row (2026-09-22)
- [ ] Stale conflict live (edit in Shopify admin, then Apply). Not exercised on the store; covered by automated tests (409, no mutation, job back to APPROVED)
- [ ] Restore live. Not exercised on the store; covered by automated tests (RESTORE row, `previous` text, links)
- [ ] Double-click Apply live. Covered by automated tests (two simultaneous → one write)
- [ ] Publish live. Not exercised on the store (no `publication_actions` row); covered by automated tests (channel list, DRAFT refused, audit SUCCEEDED/FAILED)
- [ ] API round-trip with `curl` against the deployed app. No API key was created on the deployed database; covered by the request tests

## AI description: security and reliability hardening

Audit of the review list against the code, with evidence:
- [x] Sanitizer on model output, on merchant edits and before the mutation (property test: only allowed attribute-less tags; idempotent)
- [x] Concurrency and daily limits counted in MySQL under a shop-row lock; API bucket 10/min per key; admin write intents 10/min per shop (tested: reads and other shops unaffected)
- [x] Logs: key-name and value-shape redaction, 500-character cut, at every depth; apply/publish lines carry identifiers only (tested with real redaction)
- [x] Error envelopes: `ShopifyApiError` → 429/502/409 with codes instead of 500, without Shopify's text; admin page gets the same sentence and stays retryable
- [x] Double click / browser retry: idempotency key on generate (4 simultaneous → 1 job), conditional `APPROVED → APPLYING` on apply (2 simultaneous → 1 write)

## AI description: batch generation and worker

- [x] `POST /api/v1/description-generations/batch` and *Generate descriptions for selected* on the Products list: one QUEUED job per product (max 20, first images up to `AI_MAX_IMAGES`), products without images reported as skipped, per-product idempotency key from the batch key, other shop's id refused before anything is created, daily limit stops the batch and keeps what was queued
- [x] Worker in the web process (`startGenerationWorker`): leases with `FOR UPDATE SKIP LOCKED`, one RUNNING job per shop, drains due work each tick, leaves jobs younger than 5 s to their inline run, rebuilds the prompt from the stored input; tests cover order, concurrency, provider failure, and three concurrent workers never running the same job
- [ ] Live: select 3 products → queued → drafts appear on each product page within a minute; restart the server with jobs queued → they still run

Known limits: one lease at a time per process; a job mid-call during a restart is failed after 5 minutes; sync and webhooks are not on the worker.

## `products/create` webhook

- [x] Subscribed in both tomls (`shopify app config validate` passes); route reuses `handleProductUpdate`, receipt keeps topic `PRODUCTS_CREATE`
- [x] Route test through the real `authenticate.webhook`: row created from the re-fetch (payload title ignored), repeat delivery no-op, forged signature 401
- [ ] Live: create a product in Shopify admin → it appears in the app without a sync (needs `shopify app deploy` to register the topic)
