# Merchant Product Enrichment Hub

An embedded Shopify application. It synchronizes a merchant's product catalog from Shopify into MySQL, lets the merchant attach a public badge and a private internal note to a product, exposes that data through an authenticated API, and renders the badge on the storefront through a Theme App Extension. Product changes in Shopify reach the local copy through verified webhooks; a reconciliation run repairs missed events.

**Stack:** React Router 7, TypeScript, Prisma, MySQL 8, Shopify Theme App Extension. Admin GraphQL API version `2026-07`. Access scopes: `read_products`, `write_products`, `read_publications`, `write_publications` (writes are limited to the product description and publishing to a sales channel).

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

1. `shopify.app.toml` references the author's app. Run `npm run config:link` to select or create your own, and confirm the scopes `read_products,write_products,read_publications,write_publications` and webhook API version `2026-07` are retained. A store that installed the app with `read_products` only must grant the new scopes: `shopify app deploy` the config, set the same list in the `SCOPES` environment variable of the running server (it is what `app/shopify.server.ts` compares the session against), then reopen the app; if no consent screen appears, uninstall and reinstall the app on the store (data is kept; the Product Badge theme block must then be removed and re-added in the theme editor). Until then Apply and Publish answer 403 and the product page says so.
2. `npm run dev` prompts for the development store, opens a tunnel and updates the application, redirect and app proxy URLs.
3. Press `p` to open the app in the Shopify admin and install it.

### Environment variables

| Variable | Source |
|---|---|
| `DATABASE_URL` | `.env`; the value in `.env.example` matches `docker-compose.yml` (port 3307, database `enrichment_hub`) |
| `TEST_DATABASE_URL` | `.env`; integration tests only; must be local and end in `_test` |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | Injected by `npm run dev`; otherwise from the app's page in the Shopify Dev Dashboard (`npm run env -- show`). On a deployed server `SCOPES` must equal the toml's `access_scopes` list |
| `OPENROUTER_API_KEY` | Server only. From [openrouter.ai/keys](https://openrouter.ai/keys). Without it the app runs and the AI section says "not configured" |
| `OPENROUTER_MODELS` | Comma-separated allowlist of models that accept **image input and structured outputs**; the first is the default. See *AI product descriptions* |
| `OPENROUTER_DATA_COLLECTION` | `deny` (default: only providers that do not retain prompts) or `allow` (needed by most free models; development data only) |
| `OPENROUTER_TIMEOUT_MS`, `OPENROUTER_MAX_RETRIES`, `AI_MAX_OUTPUT_TOKENS`, `AI_MAX_IMAGES`, `AI_DAILY_LIMIT_PER_SHOP`, `AI_MAX_CONCURRENT_PER_SHOP` | Optional; defaults 60000, 2, 1500, 4, 50, 1 (see `.env.example`) |
| `AI_RESEARCH`, `AI_RESEARCH_MAX_SEARCHES`, `AI_RESEARCH_MAX_RESULTS` | Web research before each description: `on` (default) or `off`; searches per generation (default 3, max 5); results per search (default 5). Each search is billed by OpenRouter on top of the tokens |
| `AI_WORKER` | Optional; `off` disables the in-process generation worker (queued batches then wait) |

The database credentials in this repository are placeholders for a local container. No secret, token or merchant data is committed.

### Database

MySQL 8 runs as the container `enrichment-hub-mysql`. A new volume is initialized with the databases `enrichment_hub` and `enrichment_hub_test`. Migrations are in `db/migrations` and are applied by `npm run setup` and on each `npm run dev`.

## Usage

1. **Synchronize.** On the Sync page (nav entry *Sync*; the product catalogue is the home screen), *Sync now* imports the catalog using cursor pagination. Repeated runs update rows in place and do not modify enrichments. *Reconcile* performs the same full read to repair missed webhooks.
2. **Enrich.** *Products* lists the local catalog with search and filters. A product's editor sets badge text (maximum 40 characters), badge colour (`#RRGGBB`), the active flag and an internal note.
3. **Activate the theme block.** Online Store → Themes → Customize → product template → Add block → Apps → **Product Badge** → Save. Settings: visibility, alignment, style, text size, corner radius. On themes whose product card accepts app blocks (for example Horizon), **Product Card Badge** can be added inside the Product card block to show badges in product grids.
4. **Webhooks.** `products/create`, `products/update`, `products/delete`, `app/uninstalled` and `app/scopes_update` are declared in `shopify.app.toml` and registered by `npm run dev` (or `shopify app deploy` for a deployed app).

A badge is shown only when it is active and the product is active. Storefront responses are cached for 60 seconds.

## AI product descriptions

The product editor's **AI description** section writes a description from the product's Shopify images and merchant-supplied facts, lets the merchant review it, and only then writes it to Shopify.

**OpenRouter setup.** Set `OPENROUTER_API_KEY` (server only) and `OPENROUTER_MODELS`, a comma-separated allowlist of models that support both image input and structured outputs (filter on [openrouter.ai/models](https://openrouter.ai/models?modality=text+image-%3Etext&supported_parameters=structured_outputs)); the first is the default. Router models such as `openrouter/free` are refused because the answering model would be unknown. Used in development: `google/gemini-2.5-flash` (paid, about $0.001–0.003 per generation) and `nex-agi/nex-n2.5-mini:free` (low daily caps). Keep `OPENROUTER_DATA_COLLECTION=deny` in production; free endpoints usually need `allow`, for development data only.

**Workflow.** Generate (1–4 images, optional facts; runs in the background, nothing in Shopify changes). A generation is two model calls: first a **research** call with OpenRouter's web search tool looks up the exact product (title, vendor, type, tags, merchant facts; never the images) and returns specifications with source URLs; a fact is used only when the model identified the exact product and the source page is one the search really returned. Then the **description** call gets the product data, the merchant facts, the confirmed facts and the images. Research that finds nothing certain, or fails, never blocks the description: the draft is written from the Shopify data and a warning says so. Products without a vendor or model number are not researched. → review the draft in an HTML editor with preview, usage, claim warnings and a **Sources** tab (each researched specification with a link to its page) → Save draft / Approve / Reject / Regenerate → **Apply to product** after a confirmation showing previous and new text; if the description changed in Shopify since generation, Apply refuses (`stale_product`). Every write is recorded as a version; **Restore** writes an older version back through the same checks, and *Restore what it replaced* on the newest row brings back the pre-app text.

**Batches.** On the Products list, select up to 20 products, optionally add facts and pick a model, and *Generate descriptions for selected*: one job per product is queued (using each product's first images) and a worker inside the server runs them one at a time per shop; drafts appear on each product page for review. Queued jobs are database rows, so a restart does not lose them.

**Publishing.** *Publish to a channel…* lists the shop's sales channels with the product's state on each. The product must be Active in Shopify (a Draft product would be published but invisible, so the app refuses first). Every attempt is audited in `publication_actions`.

**Scopes.** `read_products` to read, `write_products` for Apply/Restore, `write_publications` for Publish. A store that installed before the write scopes were added must approve them again (Setup, step 1); until then the page says so and the API answers `403 missing_scope`.

**Limits.** Per shop: 1 generation at a time, 50 per rolling 24 h (counted in MySQL), 10 write actions/min on the admin page and per API key. Output is schema-validated and sanitized (`p h2 h3 h4 ul ol li strong em br`, no attributes) on arrival, on edit and before the write. Images are chosen by Shopify media id only; the server never fetches a client URL and stores no image bytes.

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
| GET | `/api/v1/products/{productId}/images` | 200 | 401, 404, 409 |
| POST, GET | `/api/v1/products/{productId}/description-generations` | 202 / 200 | 401, 404, 409, 422, 429, 503 |
| GET | `/api/v1/description-generations/{jobId}` | 200 | 401, 404 |
| POST | `/api/v1/description-generations/{jobId}/regenerate` | 202 / 200 | 401, 404, 409, 422, 429, 503 |
| POST | `/api/v1/description-generations/batch` | 202 | 401, 404, 409, 422, 429, 503 |
| POST | `/api/v1/description-generations/{jobId}/apply` | 201 | 401, 403, 404, 409, 422, 429, 502 |
| GET | `/api/v1/products/{productId}/description-versions` | 200 | 401, 404 |
| POST | `/api/v1/products/{productId}/description-versions/{versionId}/restore` | 201 | 401, 403, 404, 422, 429, 502 |
| GET, POST | `/api/v1/products/{productId}/publish` | 200 | 401, 403, 404, 409, 422, 429, 502 |
| GET | `/apps/product-badge/products/{productId}` (storefront) | 200 | 400, 429 |
| GET | `/apps/product-badge/badges?ids=…` (storefront, maximum 50 ids) | 200 | 400, 429 |

Errors use one envelope: `{ "error": { "code", "message", "details"?, "requestId" } }`. The tenant is derived from the API key, never from the request. Full reference with examples: [docs/SUBMISSION.md](docs/SUBMISSION.md#3-api-documentation); machine-readable: [docs/openapi.yaml](docs/openapi.yaml); Postman: [docs/postman/enrichment-hub.postman_collection.json](docs/postman/enrichment-hub.postman_collection.json).

## Tests

```sh
npm test                   # unit tests
npm run test:integration   # MySQL integration tests; requires the container and TEST_DATABASE_URL
npm run typecheck
npm run lint
npm run build
npx shopify theme check --path extensions/product-badge
```

Shopify API responses and the model provider are mocked in automated tests; no test makes a billable call. Webhook and app proxy signatures are not mocked: the tests sign real requests so the actual verification code runs. The integration runner accepts only a local database whose name ends in `_test`.

## Known limitations

- Synchronization and webhook processing run inside the request (60-second budget for synchronization); there is no background worker or queue. Failed webhook deliveries remain recorded as `FAILED` and are repaired by reconciliation.
- Rate limits are held in memory, per process.
- API keys are managed from the command line; there is no admin page.
- A single generation and the Shopify write run in the process that received the request; a restart abandons a running generation (marked failed after 5 minutes) or an in-flight apply (returned to approved after 2 minutes). Batches run through the in-process worker, whose queue is the database, so queued jobs survive a restart; a job that was mid-call is marked failed after 5 minutes.
- Restore and Publish act on one product and one channel at a time; unpublishing is done in Shopify admin.
- `variants` has no inventory field: the app reads products with `read_products` and never asks for inventory scopes.
- The `Dockerfile` is the unmodified template file and has not been validated for deployment.

To upgrade the Admin API version, change `app/shopify.server.ts`, `.graphqlrc.ts` and `webhooks.api_version` in `shopify.app.toml` together, then re-validate the queries in `app/shopify/queries.ts`.
