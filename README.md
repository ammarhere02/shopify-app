# Merchant Product Enrichment Hub

An embedded Shopify app. A merchant copies their product catalog from Shopify into MySQL, adds a public **badge** (for example "Staff Pick") and a private **internal note** to chosen products, reads and writes that data through a secured API, and shows the badge on the storefront product page through a theme app block. Shopify product changes reach the local copy through verified webhooks, and a Reconcile action repairs anything a webhook missed.

Built with React Router 7, TypeScript, Prisma, MySQL 8 and a Theme App Extension. Admin API version `2026-07`, scope `read_products` only: the app never writes to Shopify.

**Status:** every Must requirement of the assignment is implemented and covered by automated tests. Some live development-store checks and the submission documents (architecture note, ER diagram, OpenAPI file) are still open: see [docs/VERIFICATION.md](docs/VERIFICATION.md) and [Known gaps](#known-gaps).

## Repository layout

Each folder has a `README.md` that explains what it holds and how it works. Start with the one for the area you want to review.

| Folder | What is there |
|---|---|
| [app/](app/README.md) | Server and admin UI. Layering rule: routes → services → repositories → MySQL |
| [app/routes/](app/routes/README.md) | Every URL: admin pages, webhooks, `/api/v1`, the storefront proxy endpoint, with status codes |
| [app/services/](app/services/README.md) | Business logic: tenant guard, sync, webhook pipeline, API auth and rate limits, storefront badge |
| [app/repositories/](app/repositories/README.md) | All database queries, always scoped by shop |
| [app/shopify/](app/shopify/README.md) | Admin GraphQL queries and the retrying, throttle-aware client |
| [db/](db/README.md) | Prisma schema, migrations, tables, constraints, indexes |
| [extensions/](extensions/README.md) | `product-badge` Theme App Extension: Liquid block, schema settings, CSS, JS |
| [tests/](tests/README.md) | Unit and real-MySQL integration tests, and what each file covers |
| [scripts/](scripts/README.md) | Integration test runner and the API key command |
| [docker/](docker/README.md) | MySQL init script used by `docker-compose.yml` |
| [docs/](docs/README.md) | Design decisions and their reasons, verification status and checklists |

This follows the assignment's recommended layout (`/app`, `/extensions/product-badge/blocks` and `/assets`, `/db/migrations`, `/tests`, `/docs`, `.env.example`, `README.md`).

```
Merchant -> Shopify authorization -> verified session -> MySQL shop + session
Merchant -> Sync now -> Admin GraphQL (paginated) -> upserts -> MySQL
Shopify  -> signed webhook -> HMAC check -> receipt / dedupe -> MySQL
Script   -> /api/v1 + API key -> shop taken from the key -> MySQL
Shopper  -> theme block JS -> Shopify app proxy (signed) -> /proxy -> active badge only
```

## Set up and run

Prerequisites:

- Node `>=20.19 <22` or `>=22.12` (developed on 22.17.1) and npm
- Docker with Compose
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli)
- A Shopify Partner/developer account and a **development store**. Use test data only, never a production store

```sh
npm ci
cp .env.example .env          # skip if you already have a .env
docker compose up -d mysql    # wait until the container is healthy
npm run setup                 # prisma generate + prisma migrate deploy
npm run dev                   # shopify app dev
```

1. `shopify.app.toml` holds the author's app `client_id`. To use your own app run `npm run config:link` and pick or create an app, then check that the scope is still `read_products` and the webhook API version is still `2026-07`.
2. `npm run dev` asks for the development store, opens a tunnel, and updates the app URL, redirect URL and app proxy URL for you.
3. Press `p` to open the app in the Shopify admin and install it. A plain `localhost` page cannot create an embedded session.

### Environment variables

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | `.env`. The value in `.env.example` matches `docker-compose.yml` (host port **3307**, user and password `app`, database `enrichment_hub`) |
| `TEST_DATABASE_URL` | `.env`. Only for integration tests. Must be local and end in `_test` |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Injected by `npm run dev`. For any other way of running the app, copy them from the app's page in the Shopify Dev Dashboard / Partner Dashboard (`npm run env -- show` prints them) |

The database credentials in this repository are placeholders for a local container. No real secret, token or merchant data is committed; `.env` is gitignored.

### Database

`docker compose up -d mysql` starts MySQL 8 as `enrichment-hub-mysql`. On a new volume it creates `enrichment_hub` and `enrichment_hub_test`. Migrations live in `db/migrations` and are applied by `npm run setup` (and again on every `npm run dev`). To change the schema see [db/README.md](db/README.md).

## Use the app

1. **Home** shows the shop, install state, product counts and the last sync run. **Sync now** imports the whole catalog with cursor pagination. Running it again updates rows in place and never touches badges or notes. **Reconcile** is the same full read under a separate label, used to repair missed webhooks.
2. **Products** lists the local copy with search, a status filter and a has-badge filter. Open a product to set badge text (up to 40 characters), badge colour (`#RRGGBB`), the active flag and an internal note, or to remove them.
3. **Storefront badge**: in the Shopify admin go to Online Store → Themes → Customize, open a product template, Add block → Apps → **Product Badge**, then Save. Block settings: show/hide, alignment, solid or outline style, text size, corner radius. For badges on product cards (home-page Featured collection, collection pages; an extra beyond the assignment, needs a theme like Horizon whose Product card accepts app blocks): open the section's **Product card** → Add block → Apps → **Product Card Badge**. The badge shows only for an active badge on an active product. After an edit the storefront updates within 60 seconds (cache lifetime of the badge response).
4. **Webhooks** `products/update`, `products/delete`, `app/uninstalled` and `app/scopes_update` are declared in `shopify.app.toml`; `npm run dev` registers them. Edit or delete a product in the Shopify admin and the local copy follows.

### Developer API

Create a key for an installed shop. The plaintext is printed once; only its hash is stored:

```sh
npm run api-key -- create your-store.myshopify.com "local test"
```

```sh
curl -H "Authorization: Bearer eh_live_..." "https://<app-url>/api/v1/products?hasBadge=true&limit=10"
```

| Method | Route | Success | Errors |
|---|---|---|---|
| GET | `/api/v1/products` (`query`, `status`, `hasBadge`, `limit`, `cursor`) | 200 | 400, 401, 429 |
| GET | `/api/v1/products/{shopifyProductId}` | 200 | 401, 404 |
| PUT | `/api/v1/products/{shopifyProductId}/enrichment` | 201 created, 200 updated | 400, 401, 404, 413, 422 |
| DELETE | `/api/v1/products/{shopifyProductId}/enrichment` | 204 (repeatable) | 401, 404 |
| POST | `/api/v1/syncs` (optional body `{ "type": "FULL" \| "RECONCILE" }`) | 202 + `Location` | 400, 401, 409, 429 |
| GET | `/api/v1/syncs/{id}` | 200 | 401, 404 |
| GET | `https://<shop>/apps/product-badge/products/{id}` (storefront, no key) | 200 `{ "badge": {...} \| null }`, cached 60s | 400 bad signature, 429 |
| GET | `https://<shop>/apps/product-badge/badges?ids=1,2,3` (storefront, no key, max 50 ids) | 200 `{ "badges": { "<id>": {...} } }`, cached 60s | 400 bad signature or id list, 429 |

Every error has the same shape: `{ "error": { "code", "message", "details"?, "requestId" } }`. The shop always comes from the API key, never from the request. Full behaviour: [app/routes/README.md](app/routes/README.md) and [app/services/README.md](app/services/README.md). An OpenAPI file is not written yet.

## Tests and checks

```sh
npm test                   # unit tests, need nothing
npm run test:integration   # real MySQL; needs the container and TEST_DATABASE_URL in .env
npm run typecheck
npm run lint
npm run build
npx shopify theme check --path extensions/product-badge
```

The integration runner refuses any database that is not on localhost or whose name does not end in `_test`, applies the migrations, and removes only the rows it created. Shopify is mocked in all automated tests; signatures are not: webhook and app-proxy tests sign real requests so the real verification code runs. Live development-store checks are the manual lists in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Known gaps

- **Sync runs inside the request**, with a 60-second work budget. Fine for a development catalog. A larger catalog needs a background worker or a Shopify bulk operation. A failed run keeps the pages already saved, and a re-run is safe.
- **Webhooks are processed inside the request**, with no queue or replay. A delivery that fails all of Shopify's retries stays `FAILED` in `webhook_receipts`, and Reconcile repairs the data.
- **Rate limits live in memory**, so they reset on restart and are per process.
- **No admin page for API keys** (use `npm run api-key`), **no OpenAPI file**, no architecture note or ER diagram yet.
- `variants` has no inventory field, because the app only holds `read_products`.
- No `products/create` subscription: a new product arrives with its first `products/update` or the next sync.
- The `Dockerfile` is the unmodified template file and has not been validated as a deployment path.
- The `"prisma"` key in `package.json` that points Prisma at `db/` prints a deprecation notice; Prisma 7 will want a `prisma.config.ts` instead.

To upgrade the pinned Admin API version change `app/shopify.server.ts`, `.graphqlrc.ts` and `webhooks.api_version` in `shopify.app.toml` together, then re-validate the queries in `app/shopify/queries.ts`.

Why each part is built this way: [docs/DESIGN.md](docs/DESIGN.md).
