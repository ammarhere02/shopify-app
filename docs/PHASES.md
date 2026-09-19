# Phases — Merchant Product Enrichment Hub

Tracker for the assignment (18h target, hard stop at 20h). Explanations of *why* live in `docs/LEARNING.md`; this file tracks *what* and *status*.

Legend: `[x]` done · `[~]` partly done · `[ ]` not started

## How we work each phase (mentorship mode)

1. Claude explains the problem in simple terms and shows the existing code that matters.
2. Claude asks: "How do you think we should implement this phase?"
3. Ammar proposes an approach in his own words.
4. Claude reviews it critically (MY APPROACH / WHAT IS CORRECT / WHAT NEEDS CORRECTION / RECOMMENDED APPROACH / WHY / DATA-REQUEST FLOW / FILES LIKELY TO CHANGE).
5. No files change until Ammar says to proceed. Tiny mechanical fixes are exempt.
6. After implementation: test on the dev store, add notes to `LEARNING.md`, tick the boxes here, log time spent.

## Status overview

| # | Phase | PDF refs | Status | Time spent |
|---|---|---|---|---|
| 0 | Review fixes (issues found 2026-09-19) | — | [~] live check pending | |
| 1 | MySQL, schema, install lifecycle | F-01, F-02, §4.1 | [x] | |
| 2 | GraphQL product sync | F-03, F-04, F-09, F-11, §4.2–4.3 | [~] live check pending | |
| 3 | Admin UI: product search + enrichment editor | F-05 | [x] manual check pending | |
| 4 | Product webhooks + receipts | F-08, §4.4 | [~] core live checks done, 5 pending | |
| 5 | Developer API `/api/v1` + API keys | F-06, §4.5 | [~] manual curl check pending | |
| 6 | App proxy + Theme App Extension | F-07, §4.6 | [~] live storefront checks pending | |
| 7 | Remaining tests | §5 Required tests | [ ] | |
| 8 | Docs, demo, submission package | §7 | [ ] | |

Stretch (only after all Musts): F-12 metafield mutation, API-key UI rotation, ETag on storefront endpoint.

---

## Phase 0 — Issues found in the review (2026-09-19)

Verified state: `npm test` 23 passed · `npm run test:integration` 10 passed · typecheck, lint clean · MySQL container healthy.

Fix now (small):
- [x] **No git commits yet.** Everything is untracked. The PDF prefers clean commit history, and secrets must never enter history. Make a first commit per finished phase after checking `.env` is ignored.
- [x] **`.env.example` vs docs mismatch.** `TEST_DATABASE_URL` uses `root:root`, while the docs used `app:app`. Now `app:app` everywhere.
- [ ] **Phase 2 live dev-store checklist is still unchecked** (see Phase 2 below). It was blocked by an expired session. The PDF requires at least one real dev-store integration.
- [x] **Template leftover:** `app/routes/app.additional.tsx` is unused demo code. Remove.

Fold into a later phase (not bugs today, but gaps against the PDF):
- ~~Webhook routes use `console.log`, not the structured logger (`app/lib/logger.server.ts`) → F-10. Fix in Phase 4.~~ done in Phase 4
- ~~`app/uninstalled` and `app/scopes_update` do not write `webhook_receipts`, so lifecycle webhooks have no dedupe record → Phase 4.~~ done in Phase 4
- ~~`shopify.app.toml` has no product webhook subscriptions and no `[app_proxy]` block; `extensions/` is empty.~~ done in Phases 4 and 6
- ~~Sync runs inside the request (60s budget). `POST /api/v1/syncs` must return **202** and 409 on conflict.~~ done in Phase 5 (background run, not awaited)
- `variants` has no inventory field. The PDF says "if authorized"; we only hold `read_products`. Document as a deliberate least-privilege choice in Phase 8.

---

## Phase 1 — MySQL, schema, install lifecycle  [x]

- [x] Docker MySQL 8 on port 3307, Prisma migration, all 8 required tables
- [x] `afterAuth` → `recordInstall`; `app/uninstalled` → `recordUninstall` (sessions deleted in a transaction)
- [x] `requireActiveShop` tenant guard; scopes reduced to `read_products`
- [x] `app/scopes_update` keeps `shops.scopes` fresh
- [x] Pinned API version `2026-07` in code and toml

## Phase 2 — GraphQL product sync  [~]

- [x] Paginated products + variants, mapping/validation, per-page transactional upserts
- [x] SyncRun counters, one run per shop, abandoned-run rule, stale marking (soft delete)
- [x] Bounded retry/backoff, throttle handling, timeouts, redacted structured logs
- [x] Reconcile button (same full sync, type `RECONCILE`)
- [x] Unit + real-MySQL integration tests

Live dev-store checklist (run `shopify app dev`, open the app in the dev store admin):
- [ ] Shop identity and the Sync now button appear
- [ ] With ≥20 test products, Sync now → SUCCEEDED, local product/variant counts match
- [ ] Sync again unchanged → 0 inserted, same totals
- [ ] Rename a product in Shopify, sync → local title updates, same local row id
- [ ] Product with more than 25 variants → all variants copied
- [ ] Delete a disposable product in Shopify, sync → local row soft-deleted
- [ ] Reconcile completes and records type RECONCILE
- [ ] Expired session recovers (re-auth), no error loop

Known limits: sync runs inside the request (60s budget, no queue); a crashed run stays RUNNING until the 15-minute abandon rule; cursor checkpoints are diagnostic, re-runs start from page one; a changing catalog is not a snapshot.

## Phase 3 — Admin UI: search + enrichment editor  [x]

- [x] Product list (`/app/products`): title search, status filter, hasBadge filter, keyset pagination, enrichment loaded in the same query (no N+1)
- [x] Editor (`/app/products/:id`): badge text (≤40), colour `#RRGGBB`, active flag, internal note, remove
- [x] Shared validation module `app/services/enrichment-validation.ts` (reused by the Phase 5 API)
- [x] Repository `app/repositories/enrichment.server.ts`, every query scoped by `shop.id`
- [x] Labelled, keyboard-usable Polaris controls
- [x] Unit tests (validation) + real-MySQL tests (one-per-product, tenant isolation, filters, pagination)
- [ ] Manual check in the dev store admin

Decisions: list + detail routes; keyset pagination on local id; "remove" deletes the row while `active = false` hides it; soft-deleted products are hidden from the list.

## Phase 4 — Product webhooks  [~]

Code and automated tests done. Live update and delete verified on the dev store; items 5–6, 9, 10, 12–14 still pending.

- [x] Subscribed `products/update`, `products/delete` in `shopify.app.toml` (config validates)
- [x] HMAC verification on raw body via `authenticate.webhook` in all four routes
- [x] `webhook_receipts` claimed first (`webhookId` unique) → duplicate = 200 with no side effects
- [x] Atomic re-claim of `FAILED` receipts and of `RECEIVED` older than 60s
- [x] Update: GraphQL re-fetch + same mapping/repository path as sync; stale events skipped; newer-than guard inside the transaction
- [x] Delete: soft-delete by GID, variants and enrichment kept
- [x] Receipt `RECEIVED → PROCESSED/FAILED`, bounded error text; failure returns 500 so Shopify retries
- [x] Unknown/uninstalled shop → 200 + receipt note; missing session → FAILED + 500; product gone → skipped
- [x] Lifecycle webhooks use receipts and the structured logger (no `console.log` left)
- [x] Tests: unit (13) + real MySQL (18) including real-HMAC route tests: valid, forged, tampered, duplicate
- [x] New query validated with the Shopify AI Toolkit against 2026-07 (`read_products`)

Manual dev-store checklist. Evidence read from the dev database on 2026-09-19 (`webhook_receipts`, `products`, `sync_runs`); items without database evidence stay pending.
- [x] 1. App reached through a public HTTPS tunnel (real deliveries arrived from Shopify)
- [x] 2. Product webhook subscriptions active (both topics delivered)
- [x] 3–4. Product edited in Shopify Admin → local row updated with no sync run. Receipt #1 `PRODUCTS_UPDATE`, received 11:21:14.385, `PROCESSED` 11:21:14.956 (0.57s, inside Shopify's 5s limit). Product "Videographer Snowboard": `updatedAtShopify` 11:21:12, `syncedAt` 11:21:14; the last sync run (#4) was at 08:28
- [ ] 5–6. Same delivery twice → one receipt, no second effect. Not reproduced live; covered by automated tests (service level and signed route request)
- [x] 7–8. Product deleted in Shopify → local row soft-deleted. Receipt #2 `PRODUCTS_DELETE` `PROCESSED` in 14ms. "Selling Plans Ski Wax": `deletedAt` set, row and its 3 variants still present
- [ ] 9. Enrichment kept after a live delete. Not shown: the deleted product had no badge. Repeat with a disposable product that has a badge (automated test covers it)
- [ ] 10. Log lines reviewed for `webhook.processed` metadata and absence of payload/secrets (terminal output not captured)
- [x] 11. Receipts reach `PROCESSED` (both rows, `error` NULL, `shopId` set)
- [ ] 12–13. Safe failure → 500 + `FAILED`, then Shopify's retry → `PROCESSED`. No `FAILED` row exists yet
- [ ] 14. Uninstall/reinstall writes lifecycle receipts. No `APP_UNINSTALLED` / `APP_SCOPES_UPDATE` receipt exists yet

Known limits: synchronous processing, no queue or replay of our own; after Shopify's retries run out a receipt stays `FAILED` and Reconcile repairs data; no `products/create` subscription (first update or next sync creates the row); the full sync does not apply the newer-than guard.

## Phase 5 — Developer API `/api/v1`  [~]

Code and automated tests done. Manual `curl` check against the running app pending.

- [x] API key: `eh_live_` + 32 random bytes, SHA-256 hash + prefix stored, plaintext printed once, revoke, throttled `lastUsedAt`
- [x] Key tool: `npm run api-key -- create|list|revoke <shop-domain> [label|prefix]` (admin UI for keys stays a stretch goal)
- [x] `withApiAuth`: request id, Bearer auth, tenant from the key, uniform 401, refuses uninstalled shops
- [x] `GET /api/v1/products` (query, status, hasBadge, limit, opaque cursor) — 200/400/401
- [x] `GET /api/v1/products/{id}` — 200/400/401/404 (`{id}` = numeric Shopify product id; responses carry full GIDs)
- [x] `PUT /api/v1/products/{id}/enrichment` — 201/200/400/413/422/401/404
- [x] `DELETE /api/v1/products/{id}/enrichment` — idempotent 204, 404 for unknown product
- [x] `POST /api/v1/syncs` — 202 + `Location`, 400/401/409/429 · `GET /api/v1/syncs/{id}` — 200/400/401/404
- [x] Error envelope `{ error: { code, message, details?, requestId } }` for every failure incl. 405 and 500; `X-Request-Id` header
- [x] Rate limits: 60/min per key, 5/min per key for sync starts, 20 failed logins/min per IP; `Retry-After`
- [x] Tests: 5 unit + 21 request tests on real MySQL (auth failure, tenant scoping, valid write, invalid payload, missing product, rate limit, sync)

Manual check:
- [ ] `npm run api-key -- create <shop-domain> "demo"` prints a key once
- [ ] `curl -H "Authorization: Bearer <key>" <app-url>/api/v1/products` → 200 with synced products
- [ ] PUT a badge with curl → it appears in the admin Products page
- [ ] No/invalid key → 401 envelope
- [ ] `POST /api/v1/syncs` → 202, then `GET` the `Location` until `SUCCEEDED`
- [ ] Revoke the key → 401

Known limits: rate limits are in memory (single process, reset on restart); the 202 sync has no durable worker (restart leaves the run RUNNING, new starts get 409 for up to 15 minutes); client IP comes from `X-Forwarded-For`, which can be spoofed, so the failed-login limit is a speed bump only; OpenAPI document is a Phase 8 deliverable.

## Phase 6 — App proxy + Theme App Extension  [~]

Code, automated tests and `shopify theme check` done. Live storefront checks pending (needs a working tunnel; enter the storefront password first if the dev store is protected).

- [x] `[app_proxy]` in toml → `/apps/product-badge/...` → app `/proxy/...`; verified with `authenticate.public.appProxy`; config validates
- [x] Response contains only `text`, `color`, `textColor` (never `internalNote`: the query does not even select it); `Cache-Control: public, max-age=60`; identical `{ "badge": null }` for every empty case
- [x] `extensions/product-badge` generated with the CLI; block schema: show/hide, alignment, style (solid/outline), text size, corner radius, all with defaults; product templates only
- [x] Escaped Liquid output, `textContent` insertion, colour re-checked in JS, namespaced CSS, deferred JS from the CDN, hidden until loaded, silent on error, theme-editor-only placeholder
- [x] Badge always carries text (not colour alone); text colour chosen for ≥4.5:1 contrast; outline style uses the theme's text colour
- [x] Rate limit on the storefront endpoint: 120/min per shop + IP, 429 + `Retry-After`
- [x] Tests: contrast unit tests + 4 route tests with a real proxy signature (active, 9 empty cases incl. cross-shop, tampered/unsigned → 400, 429)

Enhancement beyond the PDF (the PDF asks only for a block "suitable for a product template"): **badges on product cards**.
- [x] Second app block **Product Card Badge**, added by the merchant inside the theme's Product card block. Horizon's `_product-card` accepts `@app` blocks and hands each card's product to its children as `closest.product`; the block's `product` setting (`autofill: true`) is connected to it. No theme file is edited and no theme selector is used
- [x] Batch endpoint `/apps/product-badge/badges?ids=1,2,3` → `/proxy/badges`: at most 50 numeric ids, every id validated (else 400, not cached), one shop-scoped query, map keyed by Shopify product id holding only the products with a badge to show, same public fields, same 60s cache, same shared rate limit (one hit per request)
- [x] One script for both blocks: collects every badge container, de-duplicates ids, one request per 50 products; reacts to theme-editor section reloads and to cards added later (filters, load more); optional reserved space so cards do not move
- [x] Tests: 6 more route tests (several products, all unavailable kinds + cross-shop in both directions, uninstalled/unknown shop, malformed and oversized lists, tampered/unsigned, shared rate limit). The single-product endpoint tests are unchanged and still pass

Verification checklist (dev store):
- [ ] Theme editor → product template → Add block → Apps → **Product Badge** appears and can be added without editing theme code
- [ ] Each setting changes the preview: show/hide, alignment, style, text size, corner radius
- [ ] ACTIVE badge: product page shows the badge text in the chosen colour
- [ ] INACTIVE badge (untick Active in the app): nothing renders on the storefront within ~60s
- [ ] MISSING badge: another product shows nothing; theme editor shows the placeholder only
- [ ] Browser network tab: `/apps/product-badge/products/<id>` returns only `text`, `color`, `textColor`
- [ ] Edit the badge text in the app → storefront shows it after at most 60s (hard refresh)
- [ ] Opening the app URL `/proxy/products/<id>` directly (no signature) returns 400
- [ ] Product cards (Horizon): Customize → home page → Featured collection → Product card → Add block → Apps → **Product Card Badge**; the Product setting shows a connected dynamic source (if it is empty, connect it to the closest product with the dynamic-source icon). Repeat on the collection template
- [ ] Home page and collection page: only products with an ACTIVE badge show one, each card shows its own product's badge, and the product-page badge still works
- [ ] Network tab on a collection page: ONE `/apps/product-badge/badges?ids=...` request for the whole grid; body holds only `text`, `color`, `textColor` per id
- [ ] Cards do not move when badges appear (Reserve space on); filtering or loading more products badges the new cards

Known limits: one request per page view (one per 50 products, cached 60s); merchant edits take up to 60s to appear; rate limit is in memory, single process; themes must support `@app` blocks (Online Store 2.0), and for cards the theme's product card itself must accept `@app` blocks and pass its product down (Horizon does, Dawn-era themes do not, there the card block is not offered); the block shows nothing if JavaScript is disabled.

## Phase 7 — Remaining tests  [ ]

- [ ] Fill gaps against the PDF list (unit, integration, request, webhook raw-body, theme checklist)
- [ ] One documented command sequence runs everything
- [ ] Test isolating Shop A from Shop B on API and admin paths

## Phase 8 — Docs, demo, submission  [ ]

- [ ] README: prerequisites, env vars, dev-store setup, MySQL, migrations, run/test, theme-block activation (30-minute setup)
- [ ] Architecture note (diagram, trust boundaries, data ownership, sync/webhook flow, trade-offs)
- [ ] Database doc: ER diagram, indexes, constraints, retention/deletion decisions
- [ ] OpenAPI 3.x file or endpoint reference with examples
- [ ] Test evidence (mocked vs real Shopify), sanitized GraphQL response examples
- [ ] Engineering notes: assumptions, known gaps, security checklist, time per phase, AI/tool usage, next production steps
- [ ] Secret scan of repo and git history; demo video 5–8 min
- [ ] Pre-submission checklist (PDF §11)
