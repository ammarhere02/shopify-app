# app/ — server + admin UI (React Router 7, Shopify app template)

## What this folder is
The whole server and the merchant admin UI. It is one React Router 7 app (Shopify's app template): the same process serves the embedded admin pages, receives Shopify webhooks, answers the developer API under `/api/v1`, and answers the storefront badge lookups that arrive through Shopify's app proxy.

A request always travels in one direction: a **route** authenticates the caller and finds the shop, a **service** holds the rules, a **repository** runs the shop-scoped database query. Shopify Admin GraphQL calls go through `shopify/`.

```
Shopify admin / Shopify webhook / API client / storefront (app proxy)
        -> routes/  -> services/ -> repositories/ -> MySQL (db/)
                           \-> shopify/ -> Shopify Admin GraphQL
```

Merchant Product Enrichment Hub. Status of every phase: `docs/PHASES.md`. Reasons for each design: `docs/LEARNING.md`. Read those before assuming a feature exists.

## Layers (keep this direction: routes → services → repositories → Prisma)
| Path | Role |
|---|---|
| `routes/` | HTTP entry points and pages. Authenticate, resolve the shop, call services/repositories. See `routes/README.md` |
| `services/` | Business logic: tenant guard, sync, mapping, validation, webhook pipeline, developer API pipeline + API keys, storefront badge. See `services/README.md` |
| `repositories/` | The only place with product/enrichment Prisma queries, always scoped by `shopId`. See `repositories/README.md` |
| `shopify/` | Admin GraphQL queries and the retrying client. See `shopify/README.md` |
| `lib/logger.server.ts` | JSON logger `logger.info|warn|error(event, fields)`. Redacts top-level keys matching token/secret/authorization/password/api key/cookie. Use it instead of `console.log` |
| `lib/rate-limit.server.ts` | `createRateLimiter({ limit, windowMs })` → `hit(key)`, `blocked(key)`. In-memory fixed window, one process only |
| `lib/badge-contrast.ts` | `readableTextColor(hex)` → black or white text with at least 4.5:1 contrast. Pure |
| `lib/product-status.ts` | `PRODUCT_STATUSES` (ACTIVE, DRAFT, ARCHIVED). Not `.server` because the UI imports it |
| `shopify.server.ts` | `shopifyApp` config: `ApiVersion.July26` (2026-07), Prisma session storage, `afterAuth` → `recordInstall`. Exports `authenticate` |
| `db.server.ts` | Single PrismaClient (default export `db`) |

## Rules that are easy to break
- Files named `*.server.ts` must never be imported by code that runs in the browser. A route component that needs a constant must import it from a non-server file, or `npm run build` fails with "Server-only module referenced by client".
- Tenant id comes only from `requireActiveShop(session.shop)` after `authenticate.*`. Never from a URL param, form field or body.
- Every webhook goes through `processWebhook` in `services/webhook.server.ts` (receipt, dedupe, status code). Do not write a webhook route that skips it.
- Every `/api/v1` route runs inside `withApiAuth` in `services/api.server.ts`. There the tenant comes from the API key row, never from the URL, query or body.
- Three kinds of caller, three authenticators: admin pages `authenticate.admin`, `/api/v1` `withApiAuth` (API key), storefront `/proxy/*` `authenticate.public.appProxy` (Shopify's signature). Never mix their serializers: only the storefront one is safe for the public.
- Scope is `read_products` only. The app never writes to Shopify.
- The API version is pinned in two places that must match: `shopify.server.ts` and `webhooks.api_version` in `shopify.app.toml`.

## Not built yet (do not assume they exist)
API key management UI (keys are made with `npm run api-key`), OpenAPI document.
