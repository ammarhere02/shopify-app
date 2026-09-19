import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shop } from "@prisma/client";

// vi.hoisted runs before the imports below, and shopify.server.ts reads these at import time.
const SECRET = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-proxy-secret";
  process.env.SHOPIFY_APP_URL = "https://app.example.test";
  process.env.SCOPES = "read_products";
  return process.env.SHOPIFY_API_SECRET;
});
const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("../app/lib/logger.server", () => {
  const record = (...args: unknown[]) => void logged.push(args);
  return { logger: { info: record, warn: record, error: record } };
});

import db from "../app/db.server";
import { saveEnrichment } from "../app/repositories/enrichment.server";
import { loader as batchLoader } from "../app/routes/proxy.badges";
import { loader } from "../app/routes/proxy.products.$id";
import { resetStorefrontRateLimitForTests, STOREFRONT_BATCH_MAX } from "../app/services/storefront-badge.server";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error("Run through npm run test:integration with a dedicated test database");
}

const shops: number[] = [];
let shopA: Shop;
let shopB: Shop;
let nextId = Math.floor(Date.now() / 10) + 1_300_000;
const NOTE = "PRIVATE margin 40 percent";
const badge = { badgeText: "Staff Pick", badgeColor: "#FFFF00", internalNote: NOTE, active: true };

const makeShop = async () => {
  const shop = await db.shop.create({ data: { shopDomain: `storefront-${randomUUID()}.myshopify.com` } });
  shops.push(shop.id);
  return shop;
};
const makeProduct = async (shop: Shop, withBadge: typeof badge | null, status = "ACTIVE") => {
  const id = ++nextId;
  const row = await db.product.create({
    data: {
      shopId: shop.id,
      shopifyProductGid: `gid://shopify/Product/${id}`,
      title: "Red Shirt",
      handle: `h-${id}`,
      status,
      updatedAtShopify: new Date(),
      syncedAt: new Date(),
    },
  });
  if (withBadge) await saveEnrichment(shop.id, row.id, withBadge);
  return { id, rowId: row.id };
};
/** Builds the request exactly as Shopify's app proxy signs it: sorted key=value pairs, HMAC-SHA256 hex. */
const proxied = (shopDomain: string, productId: number | string, opts: { tamper?: boolean; ip?: string } = {}) => {
  const query: Record<string, string> = {
    shop: shopDomain,
    path_prefix: "/apps/product-badge",
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: "",
  };
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("");
  const signature = createHmac("sha256", SECRET).update(message).digest("hex");
  if (opts.tamper) query.shop = shopB.shopDomain; // change a signed value after signing
  const qs = new URLSearchParams({ ...query, signature });
  const request = new Request(`https://app.example.test/proxy/products/${productId}?${qs}`, {
    headers: { "x-forwarded-for": opts.ip ?? "203.0.113.7" },
  });
  return loader({ request, params: { id: String(productId) }, context: {} } as never).catch((thrown) => {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  });
};

/** Same signing for the batch endpoint; `ids` is part of the signed query, as it is through Shopify. */
const proxiedBatch = (shopDomain: string, ids: string, opts: { tamper?: boolean; ip?: string } = {}) => {
  const query: Record<string, string> = {
    shop: shopDomain,
    path_prefix: "/apps/product-badge",
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: "",
    ids,
  };
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("");
  const signature = createHmac("sha256", SECRET).update(message).digest("hex");
  if (opts.tamper) query.shop = shopB.shopDomain;
  const qs = new URLSearchParams({ ...query, signature });
  const request = new Request(`https://app.example.test/proxy/badges?${qs}`, {
    headers: { "x-forwarded-for": opts.ip ?? "203.0.113.7" },
  });
  return batchLoader({ request, params: {}, context: {} } as never).catch((thrown) => {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  });
};

beforeEach(async () => {
  logged.length = 0;
  resetStorefrontRateLimitForTests();
  shopA = await makeShop();
  shopB = await makeShop();
});
afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("storefront badge endpoint (real app proxy signature check)", () => {
  it("active badge: public fields only, readable text color, short public cache", async () => {
    const { id } = await makeProduct(shopA, badge);
    const res = await proxied(shopA.shopDomain, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ badge: { text: "Staff Pick", color: "#FFFF00", textColor: "#000000" } });
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("internalNote");
    expect(JSON.stringify(logged)).not.toContain("PRIVATE");
  });

  it("every 'nothing to show' case returns the identical empty body", async () => {
    const inactive = await makeProduct(shopA, { ...badge, active: false });
    const none = await makeProduct(shopA, null);
    const draft = await makeProduct(shopA, badge, "DRAFT");
    const deleted = await makeProduct(shopA, badge);
    await db.product.update({ where: { id: deleted.rowId }, data: { deletedAt: new Date() } });
    const foreign = await makeProduct(shopB, badge);
    const uninstalled = await makeShop();
    const orphan = await makeProduct(uninstalled, badge);
    await db.shop.update({ where: { id: uninstalled.id }, data: { uninstalledAt: new Date() } });

    const responses = [
      await proxied(shopA.shopDomain, inactive.id),
      await proxied(shopA.shopDomain, none.id),
      await proxied(shopA.shopDomain, draft.id),
      await proxied(shopA.shopDomain, deleted.id),
      await proxied(shopA.shopDomain, foreign.id), // shop B's product asked through shop A's storefront
      await proxied(shopA.shopDomain, 999_999_999),
      await proxied(shopA.shopDomain, "abc"),
      await proxied(uninstalled.shopDomain, orphan.id),
      await proxied(`ghost-${randomUUID()}.myshopify.com`, none.id),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"badge":null}');
    }
  });

  it("a request not signed by Shopify, or altered after signing, is rejected before any lookup", async () => {
    const { id } = await makeProduct(shopB, badge);
    const tampered = await proxied(shopA.shopDomain, id, { tamper: true }); // tries to switch tenant to shop B
    expect(tampered.status).toBe(400);
    expect(await tampered.text()).not.toContain("Staff Pick");

    const unsigned = await loader({
      request: new Request(`https://app.example.test/proxy/products/${id}?shop=${shopB.shopDomain}`),
      params: { id: String(id) },
      context: {},
    } as never).catch((thrown) => thrown as Response);
    expect(unsigned.status).toBe(400);
  });

  it("rate limits per shop + IP with Retry-After, without caching the 429", async () => {
    const { id } = await makeProduct(shopA, badge);
    let last = await proxied(shopA.shopDomain, id, { ip: "198.51.100.20" });
    for (let i = 0; i < 120; i++) last = await proxied(shopA.shopDomain, id, { ip: "198.51.100.20" });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(last.headers.get("Cache-Control")).toBe("no-store");
    expect((await proxied(shopA.shopDomain, id, { ip: "198.51.100.21" })).status).toBe(200);
  });
});

describe("storefront batch badge endpoint (product cards)", () => {
  it("several products of one shop: a map keyed by Shopify product id, public fields only", async () => {
    const first = await makeProduct(shopA, badge);
    const second = await makeProduct(shopA, { ...badge, badgeText: "New", badgeColor: "#000080" });
    const plain = await makeProduct(shopA, null);
    // a repeated id is fine and counts once
    const res = await proxiedBatch(shopA.shopDomain, [first.id, second.id, plain.id, first.id].join(","));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      badges: {
        [first.id]: { text: "Staff Pick", color: "#FFFF00", textColor: "#000000" },
        [second.id]: { text: "New", color: "#000080", textColor: "#FFFFFF" },
      },
    });
    // toEqual above already proves there are no extra fields (no local ids, no shop id).
    for (const secret of ["PRIVATE", "internalNote"]) expect(text).not.toContain(secret);
    expect(JSON.stringify(logged)).not.toContain("PRIVATE");
  });

  it("inactive, no badge, draft, deleted, another shop's and unknown products are all simply absent", async () => {
    const shown = await makeProduct(shopA, badge);
    const inactive = await makeProduct(shopA, { ...badge, active: false });
    const none = await makeProduct(shopA, null);
    const draft = await makeProduct(shopA, badge, "DRAFT");
    const deleted = await makeProduct(shopA, badge);
    await db.product.update({ where: { id: deleted.rowId }, data: { deletedAt: new Date() } });
    const foreign = await makeProduct(shopB, badge);
    const ids = [shown, inactive, none, draft, deleted, foreign].map((p) => p.id).concat(999_999_999).join(",");

    const body = await (await proxiedBatch(shopA.shopDomain, ids)).json();
    expect(Object.keys(body.badges)).toEqual([String(shown.id)]);
    // shop B's storefront sees only its own product from the same list
    const other = await (await proxiedBatch(shopB.shopDomain, ids)).json();
    expect(Object.keys(other.badges)).toEqual([String(foreign.id)]);
  });

  it("uninstalled and unknown shops get the same empty map", async () => {
    const uninstalled = await makeShop();
    const orphan = await makeProduct(uninstalled, badge);
    await db.shop.update({ where: { id: uninstalled.id }, data: { uninstalledAt: new Date() } });
    for (const domain of [uninstalled.shopDomain, `ghost-${randomUUID()}.myshopify.com`]) {
      const res = await proxiedBatch(domain, String(orphan.id));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"badges":{}}');
    }
  });

  it("malformed or oversized id lists are rejected with 400 and never cached", async () => {
    const { id } = await makeProduct(shopA, badge);
    const tooMany = Array.from({ length: STOREFRONT_BATCH_MAX + 1 }, (_, i) => i + 1).join(",");
    for (const ids of ["", "abc", `${id},abc`, `${id},`, `${id},-1`, `${id},0`, `${id} OR 1=1`, "1".repeat(21), tooMany]) {
      const res = await proxiedBatch(shopA.shopDomain, ids);
      expect(res.status, ids).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toBe('{"badges":{}}');
    }
    const atLimit = Array.from({ length: STOREFRONT_BATCH_MAX - 1 }, (_, i) => i + 1).concat(id).join(",");
    expect((await proxiedBatch(shopA.shopDomain, atLimit)).status).toBe(200);
  });

  it("a request not signed by Shopify, or altered after signing, is rejected before any lookup", async () => {
    const { id } = await makeProduct(shopB, badge);
    const tampered = await proxiedBatch(shopA.shopDomain, String(id), { tamper: true });
    expect(tampered.status).toBe(400);
    expect(await tampered.text()).not.toContain("Staff Pick");

    const unsigned = await batchLoader({
      request: new Request(`https://app.example.test/proxy/badges?shop=${shopB.shopDomain}&ids=${id}`),
      params: {},
      context: {},
    } as never).catch((thrown) => thrown as Response);
    expect(unsigned.status).toBe(400);
  });

  it("shares the per shop + IP limit with the single endpoint: one hit per request, not per id", async () => {
    const { id } = await makeProduct(shopA, badge);
    const ip = "198.51.100.30";
    for (let i = 0; i < 119; i++) await proxiedBatch(shopA.shopDomain, `${id},${id + 1},${id + 2}`, { ip });
    expect((await proxied(shopA.shopDomain, id, { ip })).status).toBe(200); // request 120, single endpoint
    const limited = await proxiedBatch(shopA.shopDomain, String(id), { ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(await limited.text()).toBe('{"badges":{}}');
  });
});
