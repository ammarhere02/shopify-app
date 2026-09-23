/**
 * Purpose: Writes an approved draft (or an older version) to the Shopify product description.
 * Called by: The admin generation route (apply, restore) and the /api/v1 apply and restore routes.
 * Input: Shop with granted scopes, job id or version id, the acting identity.
 * Output: A new product_description_versions row; the job becomes APPLIED.
 * Uses: Shopify client (read + productUpdate), ai-generation and description-version repositories.
 * Does not: Publish the product or overwrite a description that changed since generation.
 */
import db from "../db.server";
import { logger } from "../lib/logger.server";
import { getJob, moveReviewStatus, recoverAbandonedApplies } from "../repositories/ai-generation.server";
import { createVersion, getVersion, listVersions } from "../repositories/description-version.server";
import type { ShopifyClient } from "../shopify/graphql-client.server";
import {
  PRODUCT_DESCRIPTION_UPDATE_MUTATION,
  ShopifyUserErrors,
  requireNoUserErrors,
} from "../shopify/mutations";
import type { ProductDescriptionUpdateData } from "../shopify/mutations";
import { GenerationError, fetchProductForDescription } from "./description-generation.server";
import { OUTPUT_LIMITS } from "./description-output";
import { canApply } from "./generation-state";
import { htmlToText, sanitizeHtml } from "./html-sanitize";
import { sha256Hex } from "./input-hash.server";
import { hasScope } from "./shop.server";

/**
 * The only path that writes a description to Shopify. Apply (an approved draft) and Restore
 * (an earlier version) both go through `writeDescription`, so every write gets the same
 * scope check, stale check, sanitizing, userErrors handling and version row.
 *
 * Order for Apply:
 *  1. APPROVED → APPLYING  (conditional update: of two clicks exactly one passes)
 *  2. live read of the product; compare with the job's snapshot           → stale = 409
 *  3. productUpdate (outside any DB transaction: no lock is held during the network call)
 *  4. version row + APPLYING → APPLIED in one transaction
 * A refusal at 2 or 3 moves the job back to APPROVED with the reason, so Apply can be retried.
 * A crash between 3 and 4 leaves APPLYING; `recoverAbandonedApplies` turns it into a retry.
 */

export type ApplyDeps = { shopify: ShopifyClient };

/** Who did the write, for the audit column: staff email/id from the session, or the API key. */
export type Actor = string;

type LiveProduct = {
  id: string;
  descriptionHtml: string;
  updatedAt: string;
  status: string;
};

async function readLive(shopify: ShopifyClient, gid: string): Promise<LiveProduct> {
  const remote = await fetchProductForDescription(shopify, gid);
  if (!remote) throw new GenerationError("NOT_FOUND", "Product no longer exists in Shopify");
  return { id: remote.id, descriptionHtml: remote.descriptionHtml ?? "", updatedAt: remote.updatedAt, status: remote.status };
}

/**
 * The write itself: guarded by what the caller expects the product to look like right now.
 * `expected` comes from the job snapshot (Apply) or is skipped (Restore: the merchant is
 * choosing an old text on purpose and sees the current one in the confirmation).
 */
async function writeDescription(
  deps: ApplyDeps,
  shop: { id: number; scopes: string | null },
  product: { id: number; shopifyProductGid: string },
  html: string,
  expected: { descriptionHash: string; shopifyUpdatedAt: string } | null,
) {
  if (!hasScope(shop.scopes, "write_products")) {
    throw new GenerationError("FORBIDDEN", "The app has no permission to write products. Open the app from Shopify admin to grant it.");
  }
  const live = await readLive(deps.shopify, product.shopifyProductGid);
  if (expected) {
    const liveHash = sha256Hex(live.descriptionHtml);
    // Our own earlier write (interrupted apply) has the target hash: not stale, carry on.
    if (liveHash !== expected.descriptionHash && liveHash !== sha256Hex(html)) {
      throw new GenerationError("STALE", "The product description changed in Shopify since this text was generated. Refresh or regenerate.", {
        shopifyUpdatedAt: live.updatedAt,
      });
    }
  }

  const data = await deps.shopify.query<ProductDescriptionUpdateData>(
    "ProductDescriptionUpdate",
    PRODUCT_DESCRIPTION_UPDATE_MUTATION,
    { product: { id: product.shopifyProductGid, descriptionHtml: html } },
    10,
  );
  const payload = requireNoUserErrors("productUpdate", data.productUpdate);
  if (!payload.product) throw new GenerationError("NOT_FOUND", "Product no longer exists in Shopify");
  return {
    before: live.descriptionHtml,
    after: payload.product.descriptionHtml ?? html,
    shopifyUpdatedAt: new Date(payload.product.updatedAt),
  };
}

/** Sanitize once more right before the write. Empty after sanitizing is a bug upstream, so refuse. */
function finalHtml(html: string | null) {
  const clean = sanitizeHtml(html ?? "");
  if (!htmlToText(clean)) throw new GenerationError("VALIDATION", "The description is empty");
  if (clean.length > OUTPUT_LIMITS.descriptionHtml) throw new GenerationError("VALIDATION", "The description is too long");
  return clean;
}

function refusal(err: unknown) {
  if (err instanceof ShopifyUserErrors) {
    return new GenerationError("REJECTED", "Shopify did not accept the description", Object.fromEntries(
      err.userErrors.map((e, i) => [e.field?.join(".") || `error${i + 1}`, e.message]),
    ));
  }
  return err;
}

export async function applyGeneration(deps: ApplyDeps, shop: { id: number; scopes: string | null }, jobId: number, actor: Actor) {
  await recoverAbandonedApplies(shop.id);
  const job = await getJob(shop.id, jobId);
  if (!job) throw new GenerationError("NOT_FOUND", "Generation not found");
  if (!canApply(job.status, job.reviewStatus)) {
    throw new GenerationError("CONFLICT", job.reviewStatus === "APPLIED" ? "This description was already applied" : "Only an approved description can be applied");
  }
  const html = finalHtml(job.draftHtml);
  const product = await db.product.findFirst({ where: { id: job.productId, shopId: shop.id, deletedAt: null } });
  if (!product) throw new GenerationError("NOT_FOUND", "Product not found");
  const snapshot = job.input?.productSnapshotJson as { descriptionHash?: string; shopifyUpdatedAt?: string } | null;
  const expected =
    snapshot?.descriptionHash && snapshot.shopifyUpdatedAt
      ? { descriptionHash: snapshot.descriptionHash, shopifyUpdatedAt: snapshot.shopifyUpdatedAt }
      : null;

  if (!(await moveReviewStatus(db, shop.id, job.id, "APPROVED", "APPLYING"))) {
    throw new GenerationError("CONFLICT", "This description is being applied already");
  }
  let written: Awaited<ReturnType<typeof writeDescription>>;
  try {
    written = await writeDescription(deps, shop, product, html, expected);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Apply failed";
    await db.aiGenerationJob.updateMany({
      where: { id: job.id, shopId: shop.id, reviewStatus: "APPLYING" },
      data: { reviewStatus: "APPROVED", reviewedAt: new Date(), error: reason.slice(0, 1000) },
    });
    logger.warn("ai.apply_refused", { shopId: shop.id, jobId: job.id, productId: product.id, reason });
    throw refusal(err);
  }

  const version = await db.$transaction(async (tx) => {
    const row = await createVersion(tx, shop.id, {
      productId: product.id,
      jobId: job.id,
      source: "AI",
      descriptionHtml: written.after,
      previousDescriptionHtml: written.before,
      shopifyUpdatedAt: written.shopifyUpdatedAt,
      appliedBy: actor,
    });
    await moveReviewStatus(tx, shop.id, job.id, "APPLYING", "APPLIED");
    await tx.aiGenerationJob.updateMany({ where: { id: job.id, shopId: shop.id }, data: { error: null } });
    await tx.product.updateMany({
      where: { id: product.id, shopId: shop.id, updatedAtShopify: { lt: written.shopifyUpdatedAt } },
      data: { updatedAtShopify: written.shopifyUpdatedAt },
    });
    return row;
  });
  logger.info("ai.applied", { shopId: shop.id, jobId: job.id, productId: product.id, versionId: version.id, length: written.after.length });
  return version;
}

export type RestoreWhich = "written" | "previous";

/**
 * Restore = a new write of an older version's text through the same guarded path. The row it
 * came from is recorded, the old row is never changed. No job is involved, so no state moves.
 * `which`: "written" = the text that version put in Shopify; "previous" = the text it replaced
 * (after the very first apply, that is the only copy of the merchant's original description).
 */
export async function restoreVersion(
  deps: ApplyDeps,
  shop: { id: number; scopes: string | null },
  productId: number,
  versionId: number,
  which: RestoreWhich,
  actor: Actor,
) {
  const product = await db.product.findFirst({ where: { id: productId, shopId: shop.id, deletedAt: null } });
  if (!product) throw new GenerationError("NOT_FOUND", "Product not found");
  const source = await getVersion(shop.id, product.id, versionId);
  if (!source) throw new GenerationError("NOT_FOUND", "Version not found");
  const text = which === "previous" ? source.previousDescriptionHtml : source.descriptionHtml;
  if (text === null) throw new GenerationError("NOT_FOUND", "That version has no previous text recorded");
  const html = finalHtml(text);

  let written: Awaited<ReturnType<typeof writeDescription>>;
  try {
    written = await writeDescription(deps, shop, product, html, null);
  } catch (err) {
    logger.warn("ai.restore_refused", { shopId: shop.id, productId: product.id, versionId, reason: err instanceof Error ? err.message : "failed" });
    throw refusal(err);
  }
  const version = await db.$transaction(async (tx) => {
    const row = await createVersion(tx, shop.id, {
      productId: product.id,
      jobId: null,
      source: "RESTORE",
      descriptionHtml: written.after,
      previousDescriptionHtml: written.before,
      shopifyUpdatedAt: written.shopifyUpdatedAt,
      appliedBy: actor,
      restoredFromId: source.id,
    });
    await tx.product.updateMany({
      where: { id: product.id, shopId: shop.id, updatedAtShopify: { lt: written.shopifyUpdatedAt } },
      data: { updatedAtShopify: written.shopifyUpdatedAt },
    });
    return row;
  });
  logger.info("ai.restored", { shopId: shop.id, productId: product.id, versionId: version.id, restoredFromId: source.id });
  return version;
}

export function listDescriptionVersions(shopId: number, productId: number, limit = 20) {
  return listVersions(shopId, productId, limit);
}

/** One public shape of a version for the admin page and /api/v1. */
export function serializeVersion(v: {
  id: number;
  jobId: number | null;
  source: string;
  descriptionHtml: string;
  previousDescriptionHtml: string | null;
  shopifyUpdatedAt: Date;
  appliedAt: Date;
  appliedBy: string;
  restoredFromId: number | null;
}) {
  return {
    id: v.id,
    generationId: v.jobId,
    source: v.source,
    descriptionHtml: v.descriptionHtml,
    previousDescriptionHtml: v.previousDescriptionHtml,
    restoredFromVersionId: v.restoredFromId,
    appliedBy: v.appliedBy,
    appliedAt: v.appliedAt.toISOString(),
    shopifyUpdatedAt: v.shopifyUpdatedAt.toISOString(),
  };
}

export type VersionView = ReturnType<typeof serializeVersion>;
