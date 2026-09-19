# app/ — server + admin UI (React Router 7, Shopify app template)

Merchant Product Enrichment Hub. Status of every phase: `docs/PHASES.md`. Reasons for each design: `docs/LEARNING.md`. Read those before assuming a feature exists.

## Layers (keep this direction: routes → services → repositories → Prisma)
| Path | Role |
|---|---|
| `routes/` | HTTP entry points and pages. Authenticate, resolve the shop, call services/repositories. See `routes/AGENTS.md` |
| `services/` | Business logic: tenant guard, sync, mapping, validation. See `services/AGENTS.md` |
| `repositories/` | The only place with product/enrichment Prisma queries, always scoped by `shopId`. See `repositories/AGENTS.md` |
| `shopify/` | Admin GraphQL queries and the retrying client. See `shopify/AGENTS.md` |
| `lib/logger.server.ts` | JSON logger `logger.info|warn|error(event, fields)`. Redacts top-level keys matching token/secret/authorization/password/api key/cookie. Use it instead of `console.log` |
| `lib/product-status.ts` | `PRODUCT_STATUSES` (ACTIVE, DRAFT, ARCHIVED). Not `.server` because the UI imports it |
| `shopify.server.ts` | `shopifyApp` config: `ApiVersion.July26` (2026-07), Prisma session storage, `afterAuth` → `recordInstall`. Exports `authenticate` |
| `db.server.ts` | Single PrismaClient (default export `db`) |

## Rules that are easy to break
- Files named `*.server.ts` must never be imported by code that runs in the browser. A route component that needs a constant must import it from a non-server file, or `npm run build` fails with "Server-only module referenced by client".
- Tenant id comes only from `requireActiveShop(session.shop)` after `authenticate.*`. Never from a URL param, form field or body.
- Every webhook goes through `processWebhook` in `services/webhook.server.ts` (receipt, dedupe, status code). Do not write a webhook route that skips it.
- Scope is `read_products` only. The app never writes to Shopify.
- The API version is pinned in two places that must match: `shopify.server.ts` and `webhooks.api_version` in `shopify.app.toml`.

## Not built yet (do not assume they exist)
`/api/v1` developer API, API key management, app proxy, theme app extension.
