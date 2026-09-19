import type { Prisma } from "@prisma/client";
import type { MappedProduct } from "../services/product-mapping";

type Tx = Prisma.TransactionClient;

/**
 * Save one product + its variants idempotently.
 * - Upsert by (shopId, shopifyProductGid): re-running never duplicates.
 * - Never touches product_enrichments: app-owned data survives refreshes.
 * - Clears deletedAt: a product that re-appears in Shopify becomes live again.
 * - Deletes local variants Shopify no longer returns (unless the list was truncated).
 * Returns whether the product row was newly inserted.
 */
export async function upsertProductWithVariants(
  tx: Tx,
  shopId: number,
  mapped: MappedProduct,
  syncedAt: Date,
): Promise<{ inserted: boolean }> {
  const { product, variants, variantsTruncated } = mapped;

  const existing = await tx.product.findUnique({
    where: { shopId_shopifyProductGid: { shopId, shopifyProductGid: product.shopifyProductGid } },
    select: { id: true },
  });

  const saved = await tx.product.upsert({
    where: { shopId_shopifyProductGid: { shopId, shopifyProductGid: product.shopifyProductGid } },
    create: { ...product, shopId, syncedAt },
    update: { ...product, syncedAt, deletedAt: null },
    select: { id: true },
  });

  for (const v of variants) {
    await tx.variant.upsert({
      where: { shopifyVariantGid: v.shopifyVariantGid },
      create: { ...v, productId: saved.id, syncedAt },
      update: { ...v, productId: saved.id, syncedAt },
    });
  }

  // If we only saw the first N variants we can't know which others were removed, so skip cleanup.
  if (!variantsTruncated) {
    await tx.variant.deleteMany({
      where: {
        productId: saved.id,
        shopifyVariantGid: { notIn: variants.map((v) => v.shopifyVariantGid) },
      },
    });
  }

  return { inserted: !existing };
}

/**
 * After a COMPLETE successful sync: any live product not touched in this run
 * no longer exists in Shopify -> soft delete (enrichment is kept).
 */
export async function markStaleProducts(tx: Tx, shopId: number, runStartedAt: Date) {
  const result = await tx.product.updateMany({
    where: { shopId, deletedAt: null, syncedAt: { lt: runStartedAt } },
    data: { deletedAt: new Date() },
  });
  return result.count;
}
