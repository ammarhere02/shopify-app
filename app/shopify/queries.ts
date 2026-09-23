/**
 * Purpose: Every Admin GraphQL read the app makes (shop, product pages, variants, product + media).
 * Called by: The sync, webhook and generation services through the Shopify client.
 * Input: Variables such as cursors and product ids.
 * Output: Query documents; the data shape is typed where the query is used.
 * Uses: Nothing; plain strings validated against the 2026-07 schema.
 * Does not: Contain mutations (see mutations.ts) or execute anything itself.
 */
/**
 * Admin GraphQL documents. Fields are listed explicitly (no over-fetching).
 * The `#graphql` tag lets Shopify codegen/editor tooling validate them against the schema.
 */

// Cost note: Shopify estimates cost BEFORE running a query and rejects > 1000 points.
// Estimate ≈ 2 + PRODUCTS * (1 + 2 + VARIANTS) = 2 + 25 * 28 = 702 → safe.
// (50 products x 100 variants would be ≈ 5,100 → MAX_COST_EXCEEDED.)
export const PRODUCTS_PAGE_SIZE = 25;
export const VARIANTS_PER_PRODUCT = 25;
export const VARIANTS_PAGE_SIZE = 100;

export const SHOP_QUERY = `#graphql
  query ShopIdentity {
    shop { id name myshopifyDomain }
  }
`;

// One field list for the sync page and the webhook re-fetch, so both always store the same shape.
const PRODUCT_FIELDS = `
        id
        title
        handle
        status
        vendor
        productType
        updatedAt
        variants(first: $variantsFirst) {
          nodes { id title sku price }
          pageInfo { hasNextPage endCursor }
        }`;

export const PRODUCTS_PAGE_QUERY = `#graphql
  query ProductsPage($first: Int!, $after: String, $variantsFirst: Int!) {
    products(first: $first, after: $after, sortKey: ID) {
      nodes {${PRODUCT_FIELDS}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Webhook re-fetch of one product. Returns product: null when it no longer exists.
export const PRODUCT_BY_ID_QUERY = `#graphql
  query ProductById($id: ID!, $variantsFirst: Int!) {
    product(id: $id) {${PRODUCT_FIELDS}
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = `#graphql
  query ProductVariantsPage($id: ID!, $first: Int!, $after: String!) {
    product(id: $id) {
      id
      updatedAt
      variants(first: $first, after: $after) {
        nodes { id title sku price }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// Live read for a description generation: the trusted fields, the CURRENT description (the local
// projection does not store it) and the product's images. The merchant selects media by id from
// this list, so only Shopify-hosted images of this product can ever be sent to the model.
// Images are capped at 1024px: enough for a vision model, cheaper in tokens.
export const PRODUCT_FOR_DESCRIPTION_QUERY = `#graphql
  query ProductForDescription($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      updatedAt
      vendor
      productType
      tags
      status
      media(first: 20) {
        nodes {
          id
          alt
          mediaContentType
          status
          ... on MediaImage {
            image {
              url(transform: { maxWidth: 1024, maxHeight: 1024 })
              width
              height
            }
          }
        }
      }
    }
  }
`;
