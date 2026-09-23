/**
 * Purpose: Database access for the history of descriptions this app wrote to Shopify.
 * Called by: The apply service (create) and the product page and API routes (list, get).
 * Input: Shop id, product id, the text before and after a write, the acting identity.
 * Output: Version rows, newest first.
 * Uses: Prisma (MySQL) only.
 * Does not: Call Shopify; the write itself happens in the apply service.
 */
import type { Prisma } from "@prisma/client";
import db from "../db.server";

type Tx = Prisma.TransactionClient;

export type NewVersionInput = {
  productId: number;
  jobId: number | null;
  source: "AI" | "RESTORE";
  descriptionHtml: string;
  previousDescriptionHtml: string | null;
  shopifyUpdatedAt: Date;
  appliedBy: string;
  restoredFromId?: number | null;
};

/**
 * Append-only: this file has no update or delete. A restore is a NEW row pointing at the
 * version it restored, so history always reads in the order things really happened.
 */
export function createVersion(client: Tx | typeof db, shopId: number, input: NewVersionInput) {
  return client.productDescriptionVersion.create({
    data: {
      shopId,
      productId: input.productId,
      jobId: input.jobId,
      source: input.source,
      descriptionHtml: input.descriptionHtml,
      previousDescriptionHtml: input.previousDescriptionHtml,
      shopifyUpdatedAt: input.shopifyUpdatedAt,
      appliedBy: input.appliedBy,
      restoredFromId: input.restoredFromId ?? null,
    },
  });
}

/** Newest first. */
export function listVersions(shopId: number, productId: number, limit = 20) {
  return db.productDescriptionVersion.findMany({
    where: { shopId, productId },
    orderBy: { id: "desc" },
    take: limit,
  });
}

/** Shop- and product-scoped lookup. Another shop's version id returns null. */
export function getVersion(shopId: number, productId: number, versionId: number) {
  return db.productDescriptionVersion.findFirst({
    where: { id: versionId, shopId, productId },
  });
}
