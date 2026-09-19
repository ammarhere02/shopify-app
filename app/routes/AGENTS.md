# app/routes/ — flat file routes (`flatRoutes()` in `app/routes.ts`)

File name = URL. `app.products.$id.tsx` → `/app/products/:id`. Anything under `app.` renders inside `app.tsx`.

| File | URL | What it does |
|---|---|---|
| `app.tsx` | layout for `/app/*` | `authenticate.admin`, `AppProvider`, `NavMenu` (Home, Products). Add new admin pages to the NavMenu here |
| `app._index.tsx` | `/app` | Loader: shop info, product/variant counts, latest sync run. Action: `intent=sync|reconcile` → `startSyncRun` + `runProductSync` (runs inside the request, 60s budget) |
| `app.products._index.tsx` | `/app/products` | List. Filters from URL: `query`, `status`, `hasBadge`, `after` (keyset cursor = last local id). Unknown values are ignored |
| `app.products.$id.tsx` | `/app/products/:id` | Editor. `:id` is the LOCAL product id, looked up with shopId (other shop → 404). Action: `intent=save` (validate → `saveEnrichment`) or `intent=remove` |
| `webhooks.products.update.tsx` | POST `/webhooks/products/update` | `authenticate.webhook` → `handleProductUpdate` |
| `webhooks.products.delete.tsx` | POST `/webhooks/products/delete` | `authenticate.webhook` → `handleProductDelete` |
| `webhooks.app.uninstalled.tsx` | POST | `authenticate.webhook` → `processWebhook` → `recordUninstall`. Active shop NOT required (repeat deliveries arrive after uninstall) |
| `webhooks.app.scopes_update.tsx` | POST | `processWebhook` → updates the session scope and `shops.scopes` |
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

## UI
Polaris web components (`<s-page>`, `<s-section>`, `<s-text-field>`, `<s-table>`…), typed by `@shopify/polaris-types`. Form values are held in React state and sent with `fetcher.submit`; inputs use `onInput`/`onChange` with `e.currentTarget.value`. Internal links: `<s-link href="/app/...">`.

## Known gaps
No `/api/v1` and no app proxy route yet. No `products/create` subscription: new products arrive through their first `products/update` or the next sync.
