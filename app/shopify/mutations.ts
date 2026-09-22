// The only writes this app makes to Shopify. Both validated against 2026-07 with the Shopify
// AI Toolkit. A mutation can fail three ways: transport/GraphQL errors (thrown by the client as
// ShopifyApiError) and `userErrors` inside a 200 response, which the caller must read itself.

/** Scopes: write_products. Only descriptionHtml is sent; nothing else on the product changes. */
export const PRODUCT_DESCRIPTION_UPDATE_MUTATION = `#graphql
  mutation ProductDescriptionUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        descriptionHtml
        updatedAt
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Scopes: write_publications. Publishing to a publication it is already on is a no-op success. */
export const PUBLISH_PRODUCT_MUTATION = `#graphql
  mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
          status
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Scopes: read_publications. Sales channels a product can be published to, and which of them
 * it is already on. `catalogType: APP` = channels (Online Store, Shop, POS ...), not markets.
 */
export const PRODUCT_PUBLICATIONS_QUERY = `#graphql
  query PublicationsForPublish($productId: ID!) {
    publications(first: 50, catalogType: APP) {
      nodes {
        id
        catalog {
          id
          title
        }
      }
    }
    product(id: $productId) {
      id
      status
      resourcePublications(first: 50) {
        nodes {
          publication {
            id
          }
          isPublished
        }
      }
    }
  }
`;

export type UserError = { field: string[] | null; message: string };

export type ProductDescriptionUpdateData = {
  productUpdate: {
    product: { id: string; descriptionHtml: string | null; updatedAt: string; status: string } | null;
    userErrors: UserError[];
  } | null;
};

export type PublishProductData = {
  publishablePublish: {
    publishable: { id: string; status: string } | null;
    userErrors: UserError[];
  } | null;
};

export type ProductPublicationsData = {
  publications: { nodes: Array<{ id: string; catalog: { id: string; title: string } | null }> };
  product: {
    id: string;
    status: string;
    resourcePublications: { nodes: Array<{ publication: { id: string }; isPublished: boolean }> };
  } | null;
};

/** Shopify said no inside a 200 response: the merchant can read these, nothing is retried. */
export class ShopifyUserErrors extends Error {
  constructor(
    public operation: string,
    public userErrors: UserError[],
  ) {
    super(`${operation}: ${userErrors.map((e) => e.message).join("; ") || "rejected by Shopify"}`);
    this.name = "ShopifyUserErrors";
  }
}

/** Returns the payload when Shopify accepted the mutation, throws ShopifyUserErrors otherwise. */
export function requireNoUserErrors<T extends { userErrors: UserError[] }>(
  operation: string,
  payload: T | null | undefined,
): T {
  if (!payload) throw new ShopifyUserErrors(operation, [{ field: null, message: "Empty response" }]);
  if (payload.userErrors.length > 0) throw new ShopifyUserErrors(operation, payload.userErrors);
  return payload;
}
