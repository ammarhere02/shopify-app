import type { Shop } from "@prisma/client";
import { AiConfigError } from "../ai/config.server";
import { unauthenticated } from "../shopify.server";
import { ApiError } from "./api.server";
import { GenerationError, createGenerationDeps } from "./description-generation.server";
import type { GenerationDeps } from "./description-generation.server";
import { ShopifyApiError, createShopifyClient } from "../shopify/graphql-client.server";
import type { ShopifyClient } from "../shopify/graphql-client.server";

/** Glue between the generation services and the /api/v1 error envelope. */

const STATUS: Record<GenerationError["code"], [number, string]> = {
  VALIDATION: [422, "validation_failed"],
  NOT_FOUND: [404, "not_found"],
  LIMIT: [429, "generation_limit_reached"],
  CONFLICT: [409, "invalid_state"],
  STALE: [409, "stale_product"],
  REJECTED: [422, "shopify_rejected"],
  FORBIDDEN: [403, "missing_scope"],
};

/**
 * A Shopify failure is not our bug, so it is not a 500. The client learns which kind it was
 * and whether to retry; Shopify's own message text stays in the server log, not the response.
 */
const SHOPIFY_STATUS: Record<ShopifyApiError["kind"], [number, string, string]> = {
  THROTTLED: [429, "shopify_throttled", "Shopify is rate limiting this shop. Retry shortly."],
  TRANSPORT: [502, "shopify_unavailable", "Shopify did not answer. Retry shortly."],
  GRAPHQL: [502, "shopify_error", "Shopify rejected the request."],
  AUTH: [409, "shop_session_unavailable", "No valid Shopify session for this shop. Open the app in Shopify admin, then retry."],
};

/** What the admin page shows for the same failures (same wording, no envelope). */
export function shopifyErrorMessage(err: ShopifyApiError) {
  return SHOPIFY_STATUS[err.kind][2];
}

export function toApiError(err: unknown): unknown {
  if (err instanceof GenerationError) {
    const [status, code] = STATUS[err.code];
    return new ApiError(status, code, err.message, err.details);
  }
  if (err instanceof AiConfigError) {
    return new ApiError(503, "ai_not_configured", "AI generation is not configured on this server");
  }
  if (err instanceof ShopifyApiError) {
    const [status, code, message] = SHOPIFY_STATUS[err.kind];
    return new ApiError(status, code, message, undefined, err.kind === "THROTTLED" ? { "Retry-After": "5" } : undefined);
  }
  return err;
}

/** Runs a handler body and translates generation errors. Everything else reaches withApiAuth unchanged. */
export async function withGenerationErrors<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    throw toApiError(err);
  }
}

/** API calls have no browser session, so the shop's stored offline session is used (as for syncs). */
async function offlineAdmin(shop: Shop) {
  return unauthenticated
    .admin(shop.shopDomain)
    .then((ctx) => ctx.admin)
    .catch(() => {
      throw new ApiError(409, "shop_session_unavailable", "No Shopify session for this shop. Open the app in Shopify admin, then retry.");
    });
}

export async function apiGenerationDeps(shop: Shop, requestId: string): Promise<GenerationDeps> {
  const admin = await offlineAdmin(shop);
  return createGenerationDeps(admin.graphql, { shopId: shop.id, requestId });
}

/** Apply, restore and publish only need Shopify; they must work even when OpenRouter is not configured. */
export async function apiShopifyClient(shop: Shop, requestId: string): Promise<ShopifyClient> {
  const admin = await offlineAdmin(shop);
  return createShopifyClient(admin.graphql, { logContext: { shopId: shop.id, requestId } });
}

export function parseJobId(raw: string | undefined) {
  if (!raw || !/^[1-9]\d{0,9}$/.test(raw)) throw new ApiError(404, "not_found", "Generation not found");
  return Number(raw);
}

/** `Idempotency-Key` header wins; the body field is accepted for clients that cannot set headers. */
export function idempotencyKeyFrom(request: Request, body: Record<string, unknown>) {
  const header = request.headers.get("idempotency-key")?.trim();
  if (header) return header;
  return typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
}

export function generationFields(body: Record<string, unknown>) {
  return {
    mediaIds: Array.isArray(body.mediaIds) ? (body.mediaIds as string[]) : undefined,
    merchantContext:
      body.merchantContext === undefined ? undefined : (body.merchantContext as string | null),
    model: typeof body.model === "string" ? body.model : undefined,
  };
}

export function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_body", "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
