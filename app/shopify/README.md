# app/shopify/ — Admin GraphQL access (API version 2026-07)

## What this folder is
Everything that talks to Shopify's Admin GraphQL API: the query documents and one client that adds retries, throttle handling, timeouts and logging. The rest of the app never calls `admin.graphql` directly. Reads use `read_products`; the only writes are one product field (`descriptionHtml`, `write_products`) and publishing to a sales channel (`write_publications`), both in `mutations.ts`. Shopify stays the source of truth for catalog fields.

| File | Contents |
|---|---|
| `queries.ts` | `SHOP_QUERY` (ShopIdentity), `PRODUCTS_PAGE_QUERY` (ProductsPage, sorted by ID), `PRODUCT_VARIANTS_QUERY` (ProductVariantsPage), `PRODUCT_BY_ID_QUERY` (ProductById, webhook re-fetch; `product` is null when it no longer exists), `PRODUCT_FOR_DESCRIPTION_QUERY` (ProductForDescription: trusted fields, current `descriptionHtml`, `updatedAt`, first 20 media with `MediaImage.image.url` capped at 1024px; read live for a description generation because the local projection stores neither the description nor media; validated against 2026-07). The page query and ProductById share one `PRODUCT_FIELDS` list so both store the same shape. Sizes: 25 products × 25 variants per page, extra variant pages of 100. Estimated cost 2 + 25 × 28 = 702, under Shopify's 1000 limit. Change sizes only after recomputing this |
| `mutations.ts` | `PRODUCT_DESCRIPTION_UPDATE_MUTATION` (ProductDescriptionUpdate: `productUpdate(product: {id, descriptionHtml})`, returns `descriptionHtml updatedAt status`), `PUBLISH_PRODUCT_MUTATION` (PublishProduct: `publishablePublish(id, input: [{publicationId}])`), `PRODUCT_PUBLICATIONS_QUERY` (PublicationsForPublish: app catalogs = sales channels with `catalog.title`, plus the product's `resourcePublications`; `Publication.name` is deprecated so it is not used). All validated against 2026-07. Also `ShopifyUserErrors` and `requireNoUserErrors(operation, payload)`: a mutation can fail with `userErrors` inside a 200 response, which the client cannot see; callers pass the payload through this helper and get the payload back or a thrown `ShopifyUserErrors` carrying the list |
| `graphql-client.server.ts` | `createShopifyClient(admin.graphql, options)` → `{ query(operationName, document, variables?, expectedCost?) }`. Also `classifyError`, `msUntilAvailable`, `ShopifyApiError` |

## Client behaviour
- Error kinds: `TRANSPORT` (network/5xx, retryable), `THROTTLED` (retryable), `GRAPHQL` (top-level errors, not retryable), `AUTH` (401/403, not retryable). Data that arrives together with GraphQL errors is rejected.
- At most 3 attempts, backoff 1s then 2s. The SDK's own retries are turned off so attempts do not multiply.
- Reads `extensions.cost.throttleStatus` and waits for points before a call when the bucket is too low.
- 10s abort timeout per request; `deadlineMs` caps total time (the sync passes start + 60s).
- Logs shop id, run id, operation, attempt, duration, cost. Never tokens or headers.
- `sleep` and `now` are injectable so tests do not wait.
- Webhooks create the client with `maxAttempts: 1`, `requestTimeoutMs: 3000` and a 4s deadline; the sync uses the defaults with a 60s deadline.

## Rules
- Three error kinds for a mutation: transport/throttle (thrown by the client, retried), top-level GraphQL errors (thrown, not retried), `userErrors` (200 response; use `requireNoUserErrors`, never retried, shown to the merchant).
- Validate any new query or mutation against the 2026-07 schema with the Shopify AI Toolkit before using it.
- Shopify IDs are GID strings (`gid://shopify/Product/123`), never numbers.
