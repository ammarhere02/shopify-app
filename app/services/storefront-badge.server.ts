import db from "../db.server";
import { readableTextColor } from "../lib/badge-contrast";
import { createRateLimiter } from "../lib/rate-limit.server";
import { getPublicBadge, getPublicBadges } from "../repositories/enrichment.server";
import { normalizeShopDomain } from "./shop.server";

/** Browsers and Shopify's edge may reuse an answer this long; a badge edit shows within it. */
export const STOREFRONT_CACHE_SECONDS = 60;
const HEX = /^#[0-9A-F]{6}$/;
const PRODUCT_ID = /^[1-9]\d{0,19}$/;
/** Most product ids one batch request may carry. The block's script sends larger pages in chunks. */
export const STOREFRONT_BATCH_MAX = 50;

// Per shop + shopper IP. In memory, single process (same documented limit as the developer API).
const limiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
export const resetStorefrontRateLimitForTests = () => limiter.reset();

export type PublicBadge = { text: string; color: string; textColor: string };
export type StorefrontBadgeResult =
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "ok"; badge: PublicBadge | null; shopId: number | null };

/**
 * `shopDomain` MUST come from a request already verified by authenticate.public.appProxy.
 * Unknown shop, uninstalled shop, bad id, unknown/draft/deleted product and inactive badge all
 * give the same `badge: null`, so the endpoint reveals nothing about what exists.
 */
export async function getStorefrontBadge(
  shopDomain: string | null,
  productIdParam: string | undefined,
  clientIp: string,
): Promise<StorefrontBadgeResult> {
  const shop = shopDomain
    ? await db.shop.findUnique({ where: { shopDomain: normalizeShopDomain(shopDomain) } })
    : null;
  if (!shop || shop.uninstalledAt) return { kind: "ok", badge: null, shopId: null };

  const hit = limiter.hit(`${shop.id}:${clientIp}`);
  if (!hit.allowed) return { kind: "rate_limited", retryAfterSec: hit.retryAfterSec };

  if (!productIdParam || !PRODUCT_ID.test(productIdParam))
    return { kind: "ok", badge: null, shopId: shop.id };

  const row = await getPublicBadge(shop.id, `gid://shopify/Product/${productIdParam}`);
  // Validated on write already; re-checked because this value ends up in a CSS property.
  if (!row || !HEX.test(row.badgeColor)) return { kind: "ok", badge: null, shopId: shop.id };
  return {
    kind: "ok",
    shopId: shop.id,
    badge: toPublicBadge(row),
  };
}

const toPublicBadge = (row: { badgeText: string; badgeColor: string }): PublicBadge => ({
  text: row.badgeText,
  color: row.badgeColor,
  textColor: readableTextColor(row.badgeColor),
});

export type StorefrontBadgesResult =
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "invalid" }
  | { kind: "ok"; badges: Record<string, PublicBadge>; shopId: number | null; requested: number };

/**
 * Batch form for product grids: `idsParam` is "123,456,...". One request costs one rate-limit hit
 * and one query, however many cards are on the page. The answer is a map keyed by Shopify product
 * id that holds ONLY the products with a badge to show; every other id (unknown, another shop's,
 * draft, deleted, inactive) is absent in exactly the same way.
 * Same trust rule as above: `shopDomain` MUST come from a verified app proxy request.
 */
export async function getStorefrontBadges(
  shopDomain: string | null,
  idsParam: string | null,
  clientIp: string,
): Promise<StorefrontBadgesResult> {
  // Shape is checked before any lookup: a malformed or oversized list is a client bug, not "no badge".
  const ids = idsParam ? idsParam.split(",") : [];
  if (ids.length === 0 || ids.length > STOREFRONT_BATCH_MAX || !ids.every((id) => PRODUCT_ID.test(id)))
    return { kind: "invalid" };
  const unique = [...new Set(ids)];

  const shop = shopDomain
    ? await db.shop.findUnique({ where: { shopDomain: normalizeShopDomain(shopDomain) } })
    : null;
  if (!shop || shop.uninstalledAt) return { kind: "ok", badges: {}, shopId: null, requested: unique.length };

  const hit = limiter.hit(`${shop.id}:${clientIp}`);
  if (!hit.allowed) return { kind: "rate_limited", retryAfterSec: hit.retryAfterSec };

  const rows = await getPublicBadges(shop.id, unique.map((id) => `gid://shopify/Product/${id}`));
  const badges: Record<string, PublicBadge> = {};
  for (const row of rows) {
    if (!HEX.test(row.badgeColor)) continue;
    badges[row.shopifyProductGid.slice("gid://shopify/Product/".length)] = toPublicBadge(row);
  }
  return { kind: "ok", badges, shopId: shop.id, requested: unique.length };
}
