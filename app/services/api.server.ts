import { randomUUID } from "node:crypto";
import type { Shop } from "@prisma/client";
import { logger } from "../lib/logger.server";
import { createRateLimiter } from "../lib/rate-limit.server";
import { authenticateApiKey } from "./api-key.server";

const MAX_BODY_BYTES = 10_000;

// Per authenticated key (keyed by DB id, so random tokens cannot grow the map).
const keyLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const syncLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });
// Per client IP, counts only FAILED logins. A speed bump: the 256-bit key is the real defence.
const failedAuthLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

export function resetRateLimitsForTests() {
  keyLimiter.reset();
  syncLimiter.reset();
  failedAuthLimiter.reset();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function errorResponse(err: ApiError, requestId: string) {
  return json(
    { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), requestId } },
    err.status,
    err.headers,
  );
}

function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export type ApiContext = { shop: Shop; requestId: string; request: Request };

/**
 * Every /api/v1 route runs inside this: request id -> API key -> tenant -> rate limit ->
 * handler -> one error envelope. The shop ALWAYS comes from the key, never from the request.
 */
export async function withApiAuth(
  request: Request,
  options: { methods: string[]; bucket?: "default" | "sync" },
  handler: (ctx: ApiContext) => Promise<Response>,
): Promise<Response> {
  const requestId = randomUUID();
  const started = Date.now();
  const route = new URL(request.url).pathname;
  const log: Record<string, unknown> = { requestId, method: request.method, route };
  let response: Response;

  try {
    if (!options.methods.includes(request.method))
      throw new ApiError(405, "method_not_allowed", "Method not allowed", undefined, { Allow: options.methods.join(", ") });

    const ip = clientIp(request);
    const gate = failedAuthLimiter.blocked(ip);
    if (gate.blocked) throw tooMany(gate.retryAfterSec);

    const auth = await authenticateApiKey(request.headers.get("authorization"));
    if (!auth.ok) {
      failedAuthLimiter.hit(ip);
      log.authFailure = auth.reason; // reason goes to logs only; the response is identical for all
      throw new ApiError(401, "unauthorized", "A valid API key is required", undefined, { "WWW-Authenticate": "Bearer" });
    }
    log.shopId = auth.shop.id;
    log.keyId = auth.key.id;

    const limiter = options.bucket === "sync" ? syncLimiter : keyLimiter;
    const hit = limiter.hit(String(auth.key.id));
    if (!hit.allowed) throw tooMany(hit.retryAfterSec);

    response = await handler({ shop: auth.shop, requestId, request });
  } catch (err) {
    if (err instanceof ApiError) {
      response = errorResponse(err, requestId);
    } else {
      log.message = err instanceof Error ? err.message : "Unknown error";
      response = errorResponse(new ApiError(500, "internal_error", "Unexpected server error"), requestId);
    }
  }

  response.headers.set("X-Request-Id", requestId);
  const fields = { ...log, status: response.status, durationMs: Date.now() - started };
  if (response.status >= 500) logger.error("api.request", fields);
  else logger.info("api.request", fields);
  return response;
}

function tooMany(retryAfterSec: number) {
  return new ApiError(429, "rate_limited", "Too many requests", undefined, { "Retry-After": String(retryAfterSec) });
}

/** URL uses the numeric Shopify id (no slashes to encode); we rebuild and return the full GID. */
export function productGidFromParam(param: string | undefined) {
  if (!param || !/^[1-9]\d{0,19}$/.test(param))
    throw new ApiError(400, "invalid_product_id", "Product id must be the numeric Shopify product id");
  return `gid://shopify/Product/${param}`;
}

/** Opaque cursor so clients cannot depend on our internal ids. */
export function encodeCursor(id: number) {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown };
    if (typeof parsed.id === "number" && Number.isSafeInteger(parsed.id) && parsed.id > 0) return parsed.id;
  } catch {
    // fall through to the 400 below
  }
  throw new ApiError(400, "invalid_cursor", "Cursor is not valid");
}

export async function readJsonBody(request: Request, opts: { allowEmpty?: boolean } = {}): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
    throw new ApiError(413, "payload_too_large", `Body must be at most ${MAX_BODY_BYTES} bytes`);
  if (!text.trim()) {
    if (opts.allowEmpty) return {};
    throw new ApiError(400, "invalid_json", "A JSON body is required");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON");
  }
}

type ProductRow = {
  shopifyProductGid: string;
  title: string;
  handle: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  updatedAtShopify: Date;
  syncedAt: Date;
  enrichment: EnrichmentRow | null;
  variants?: Array<{ shopifyVariantGid: string; title: string; sku: string | null; price: { toString(): string } }>;
};
type EnrichmentRow = {
  badgeText: string;
  badgeColor: string;
  internalNote: string | null;
  active: boolean;
  updatedAt: Date;
};

/** internalNote is returned here because the key belongs to the merchant. Never reuse for the storefront. */
export function serializeEnrichment(e: EnrichmentRow) {
  return {
    badgeText: e.badgeText,
    badgeColor: e.badgeColor,
    active: e.active,
    internalNote: e.internalNote,
    updatedAt: e.updatedAt.toISOString(),
  };
}

export function serializeProduct(p: ProductRow) {
  return {
    id: p.shopifyProductGid,
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: p.vendor,
    productType: p.productType,
    updatedAtShopify: p.updatedAtShopify.toISOString(),
    syncedAt: p.syncedAt.toISOString(),
    enrichment: p.enrichment ? serializeEnrichment(p.enrichment) : null,
    ...(p.variants
      ? { variants: p.variants.map((v) => ({ id: v.shopifyVariantGid, title: v.title, sku: v.sku, price: v.price.toString() })) }
      : {}),
  };
}
