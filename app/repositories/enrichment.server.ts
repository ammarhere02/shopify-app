import type { Prisma } from "@prisma/client";
import db from "../db.server";
import type { ProductStatus } from "../lib/product-status";
import type { EnrichmentInput } from "../services/enrichment-validation";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export type ProductListFilters = {
  query?: string;
  status?: ProductStatus;
  hasBadge?: boolean;
  /** Local id of the last row on the previous page (keyset pagination). */
  afterId?: number;
  limit?: number;
};

/**
 * One query returns products WITH their enrichment (no N+1).
 * Every filter sits behind shopId, so a caller can only ever see their own shop.
 */
export async function listProducts(shopId: number, filters: ProductListFilters) {
  const limit = Math.min(filters.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const where: Prisma.ProductWhereInput = { shopId, deletedAt: null };
  if (filters.query) where.title = { contains: filters.query };
  if (filters.status) where.status = filters.status;
  if (filters.hasBadge === true) where.enrichment = { isNot: null };
  if (filters.hasBadge === false) where.enrichment = { is: null };
  if (filters.afterId) where.id = { gt: filters.afterId };

  // Fetch one extra row to learn whether another page exists.
  const rows = await db.product.findMany({
    where,
    orderBy: { id: "asc" },
    take: limit + 1,
    include: { enrichment: true },
  });
  const hasNextPage = rows.length > limit;
  const products = hasNextPage ? rows.slice(0, limit) : rows;
  return {
    products,
    nextCursor: hasNextPage ? products[products.length - 1].id : null,
  };
}

/** Shop-scoped lookup by local id (admin UI). Returns null for another shop's product. */
export function getProductById(shopId: number, id: number) {
  return db.product.findFirst({
    where: { id, shopId },
    include: { enrichment: true, variants: { orderBy: { id: "asc" } } },
  });
}

/** Shop-scoped lookup by Shopify GID (developer API / storefront). */
export function getProductByGid(shopId: number, shopifyProductGid: string) {
  return db.product.findUnique({
    where: { shopId_shopifyProductGid: { shopId, shopifyProductGid } },
    include: { enrichment: true, variants: { orderBy: { id: "asc" } } },
  });
}

/**
 * Create or update the single enrichment of a product.
 * Upsert on the unique productId keeps "one per product" true even on a double submit.
 * Returns null when the product is not in this shop.
 */
export async function saveEnrichment(
  shopId: number,
  productId: number,
  input: EnrichmentInput,
) {
  const product = await db.product.findFirst({
    where: { id: productId, shopId },
    select: { id: true, enrichment: { select: { id: true } } },
  });
  if (!product) return null;

  const enrichment = await db.productEnrichment.upsert({
    where: { productId },
    create: { productId, ...input },
    update: input,
  });
  return { enrichment, created: !product.enrichment };
}

/** Idempotent: removing a missing enrichment is not an error. Returns false if product not in shop. */
export async function removeEnrichment(shopId: number, productId: number) {
  const product = await db.product.findFirst({
    where: { id: productId, shopId },
    select: { id: true },
  });
  if (!product) return false;
  await db.productEnrichment.deleteMany({ where: { productId } });
  return true;
}
