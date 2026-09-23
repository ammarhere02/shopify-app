/**
 * Purpose: Database access for the publish audit trail.
 * Called by: The publication service, and the API publish route for history.
 * Input: Shop id, product id, publication id, the Shopify result.
 * Output: publication_actions rows.
 * Uses: Prisma (MySQL) only.
 * Does not: Call Shopify or decide whether a publish is allowed.
 */
import type { Prisma } from "@prisma/client";
import db from "../db.server";

export type NewPublicationAction = {
  productId: number;
  publicationGid: string;
  requestedBy: string;
};

/** Written BEFORE the Shopify call, so an attempt is on record even if the process dies. */
export function createPublicationAction(shopId: number, input: NewPublicationAction) {
  return db.publicationAction.create({
    data: {
      shopId,
      productId: input.productId,
      publicationGid: input.publicationGid,
      action: "PUBLISH",
      requestedBy: input.requestedBy,
    },
  });
}

/** REQUESTED → SUCCEEDED | FAILED, once. userErrors are kept as returned by Shopify. */
export async function completePublicationAction(
  shopId: number,
  actionId: number,
  result: { ok: true } | { ok: false; userErrors: Prisma.InputJsonValue },
) {
  const { count } = await db.publicationAction.updateMany({
    where: { id: actionId, shopId, status: "REQUESTED" },
    data: result.ok
      ? { status: "SUCCEEDED", completedAt: new Date() }
      : { status: "FAILED", completedAt: new Date(), userErrorsJson: result.userErrors },
  });
  return count === 1;
}

export function listPublicationActions(shopId: number, productId: number, limit = 20) {
  return db.publicationAction.findMany({
    where: { shopId, productId },
    orderBy: { id: "desc" },
    take: limit,
  });
}
