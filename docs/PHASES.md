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
| 4 | Product webhooks + receipts | F-08, §4.4 | [~] live checks pending | |
| 5 | Developer API `/api/v1` + API keys | F-06, §4.5 | [ ] | |
| 6 | App proxy + Theme App Extension | F-07, §4.6 | [ ] | |
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
- `shopify.app.toml` has no product webhook subscriptions and no `[app_proxy]` block; `extensions/` is empty → Phases 4 and 6.
- Sync runs inside the request (60s budget). `POST /api/v1/syncs` must return **202** and 409 on conflict, so Phase 5 needs a decision on how the API starts a run without blocking.
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

Code and automated tests done. Live checks pending (need a working HTTPS tunnel; the Cloudflare tunnel fails on the current network, use a hotspot or VPN).

- [x] Subscribed `products/update`, `products/delete` in `shopify.app.toml` (config validates)
- [x] HMAC verification on raw body via `authenticate.webhook` in all four routes
- [x] `webhook_receipts` claimed first (`webhookId` unique) → duplicate = 200 with no side effects
- [x] Atomic re-claim of `FAILED` receipts and of `RECEIVED` older than 60s
- [x] Update: GraphQL re-fetch + same mapping/repository path as sync; stale events skipped; newer-than guard inside the transaction
- [x] Delete: soft-delete by GID, variants and enrichment kept
- [x] Receipt `RECEIVED → PROCESSED/FAILED`, bounded error text; failure returns 500 so Shopify retries
- [x] Unknown/uninstalled shop → 200 + receipt note; missing session → FAILED + 500; product gone → skipped
- [x] Lifecycle webhooks use receipts and the structured logger (no `console.log` left)
- [x] Tests: unit (12) + real MySQL (18) including real-HMAC route tests: valid, forged, tampered, duplicate
- [x] New query validated with the Shopify AI Toolkit against 2026-07 (`read_products`)

Manual dev-store checklist:
- [ ] 1. App started through a public HTTPS tunnel
- [ ] 2. Product webhook subscriptions active (`shopify app dev` output / Partner dashboard → app → webhooks)
- [ ] 3–4. Edit a product title in Shopify Admin → local title changes without pressing Sync
- [ ] 5–6. Same delivery twice → one receipt, no second effect (duplicates are hard to force; covered by automated tests if not reproducible)
- [ ] 7–9. Delete a disposable product → local row has `deletedAt`, enrichment row still exists
- [ ] 10. Logs show `webhook.processed` with shopId/topic/webhookId and no payload or secrets
- [ ] 11. Receipt row is `PROCESSED`
- [ ] 12–13. Safe failure: stop MySQL briefly or delete the shop's session rows, edit a product → 500 and receipt `FAILED`; restore → Shopify's retry turns it `PROCESSED`
- [ ] 14. Uninstall/reinstall still works and writes receipts

Known limits: synchronous processing, no queue or replay of our own; after Shopify's retries run out a receipt stays `FAILED` and Reconcile repairs data; no `products/create` subscription (first update or next sync creates the row); the full sync does not apply the newer-than guard.

## Phase 5 — Developer API `/api/v1`  [ ]

Goal: versioned JSON API secured by API key, tenant taken from the key only.
- [ ] API key: generate, show plaintext once, store SHA-256 hash + prefix, revoke, `lastUsedAt`
- [ ] Auth helper: `Authorization: Bearer <key>` → shop; 401 otherwise; refuse uninstalled shops
- [ ] `GET /api/v1/products` (query, status, hasBadge, cursor) — 200/400/401
- [ ] `GET /api/v1/products/{shopifyGid}` — 200/401/404
- [ ] `PUT /api/v1/products/{shopifyGid}/enrichment` — 200/201/400|422/401/404
- [ ] `DELETE /api/v1/products/{shopifyGid}/enrichment` — idempotent 204
- [ ] `POST /api/v1/syncs` — 202/401/409/429 · `GET /api/v1/syncs/{id}` — 200/401/404
- [ ] Error envelope `{ error: { code, message, details?, requestId } }`
- [ ] Simple rate limit on API-key routes
- [ ] Request tests: auth failure, tenant scoping, valid write, invalid payload, missing product

Decisions to discuss: GID in a URL path (encoding vs numeric tail); how `POST /syncs` returns 202 without a queue; in-memory vs DB rate limiting; where the merchant creates keys.

## Phase 6 — App proxy + Theme App Extension  [ ]

Goal: badge renders on the product page through a merchant-enabled app block.
- [ ] `[app_proxy]` in toml → `/apps/product-badge/...`; verify with `authenticate.public.appProxy`
- [ ] Response contains only `badgeText`, `badgeColor` (never `internalNote`); cache policy; empty state
- [ ] `extensions/product-badge` with `blocks/` Liquid + schema: placement/alignment, style/colour, text size, show/hide, sensible defaults
- [ ] Escaped output, safe DOM insertion (`textContent`), namespaced CSS, small deferred JS, loading/error behaviour
- [ ] Badge does not rely on colour alone; readable contrast
- [ ] Rate limit on the storefront endpoint
- [ ] Verification checklist: active, inactive, missing badge

Decisions to discuss: app proxy (chosen by default) vs app-owned metafield read directly in Liquid; cache duration vs how fast the merchant sees changes.

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
