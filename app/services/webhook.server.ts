import type { Prisma, Shop } from "@prisma/client";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import {
  claimReceipt,
  markReceiptFailed,
  markReceiptProcessed,
} from "../repositories/webhook-receipt.server";
import {
  softDeleteProductByGid,
  upsertProductIfNewer,
} from "../repositories/product.server";
import {
  createShopifyClient,
  type AdminGraphql,
} from "../shopify/graphql-client.server";
import { PRODUCT_BY_ID_QUERY, VARIANTS_PER_PRODUCT } from "../shopify/queries";
import { mapProductNode, type ShopifyProductNode } from "./product-mapping";
import { normalizeShopDomain } from "./shop.server";
import { completeVariants } from "./sync.server";

// Shopify fails a delivery after 5 seconds, so the re-fetch gets one short attempt.
// A timeout becomes FAILED + 500 and Shopify's own retry does the retrying.
const WEBHOOK_API_TIMEOUT_MS = 3000;
const WEBHOOK_BUDGET_MS = 4000;

/** The fields we use from authenticate.webhook(). Only ever built from a verified request. */
export type VerifiedWebhook = {
  shop: string;
  topic: string;
  webhookId: string;
  payload: Record<string, unknown>;
  admin?: { graphql: AdminGraphql };
};

type HandlerArgs = {
  /** Our tenant row; null only when requireActiveShop is false and the shop is unknown. */
  shop: Shop | null;
  /** Marks the receipt PROCESSED. Pass the transaction so it commits with the side effect. */
  finish: (tx: Prisma.TransactionClient | null, note?: string) => Promise<void>;
};

/**
 * Shared webhook pipeline: resolve tenant -> claim receipt (dedupe) -> run handler ->
 * record PROCESSED / FAILED -> choose the HTTP status Shopify sees.
 * 200 = do not retry. 500 = retry later (same webhookId, which a FAILED receipt allows).
 */
export async function processWebhook(
  webhook: VerifiedWebhook,
  options: { requireActiveShop: boolean },
  handler: (args: HandlerArgs) => Promise<void>,
): Promise<Response> {
  const started = Date.now();
  const shopDomain = normalizeShopDomain(webhook.shop);
  const { topic, webhookId } = webhook;
  const shop = await db.shop.findUnique({ where: { shopDomain } });
  const log = { shopId: shop?.id ?? null, shopDomain, topic, webhookId };

  const claim = await claimReceipt({ webhookId, topic, shopDomain, shopId: shop?.id ?? null });
  if (claim === "duplicate") {
    logger.info("webhook.duplicate", log);
    return new Response();
  }

  let finished = false;
  const finish: HandlerArgs["finish"] = async (tx, note) => {
    await markReceiptProcessed(tx ?? db, webhookId, note);
    finished = true;
    logger.info("webhook.processed", { ...log, outcome: note ?? "applied", durationMs: Date.now() - started });
  };

  try {
    if (options.requireActiveShop && (!shop || shop.uninstalledAt)) {
      // Retrying can never succeed, so acknowledge and keep the receipt for diagnosis.
      await finish(null, "ignored: shop not active");
      return new Response();
    }
    await handler({ shop, finish });
    if (!finished) await finish(null);
    return new Response();
  } catch (err) {
    const message =
      err instanceof Response
        ? `Shopify request failed (HTTP ${err.status})`
        : err instanceof Error
          ? err.message
          : "Unknown error";
    logger.error("webhook.failed", { ...log, message, durationMs: Date.now() - started });
    await markReceiptFailed(webhookId, message);
    return new Response(null, { status: 500 });
  }
}

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

/** Webhook payloads are REST-shaped: numeric `id`, plus `admin_graphql_api_id` on updates. */
export function productGidFromPayload(payload: Record<string, unknown>): string {
  const gid = payload.admin_graphql_api_id;
  if (typeof gid === "string" && PRODUCT_GID.test(gid)) return gid;
  const id = payload.id;
  if ((typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === "string" && /^\d+$/.test(id))) {
    return `gid://shopify/Product/${id}`;
  }
  throw new Error("Webhook payload has no valid product id");
}

/** True when the event describes a state older than the one we already stored. */
export function isStaleEvent(payloadUpdatedAt: unknown, storedUpdatedAt: Date | null | undefined) {
  if (!storedUpdatedAt || typeof payloadUpdatedAt !== "string") return false;
  const eventTime = Date.parse(payloadUpdatedAt);
  return !Number.isNaN(eventTime) && eventTime < storedUpdatedAt.getTime();
}

/** products/update: payload gives identity only; the data comes from a fresh GraphQL read. */
export function handleProductUpdate(webhook: VerifiedWebhook) {
  return processWebhook(webhook, { requireActiveShop: true }, async ({ shop, finish }) => {
    const shopId = shop!.id;
    const gid = productGidFromPayload(webhook.payload);

    const local = await db.product.findUnique({
      where: { shopId_shopifyProductGid: { shopId, shopifyProductGid: gid } },
      select: { updatedAtShopify: true },
    });
    if (isStaleEvent(webhook.payload.updated_at, local?.updatedAtShopify)) {
      return finish(null, "skipped: stale event"); // saves an API call during bursts
    }

    if (!webhook.admin) throw new Error("No offline session for shop; cannot re-fetch product");
    const deadline = Date.now() + WEBHOOK_BUDGET_MS;
    const checkBudget = () => {
      if (Date.now() >= deadline) throw new Error("Webhook time budget exhausted");
    };
    const client = createShopifyClient(webhook.admin.graphql, {
      maxAttempts: 1,
      requestTimeoutMs: WEBHOOK_API_TIMEOUT_MS,
      deadlineMs: deadline,
      logContext: { shopId, webhookId: webhook.webhookId },
    });
    const data = await client.query<{ product: ShopifyProductNode | null }>(
      "ProductById",
      PRODUCT_BY_ID_QUERY,
      { id: gid, variantsFirst: VARIANTS_PER_PRODUCT },
    );
    if (!data.product) {
      // Deleted between the event and our read; products/delete does the soft delete.
      return finish(null, "skipped: product no longer exists in Shopify");
    }
    const mapped = mapProductNode(await completeVariants(client, data.product, checkBudget));

    await db.$transaction(async (tx) => {
      const result = await upsertProductIfNewer(tx, shopId, mapped, new Date());
      await finish(tx, result.skipped ? "skipped: local copy is newer" : undefined);
    });
  });
}

/** products/delete: payload is just { id }. Soft delete keeps variants and enrichment. */
export function handleProductDelete(webhook: VerifiedWebhook) {
  return processWebhook(webhook, { requireActiveShop: true }, async ({ shop, finish }) => {
    const gid = productGidFromPayload(webhook.payload);
    await db.$transaction(async (tx) => {
      const count = await softDeleteProductByGid(tx, shop!.id, gid);
      await finish(tx, count === 0 ? "no-op: product unknown or already deleted" : undefined);
    });
  });
}
