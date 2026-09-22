# Documentation

| Document | Contents |
|---|---|
| [SUBMISSION.md](SUBMISSION.md) | Architecture note, database documentation, `/api/v1` endpoint reference, test evidence |
| [DESIGN.md](DESIGN.md) | Design decisions, alternatives considered and known limits, by area of the application |
| [VERIFICATION.md](VERIFICATION.md) | Implementation status against the assignment requirements, automated test results, development-store checklists |
| [openapi.yaml](openapi.yaml) | OpenAPI 3.1 description of `/api/v1` with schemas and examples |
| [postman/enrichment-hub.postman_collection.json](postman/enrichment-hub.postman_collection.json) | Postman collection for every endpoint (variables: `baseUrl`, `apiKey`, `productId`, …) |
| [diagrams/](diagrams/) | Architecture and ER diagrams, the AI generation flow (`ai-generation.png`) and its tables (`er-ai.png`), with Mermaid sources |

Folder-level documentation is in each folder's `README.md`.

## Architecture

![Architecture diagram: Shopify platform, application routes, services and repositories, and the MySQL tables](diagrams/architecture.png)

Trust boundaries, data ownership and the request flows are described in [SUBMISSION.md, section 1](SUBMISSION.md#1-architecture-note).

## Database

![ER diagram: a shop owns products, sync runs, webhook receipts and API keys; a product has variants and at most one enrichment](diagrams/er-diagram.png)

Tables, constraints, indexes and deletion rules are described in [SUBMISSION.md, section 2](SUBMISSION.md#2-database-documentation). The AI description tables, the asynchronous generation flow and the Shopify write boundaries are in [SUBMISSION.md, section 5](SUBMISSION.md#5-ai-description-generator).

## Developer API evidence

Captured on 2026-09-20 in Postman against the development store, authenticated with a Bearer API key (masked). The six requests form one round trip on a single product: read, create an enrichment, read it back, delete it, read again. The endpoint reference is in [SUBMISSION.md, section 3](SUBMISSION.md#3-api-documentation).

**1. `GET /api/v1/products` — 200 OK**

![Postman: GET /api/v1/products returns 200 with the synchronized products](postman/01-get-products.png)

**2. `GET /api/v1/products/{productId}` — 200 OK**, product with variants, no enrichment

![Postman: GET one product returns 200 with variants and enrichment null](postman/02-get-product.png)

**3. `PUT /api/v1/products/{productId}/enrichment` — 201 Created**

![Postman: PUT enrichment returns 201 Created](postman/03-put-enrichment-201.png)

**4. `GET /api/v1/products/{productId}` — 200 OK**, enrichment present

![Postman: GET product returns 200 with the new enrichment](postman/04-get-product-with-enrichment.png)

**5. `DELETE /api/v1/products/{productId}/enrichment` — 204 No Content**

![Postman: DELETE enrichment returns 204 No Content](postman/05-delete-enrichment-204.png)

**6. `GET /api/v1/products/{productId}` — 200 OK**, enrichment removed

![Postman: GET product after delete returns 200 with enrichment null](postman/06-get-product-after-delete.png)

The sync endpoints and the error responses (401, 404, 409, 422, 429) are covered by the automated request tests listed in [SUBMISSION.md, section 4](SUBMISSION.md#4-test-evidence).
