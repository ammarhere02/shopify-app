# Merchant Product Enrichment Hub

An embedded Shopify application. It synchronizes a merchant's product catalog from Shopify into MySQL, lets the merchant attach a public badge and a private internal note to a product, exposes that data through an authenticated API, and renders the badge on the storefront through a Theme App Extension. Product changes in Shopify reach the local copy through verified webhooks; a reconciliation run repairs missed events.

**Stack:** React Router 7, TypeScript, Prisma, MySQL 8, Shopify Theme App Extension. Admin GraphQL API version `2026-07`. Access scope: `read_products`.

## Documentation

| Document | Contents |
|---|---|
| [docs/README.md](docs/README.md) | Architecture diagram, ER diagram, API evidence |
| [docs/SUBMISSION.md](docs/SUBMISSION.md) | Architecture note, database documentation, API reference, test evidence |
| [docs/DESIGN.md](docs/DESIGN.md) | Design decisions and trade-offs |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | Requirement status and verification checklists |

## Repository layout

| Folder | Contents |
|---|---|
| [app/](app/README.md) | Server and admin UI |
| [app/routes/](app/routes/README.md) | Admin pages, webhooks, `/api/v1`, storefront proxy endpoints |
| [app/services/](app/services/README.md) | Tenant guard, synchronization, webhook pipeline, API authentication, storefront badge |
| [app/repositories/](app/repositories/README.md) | Database queries, scoped by shop |
| [app/shopify/](app/shopify/README.md) | Admin GraphQL queries and client |
| [db/](db/README.md) | Prisma schema and migrations |
| [extensions/](extensions/README.md) | `product-badge` Theme App Extension |
| [tests/](tests/README.md) | Unit and integration tests |
| [scripts/](scripts/README.md), [docker/](docker/README.md) | Test runner, API key command, MySQL init script |

## Prerequisites

- Node.js `>=20.19 <22` or `>=22.12`, npm
- Docker with Compose
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli)
- A Shopify Partner account and a development store (test data only)

## Setup

```sh
npm ci
cp .env.example .env
docker compose up -d mysql    # wait until the container is healthy
npm run setup                 # prisma generate + prisma migrate deploy
npm run dev                   # shopify app dev
```

1. `shopify.app.toml` references the author's app. Run `npm run config:link` to select or create your own, and confirm the scope `read_products` and webhook API version `2026-07` are retained.
2. `npm run dev` prompts for the development store, opens a tunnel and updates the application, redirect and app proxy URLs.
3. Press `p` to open the app in the Shopify admin and install it.

### Environment variables

| Variable | Source |
|---|---|
| `DATABASE_URL` | `.env`; the value in `.env.example` matches `docker-compose.yml` (port 3307, database `enrichment_hub`) |
| `TEST_DATABASE_URL` | `.env`; integration tests only; must be local and end in `_test` |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Injected by `npm run dev`; otherwise from the app's page in the Shopify Dev Dashboard (`npm run env -- show`) |

The database credentials in this repository are placeholders for a local container. No secret, token or merchant data is committed.

### Database

MySQL 8 runs as the container `enrichment-hub-mysql`. A new volume is initialized with the databases `enrichment_hub` and `enrichment_hub_test`. Migrations are in `db/migrations` and are applied by `npm run setup` and on each `npm run dev`.

## Usage

1. **Synchronize.** On the app home page, *Sync now* imports the catalog using cursor pagination. Repeated runs update rows in place and do not modify enrichments. *Reconcile* performs the same full read to repair missed webhooks.
2. **Enrich.** *Products* lists the local catalog with search and filters. A product's editor sets badge text (maximum 40 characters), badge colour (`#RRGGBB`), the active flag and an internal note.
3. **Activate the theme block.** Online Store → Themes → Customize → product template → Add block → Apps → **Product Badge** → Save. Settings: visibility, alignment, style, text size, corner radius. On themes whose product card accepts app blocks (for example Horizon), **Product Card Badge** can be added inside the Product card block to show badges in product grids.
4. **Webhooks.** `products/update`, `products/delete`, `app/uninstalled` and `app/scopes_update` are declared in `shopify.app.toml` and registered by `npm run dev`.

A badge is shown only when it is active and the product is active. Storefront responses are cached for 60 seconds.

## Developer API

Create an API key for an installed shop. The key is displayed once; only its hash is stored.

```sh
npm run api-key -- create your-store.myshopify.com "label"
curl -H "Authorization: Bearer <key>" "https://<app-url>/api/v1/products?hasBadge=true&limit=10"
```

| Method | Route | Success | Errors |
|---|---|---|---|
| GET | `/api/v1/products` | 200 | 400, 401, 429 |
| GET | `/api/v1/products/{productId}` | 200 | 401, 404 |
| PUT | `/api/v1/products/{productId}/enrichment` | 201, 200 | 400, 401, 404, 413, 422 |
| DELETE | `/api/v1/products/{productId}/enrichment` | 204 | 401, 404 |
| POST | `/api/v1/syncs` | 202 | 400, 401, 409, 429 |
| GET | `/api/v1/syncs/{id}` | 200 | 401, 404 |
| GET | `/apps/product-badge/products/{productId}` (storefront) | 200 | 400, 429 |
| GET | `/apps/product-badge/badges?ids=…` (storefront, maximum 50 ids) | 200 | 400, 429 |

Errors use one envelope: `{ "error": { "code", "message", "details"?, "requestId" } }`. The tenant is derived from the API key, never from the request. Full reference: [docs/SUBMISSION.md](docs/SUBMISSION.md#3-api-documentation).

## Tests

```sh
npm test                   # unit tests
npm run test:integration   # MySQL integration tests; requires the container and TEST_DATABASE_URL
npm run typecheck
npm run lint
npm run build
npx shopify theme check --path extensions/product-badge
```

Shopify API responses are mocked in automated tests. Webhook and app proxy signatures are not: the tests sign real requests so the actual verification code runs. The integration runner accepts only a local database whose name ends in `_test`.

## Known limitations

- Synchronization and webhook processing run inside the request (60-second budget for synchronization); there is no background worker or queue. Failed webhook deliveries remain recorded as `FAILED` and are repaired by reconciliation.
- Rate limits are held in memory, per process.
- API keys are managed from the command line; there is no admin page. An OpenAPI file is not provided; the endpoint reference is in `docs/SUBMISSION.md`.
- `variants` has no inventory field because the app holds only `read_products`.
- There is no `products/create` subscription; a new product arrives with its first update or the next synchronization.
- The `Dockerfile` is the unmodified template file and has not been validated for deployment.

To upgrade the Admin API version, change `app/shopify.server.ts`, `.graphqlrc.ts` and `webhooks.api_version` in `shopify.app.toml` together, then re-validate the queries in `app/shopify/queries.ts`.
