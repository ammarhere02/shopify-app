import db from "../db.server";
import { logger } from "../lib/logger.server";
import {
  completePublicationAction,
  createPublicationAction,
  listPublicationActions,
} from "../repositories/publication-action.server";
import type { ShopifyClient } from "../shopify/graphql-client.server";
import {
  PRODUCT_PUBLICATIONS_QUERY,
  PUBLISH_PRODUCT_MUTATION,
  ShopifyUserErrors,
  requireNoUserErrors,
} from "../shopify/mutations";
import type { ProductPublicationsData, PublishProductData } from "../shopify/mutations";
import { GenerationError } from "./description-generation.server";
import { hasScope } from "./shop.server";

/**
 * Publishing = making the product visible on a sales channel ("publication"). It is separate
 * from applying a description and always explicit: the merchant picks one channel and confirms.
 * Two things Shopify does not check for us: the product must be ACTIVE to be visible, and the
 * shop must have granted write_publications (a scope added after install).
 */

const PUBLICATION_GID = /^gid:\/\/shopify\/Publication\/[1-9]\d{0,19}$/;

export type Deps = { shopify: ShopifyClient };

export type PublicationChoice = { id: string; name: string; published: boolean };

/** Channels the merchant can publish to, with the product's current state on each. */
export async function listPublications(deps: Deps, shop: { id: number; scopes: string | null }, productId: number) {
  const product = await db.product.findFirst({ where: { id: productId, shopId: shop.id, deletedAt: null } });
  if (!product) throw new GenerationError("NOT_FOUND", "Product not found");
  if (!hasScope(shop.scopes, "read_publications")) {
    throw new GenerationError("FORBIDDEN", "The app has no permission to read sales channels. Open the app from Shopify admin to grant it.");
  }
  const data = await deps.shopify.query<ProductPublicationsData>(
    "PublicationsForPublish",
    PRODUCT_PUBLICATIONS_QUERY,
    { productId: product.shopifyProductGid },
    50,
  );
  if (!data.product) throw new GenerationError("NOT_FOUND", "Product no longer exists in Shopify");
  const onChannel = new Map(data.product.resourcePublications.nodes.map((n) => [n.publication.id, n.isPublished]));
  return {
    productStatus: data.product.status,
    publications: data.publications.nodes.map<PublicationChoice>((p) => ({
      id: p.id,
      name: p.catalog?.title ?? p.id,
      published: onChannel.get(p.id) ?? false,
    })),
  };
}

/**
 * Publish to one channel. The audit row is written BEFORE the call and completed after, so a
 * process death mid-call leaves a REQUESTED row rather than nothing.
 */
export async function publishProduct(
  deps: Deps,
  shop: { id: number; scopes: string | null },
  productId: number,
  publicationGid: unknown,
  actor: string,
) {
  if (typeof publicationGid !== "string" || !PUBLICATION_GID.test(publicationGid)) {
    throw new GenerationError("VALIDATION", "Invalid publish request", { publicationId: "Must be a Shopify Publication id" });
  }
  if (!hasScope(shop.scopes, "write_publications")) {
    throw new GenerationError("FORBIDDEN", "The app has no permission to publish. Open the app from Shopify admin to grant it.");
  }
  const { productStatus, publications } = await listPublications(deps, shop, productId);
  if (!publications.some((p) => p.id === publicationGid)) {
    throw new GenerationError("VALIDATION", "Invalid publish request", { publicationId: "Not a sales channel of this shop" });
  }
  if (productStatus !== "ACTIVE") {
    throw new GenerationError("CONFLICT", `The product is ${productStatus}. Set it to Active in Shopify before publishing.`);
  }
  const product = (await db.product.findFirst({ where: { id: productId, shopId: shop.id } }))!;
  const action = await createPublicationAction(shop.id, { productId: product.id, publicationGid, requestedBy: actor });

  try {
    const data = await deps.shopify.query<PublishProductData>(
      "PublishProduct",
      PUBLISH_PRODUCT_MUTATION,
      { id: product.shopifyProductGid, input: [{ publicationId: publicationGid }] },
      10,
    );
    requireNoUserErrors("publishablePublish", data.publishablePublish);
  } catch (err) {
    const userErrors = err instanceof ShopifyUserErrors ? err.userErrors : [{ field: null, message: err instanceof Error ? err.message : "failed" }];
    await completePublicationAction(shop.id, action.id, { ok: false, userErrors });
    logger.warn("publish.failed", { shopId: shop.id, productId, actionId: action.id, publicationGid });
    if (err instanceof ShopifyUserErrors) {
      throw new GenerationError("REJECTED", "Shopify did not publish the product", Object.fromEntries(
        err.userErrors.map((e, i) => [e.field?.join(".") || `error${i + 1}`, e.message]),
      ));
    }
    throw err;
  }
  await completePublicationAction(shop.id, action.id, { ok: true });
  logger.info("publish.succeeded", { shopId: shop.id, productId, actionId: action.id, publicationGid });
  return { actionId: action.id, publicationId: publicationGid };
}

export function serializePublicationAction(a: {
  id: number;
  publicationGid: string;
  status: string;
  userErrorsJson: unknown;
  requestedBy: string;
  requestedAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: a.id,
    publicationId: a.publicationGid,
    status: a.status,
    userErrors: (a.userErrorsJson ?? null) as Array<{ field: string[] | null; message: string }> | null,
    requestedBy: a.requestedBy,
    requestedAt: a.requestedAt.toISOString(),
    completedAt: a.completedAt?.toISOString() ?? null,
  };
}

export { listPublicationActions };
