# app/routes/ — flat file routes (`flatRoutes()` in `app/routes.ts`)

## What this folder is
Every URL the app answers. One file is one URL. A route does three things only: authenticate the caller, resolve the shop (tenant), and call a service or repository. There are four groups, each with its own authenticator:

| Group | Files | Caller | Authenticated by |
|---|---|---|---|
| Admin pages | `app.*` | Merchant inside Shopify admin | `authenticate.admin` (session token) |
| Webhooks | `webhooks.*` | Shopify | `authenticate.webhook` (HMAC over the raw body) |
| Developer API | `api.v1.*` | Merchant's scripts | `withApiAuth` (bearer API key) |
| Storefront bridge | `proxy.*` | Shoppers, through Shopify's app proxy | `authenticate.public.appProxy` (signed query) |

File name = URL. `app.products.$id.tsx` → `/app/products/:id`. Anything under `app.` renders inside `app.tsx`.

| File | URL | What it does |
|---|---|---|
| `app.tsx` | layout for `/app/*` | `authenticate.admin`, `AppProvider`, `NavMenu` (Home, Products). Add new admin pages to the NavMenu here |
| `app._index.tsx` | `/app` | Loader: shop info, product/variant counts, latest sync run. Action: `intent=sync|reconcile` → `startSyncRun` + `runProductSync` (runs inside the request, 60s budget) |
| `app.products._index.tsx` | `/app/products` | List. Filters from URL: `query`, `status`, `hasBadge`, `after` (keyset cursor = last local id). Unknown values are ignored |
| `app.products.$id.tsx` | `/app/products/:id` | Editor. `:id` is the LOCAL product id, looked up with shopId (other shop → 404). Action: `intent=save` (validate → `saveEnrichment`) or `intent=remove`. Loader also prepares the AI description section: `loadAiConfig` (names and limits only, never the key; missing config → `configured: false`), a live Shopify read of the product's images (a failure becomes a banner, the badge editor still works), the last 10 generations and the latest one in full. Renders `components/AiDescriptionSection` unless the product is deleted |
| `app.products.$id_.generation.tsx` | `/app/products/:id/generation` (resource route, no UI; the `_` keeps it out of the product page's layout) | Loader `?jobId=`: one generation of this shop AND this product, polled every 2s while QUEUED/RUNNING. Loader `?publications=1`: the shop's sales channels and the product's live status (a `GenerationError` becomes `{ publicationsError }`). Action intents: `generate`, `regenerate` (start the run without awaiting it), `saveDraft` (sanitized), `approve` (saves the editor's text first), `reject`, `reopen`, `apply` (→ `applyGeneration`, returns the job and the version list), `restore` (`versionId`, `which`), `publish` (`publicationId`). Actor for the audit column is `admin:<shop domain>` (offline sessions carry no staff identity). Write intents (generate, regenerate, apply, restore, publish) are limited to 10/min per shop (`adminWriteLimiter`) → `{ ok: false, code: "RATE_LIMITED" }`. `GenerationError`, a missing OpenRouter configuration and `ShopifyApiError` (`code: SHOPIFY_<kind>`, plain sentence, Shopify's text only in the log) all come back as `{ ok: false, message, errors, code }`, not as an error page |
| `webhooks.products.update.tsx` | POST `/webhooks/products/update` | `authenticate.webhook` → `handleProductUpdate` |
| `webhooks.products.delete.tsx` | POST `/webhooks/products/delete` | `authenticate.webhook` → `handleProductDelete` |
| `webhooks.app.uninstalled.tsx` | POST | `authenticate.webhook` → `processWebhook` → `recordUninstall`. Active shop NOT required (repeat deliveries arrive after uninstall) |
| `webhooks.app.scopes_update.tsx` | POST | `processWebhook` → updates the session scope and `shops.scopes` |
| `api.v1.products._index.tsx` | GET `/api/v1/products` | Filters `query`, `status`, `hasBadge`, `limit` (1–100), `cursor` (opaque). Bad values → 400 (stricter than the admin page on purpose) |
| `api.v1.products.$id.tsx` | GET `/api/v1/products/:id` | `:id` = numeric SHOPIFY product id. Product + variants + enrichment. Other shop or soft-deleted → 404 |
| `api.v1.products.$id.enrichment.tsx` | PUT, DELETE | PUT 201 created / 200 updated / 422 validation / 400 bad JSON / 413 too big. DELETE 204, idempotent; 404 only if the product is unknown |
| `api.v1.syncs._index.tsx` | POST `/api/v1/syncs` | Body optional `{type}`. Gets the offline session FIRST (`unauthenticated.admin`), then `startSyncRun`, then runs the sync WITHOUT awaiting → 202 + `Location`. 409 `sync_in_progress` / `shop_session_unavailable` |
| `api.v1.syncs.$id.tsx` | GET `/api/v1/syncs/:id` | Run looked up with `{ id, shopId }`; no `cursor` in the response |
| `api.v1.products.$id.images.tsx` | GET | READY Shopify images of the product, read live (offline session). Their ids are the only accepted `mediaIds` |
| `api.v1.products.$id.description-generations.tsx` | POST, GET | POST: `Idempotency-Key` header (or `idempotencyKey` in the body), `{ mediaIds, merchantContext?, model? }` → 202 + `Location`, or 200 with the existing job for a repeated key. Rate-limit bucket `generation` (10/min per key). GET: the product's generations, newest first |
| `api.v1.description-generations.$jobId.tsx` | GET | One generation in the `serializeGeneration` shape. Other shop or malformed id → 404 |
| `api.v1.description-generations.$jobId.regenerate.tsx` | POST | New job linked by `previousGenerationId`; optional overrides; 409 while the previous job is still running |
| `api.v1.description-generations.$jobId.apply.tsx` | POST | Writes the APPROVED draft to Shopify. No body. 201 + version row; 409 `invalid_state` (not approved / already applied / being applied), 409 `stale_product`, 422 `shopify_rejected` (userErrors in `details`), 403 `missing_scope`, 404 other shop. Bucket `generation` |
| `api.v1.products.$id.description-versions.tsx` | GET | Versions this app wrote for the product, newest first (max 20). Soft-deleted products still list |
| `api.v1.products.$id.description-versions.$versionId.restore.tsx` | POST | Body optional `{ which: "written" \| "previous" }`. Writes that text to Shopify through the same guarded path, 201 + the NEW version row with `restoredFromVersionId`. 404 unknown/other shop/other product, 422 bad `which` |
| `api.v1.products.$id.publish.tsx` | GET, POST | GET: `{ productStatus, publications: [{id, name, published}], history }` (live channels + this app's publish audit). POST `{ publicationId }` → 200 `{ actionId, publicationId }`; 409 product not ACTIVE, 422 unknown/malformed channel or userErrors, 403 `missing_scope` |
| `proxy.products.$id.tsx` | GET `/proxy/products/:id`, reached by shoppers as `https://<shop>/apps/product-badge/products/:id` | `authenticate.public.appProxy` (bad signature → 400) → shop from the SIGNED `shop` query param → `getStorefrontBadge`. 200 `{ badge: {text,color,textColor} \| null }` with `Cache-Control: public, max-age=60`; 429 + `Retry-After` when limited |
| `proxy.badges.tsx` | GET `/proxy/badges?ids=1,2,3`, reached as `https://<shop>/apps/product-badge/badges?ids=...` | Product grids: one call for many cards. Same `authenticate.public.appProxy` and signed `shop` → `getStorefrontBadges`. 200 `{ badges: { "<shopifyProductId>": {text,color,textColor} } }` holding only products with a badge to show, `Cache-Control: public, max-age=60`; 400 `{ badges: {} }` `no-store` for an empty, malformed or >50 id list; 429 + `Retry-After` |
| `auth.$.tsx`, `auth.login/` | auth | Template auth routes. Leave alone |
| `_index/` | `/` | Template landing/login page |

## Pattern for an admin page
```ts
const { session, admin } = await authenticate.admin(request);
const shop = await requireActiveShop(session.shop); // tenant
// then call repositories/services with shop.id
```
Export `headers` with `boundary.headers` (copy from an existing page). Thrown `Response` objects must reach the framework unchanged (re-auth redirects).

## Pattern for a webhook route
```ts
const webhook = await authenticate.webhook(request); // [framework] reads the raw body, checks HMAC, throws 401/400
return handleX(webhook);                              // [project] receipt + dedupe + work + status code
```
Nothing may read `request` before `authenticate.webhook` (the body can be read once). The route URL must equal the `uri` in `shopify.app.toml`. Use `webhook.shop` for the tenant, never a payload field. `webhook.admin`/`session` are undefined when the shop has no offline session.

## Pattern for an API route
```ts
export const loader = ({ request, params }) =>
  withApiAuth(request, { methods: ["GET"] }, async ({ shop }) => json({ data }));
```
Resource routes have no component. `loader` receives GET, `action` receives every other method, so each file exports both and the unused one only produces the 405 envelope. Throw `ApiError(status, code, message, details?)` for every failure. Admin pages use the LOCAL product id in URLs; the API uses the SHOPIFY numeric id.

## UI
Polaris web components (`<s-page>`, `<s-section>`, `<s-text-field>`, `<s-table>`…), typed by `@shopify/polaris-types`. Form values are held in React state and sent with `fetcher.submit`; inputs use `onInput`/`onChange` with `e.currentTarget.value`. Internal links: `<s-link href="/app/...">`.

## Known gaps
No admin page for API keys. No `products/create` subscription: new products arrive through their first `products/update` or the next sync.
