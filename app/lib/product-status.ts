/** Shopify product statuses. Lives outside *.server files because the UI renders it too. */
export const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
