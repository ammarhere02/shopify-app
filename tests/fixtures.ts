import type { ShopifyProductNode } from "../app/services/product-mapping";

export function product(id = 1, variants = 1): ShopifyProductNode {
  return {
    id: `gid://shopify/Product/${id}`,
    title: "Red T-shirt",
    handle: `shirt-${id}`,
    status: "ACTIVE",
    vendor: "",
    productType: "",
    updatedAt: "2026-07-01T00:00:00Z",
    variants: {
      nodes: Array.from({ length: variants }, (_, index) => ({
        id: `gid://shopify/ProductVariant/${id * 1000 + index}`,
        title: `Size ${index}`,
        sku: null,
        price: "19.99",
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}
