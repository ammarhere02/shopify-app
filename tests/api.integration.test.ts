import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shop } from "@prisma/client";

const { logged, adminMock } = vi.hoisted(() => ({ logged: [] as unknown[][], adminMock: vi.fn() }));
vi.mock("../app/lib/logger.server", () => {
  const record = (...args: unknown[]) => void logged.push(args);
  return { logger: { info: record, warn: record, error: record } };
});
// Only the sync route touches Shopify; everything else in these tests is real.
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: adminMock } }));

import db from "../app/db.server";
import { revokeApiKeys } from "../app/repositories/api-key.server";
import { createApiKey } from "../app/services/api-key.server";
import { resetRateLimitsForTests } from "../app/services/api.server";
import * as productsRoute from "../app/routes/api.v1.products._index";
import * as productRoute from "../app/routes/api.v1.products.$id";
import * as enrichmentRoute from "../app/routes/api.v1.products.$id.enrichment";
import * as syncsRoute from "../app/routes/api.v1.syncs._index";
import * as syncRoute from "../app/routes/api.v1.syncs.$id";
import { product as node } from "./fixtures";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error("Run through npm run test:integration with a dedicated test database");
}

const shops: number[] = [];
let shopA: Shop;
let shopB: Shop;
let keyA: string;
let keyB: string;
let nextId = Math.floor(Date.now() / 10) + 900_000;
const badge = { badgeText: "Staff Pick", badgeColor: "#1a7f37", internalNote: "margin 40%", active: true };

const makeShop = async () => {
  const shop = await db.shop.create({ data: { shopDomain: `phase5-${randomUUID()}.myshopify.com` } });
  shops.push(shop.id);
  return shop;
};
const makeProduct = async (shop: Shop, title = "Red Shirt", status = "ACTIVE") => {
  const id = ++nextId;
  await db.product.create({
    data: {
      shopId: shop.id,
      shopifyProductGid: `gid://shopify/Product/${id}`,
      title,
      handle: `h-${id}`,
      status,
      updatedAtShopify: new Date(),
      syncedAt: new Date(),
      variants: { create: { shopifyVariantGid: `gid://shopify/ProductVariant/${id}`, title: "Default", price: "19.99", syncedAt: new Date() } },
    },
  });
  return id;
};
type Handler = (args: never) => Promise<Response> | Response;
const call = (
  handler: Handler,
  method: string,
  path: string,
  opts: { key?: string | null; body?: unknown; params?: Record<string, string>; raw?: string; ip?: string } = {},
) => {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.1" };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? keyA}`;
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const request = new Request(`https://app.example.test${path}`, { method, headers, body });
  return handler({ request, params: opts.params ?? {}, context: {} } as never);
};
const put = (id: number | string, body: unknown, key?: string) =>
  call(enrichmentRoute.action, "PUT", `/api/v1/products/${id}/enrichment`, { key, body, params: { id: String(id) } });

beforeEach(async () => {
  logged.length = 0;
  adminMock.mockReset();
  resetRateLimitsForTests();
  shopA = await makeShop();
  shopB = await makeShop();
  keyA = (await createApiKey(shopA.id, "test A")).plaintext;
  keyB = (await createApiKey(shopB.id, "test B")).plaintext;
});
afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("authentication", () => {
  it("every kind of bad credential gets the same 401 body, with the reason only in logs", async () => {
    const revoked = await createApiKey(shopA.id, "to revoke");
    await revokeApiKeys(shopA.id, revoked.keyPrefix);
    const inactiveShop = await makeShop();
    const inactiveKey = (await createApiKey(inactiveShop.id, "inactive")).plaintext;
    await db.shop.update({ where: { id: inactiveShop.id }, data: { uninstalledAt: new Date() } });

    const responses = [
      await call(productsRoute.loader, "GET", "/api/v1/products", { key: null }),
      await call(productsRoute.loader, "GET", "/api/v1/products", { key: "nonsense" }),
      await call(productsRoute.loader, "GET", "/api/v1/products", { key: `eh_live_${"A".repeat(43)}` }),
      await call(productsRoute.loader, "GET", "/api/v1/products", { key: revoked.plaintext }),
      await call(productsRoute.loader, "GET", "/api/v1/products", { key: inactiveKey }),
    ];
    const bodies = [];
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
      const body = await res.json();
      expect(body.error.requestId).toBe(res.headers.get("X-Request-Id"));
      delete body.error.requestId;
      bodies.push(JSON.stringify(body));
    }
    expect(new Set(bodies).size).toBe(1);
    const reasons = logged.map((l) => (l[1] as { authFailure?: string }).authFailure);
    expect(reasons).toEqual(["missing", "malformed", "unknown", "revoked", "shop_inactive"]);
  });

  it("stores only the hash, never logs the key, and throttles lastUsedAt writes", async () => {
    const rows = await db.developerApiKey.findMany({ where: { shopId: shopA.id } });
    expect(JSON.stringify(rows)).not.toContain(keyA);
    expect(rows[0].lastUsedAt).toBeNull();

    await call(productsRoute.loader, "GET", "/api/v1/products");
    const first = (await db.developerApiKey.findUniqueOrThrow({ where: { id: rows[0].id } })).lastUsedAt;
    expect(first).not.toBeNull();
    await call(productsRoute.loader, "GET", "/api/v1/products");
    const second = (await db.developerApiKey.findUniqueOrThrow({ where: { id: rows[0].id } })).lastUsedAt;
    expect(second).toEqual(first);
    expect(JSON.stringify(logged)).not.toContain(keyA);
  });

  it("repeated failed logins from one IP are blocked, other IPs are not", async () => {
    for (let i = 0; i < 20; i++) await call(productsRoute.loader, "GET", "/api/v1/products", { key: "bad", ip: "198.51.100.9" });
    const blocked = await call(productsRoute.loader, "GET", "/api/v1/products", { ip: "198.51.100.9" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await call(productsRoute.loader, "GET", "/api/v1/products")).status).toBe(200);
  });

  it("per-key rate limit returns 429 with Retry-After", async () => {
    let last = await call(productsRoute.loader, "GET", "/api/v1/products");
    for (let i = 0; i < 60; i++) last = await call(productsRoute.loader, "GET", "/api/v1/products");
    expect(last.status).toBe(429);
    expect((await last.json()).error.code).toBe("rate_limited");
    expect((await call(productsRoute.loader, "GET", "/api/v1/products", { key: keyB })).status).toBe(200);
  });

  it("unsupported method is a 405 envelope", async () => {
    const res = await call(productsRoute.action, "POST", "/api/v1/products", { body: {} });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

describe("products", () => {
  it("lists only the key's shop, exposes GIDs not local ids, filters and paginates", async () => {
    const red = await makeProduct(shopA, "Red Shirt");
    await makeProduct(shopA, "Blue Shirt", "DRAFT");
    await makeProduct(shopA, "Green Shirt");
    await makeProduct(shopB, "Red Shirt");
    await put(red, badge);

    const all = await (await call(productsRoute.loader, "GET", "/api/v1/products")).json();
    expect(all.data).toHaveLength(3);
    expect(all.data[0].id).toMatch(/^gid:\/\/shopify\/Product\/\d+$/);
    expect(all.data[0]).not.toHaveProperty("shopId");

    const titles = async (qs: string) =>
      (await (await call(productsRoute.loader, "GET", `/api/v1/products?${qs}`)).json()).data.map((p: { title: string }) => p.title);
    expect(await titles("query=red")).toEqual(["Red Shirt"]);
    expect(await titles("status=DRAFT")).toEqual(["Blue Shirt"]);
    expect(await titles("hasBadge=true")).toEqual(["Red Shirt"]);

    const page1 = await (await call(productsRoute.loader, "GET", "/api/v1/products?limit=2")).json();
    expect(page1.pageInfo.hasNextPage).toBe(true);
    const page2 = await (await call(productsRoute.loader, "GET", `/api/v1/products?limit=2&cursor=${page1.pageInfo.nextCursor}`)).json();
    expect([...page1.data, ...page2.data].map((p: { title: string }) => p.title)).toEqual(["Red Shirt", "Blue Shirt", "Green Shirt"]);
    expect(page2.pageInfo).toEqual({ hasNextPage: false, nextCursor: null });
  });

  it.each(["status=LIVE", "hasBadge=yes", "limit=0", "limit=101", "limit=abc", "cursor=garbage"])("rejects %s with 400", async (qs) => {
    const res = await call(productsRoute.loader, "GET", `/api/v1/products?${qs}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: expect.any(String), message: expect.any(String), requestId: expect.any(String) });
  });

  it("detail returns variants and enrichment; other shops, deleted and bad ids are 404/400", async () => {
    const id = await makeProduct(shopA);
    await put(id, badge);
    const res = await call(productRoute.loader, "GET", `/api/v1/products/${id}`, { params: { id: String(id) } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.variants).toEqual([{ id: `gid://shopify/ProductVariant/${id}`, title: "Default", sku: null, price: "19.99" }]);
    expect(data.enrichment).toMatchObject({ badgeText: "Staff Pick", badgeColor: "#1A7F37", internalNote: "margin 40%" });

    expect((await call(productRoute.loader, "GET", `/api/v1/products/${id}`, { key: keyB, params: { id: String(id) } })).status).toBe(404);
    expect((await call(productRoute.loader, "GET", "/api/v1/products/abc", { params: { id: "abc" } })).status).toBe(400);
    await db.product.updateMany({ where: { shopId: shopA.id }, data: { deletedAt: new Date() } });
    expect((await call(productRoute.loader, "GET", `/api/v1/products/${id}`, { params: { id: String(id) } })).status).toBe(404);
  });
});

describe("enrichment writes", () => {
  it("PUT creates (201) then updates (200) the single enrichment", async () => {
    const id = await makeProduct(shopA);
    expect((await put(id, badge)).status).toBe(201);
    const second = await put(id, { ...badge, badgeText: "New" });
    expect(second.status).toBe(200);
    expect((await second.json()).data.badgeText).toBe("New");
    expect(await db.productEnrichment.count({ where: { product: { shopId: shopA.id } } })).toBe(1);
  });

  it("invalid payload is 422 with field details; malformed or oversized JSON is 400/413; nothing is written", async () => {
    const id = await makeProduct(shopA);
    const invalid = await put(id, { badgeText: "", badgeColor: "red", active: "yes" });
    expect(invalid.status).toBe(422);
    expect(Object.keys((await invalid.json()).error.details).sort()).toEqual(["active", "badgeColor", "badgeText"]);

    const path = `/api/v1/products/${id}/enrichment`;
    const params = { id: String(id) };
    expect((await call(enrichmentRoute.action, "PUT", path, { raw: "{not json", params })).status).toBe(400);
    expect((await call(enrichmentRoute.action, "PUT", path, { raw: "", params })).status).toBe(400);
    expect((await call(enrichmentRoute.action, "PUT", path, { raw: JSON.stringify({ ...badge, internalNote: "x".repeat(11_000) }), params })).status).toBe(413);
    expect(await db.productEnrichment.count({ where: { product: { shopId: shopA.id } } })).toBe(0);
  });

  it("tenant isolation: shop B's key cannot write or delete shop A's enrichment; missing product is 404", async () => {
    const id = await makeProduct(shopA);
    await put(id, badge);
    expect((await put(id, { ...badge, badgeText: "Hacked" }, keyB)).status).toBe(404);
    expect((await call(enrichmentRoute.action, "DELETE", `/api/v1/products/${id}/enrichment`, { key: keyB, params: { id: String(id) } })).status).toBe(404);
    expect((await db.productEnrichment.findFirstOrThrow({ where: { product: { shopId: shopA.id } } })).badgeText).toBe("Staff Pick");
    expect((await put(999_999_999_999, badge)).status).toBe(404);
  });

  it("DELETE is 204 and idempotent", async () => {
    const id = await makeProduct(shopA);
    await put(id, badge);
    const del = () => call(enrichmentRoute.action, "DELETE", `/api/v1/products/${id}/enrichment`, { params: { id: String(id) } });
    const first = await del();
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect((await del()).status).toBe(204);
    expect(await db.productEnrichment.count({ where: { product: { shopId: shopA.id } } })).toBe(0);
  });
});

describe("syncs", () => {
  const shopifyReturning = (products: unknown[]) =>
    adminMock.mockResolvedValue({
      admin: {
        graphql: vi.fn(async (query: string) =>
          new Response(
            JSON.stringify({
              data: query.includes("ShopIdentity")
                ? { shop: { id: "gid://shopify/Shop/1", name: "Test", myshopifyDomain: shopA.shopDomain } }
                : { products: { nodes: products, pageInfo: { hasNextPage: false, endCursor: null } } },
            }),
          ),
        ),
      },
    });
  const status = (id: number, key?: string) =>
    call(syncRoute.loader, "GET", `/api/v1/syncs/${id}`, { key, params: { id: String(id) } });

  it("POST returns 202 + Location at once; the run finishes in the background and is readable", async () => {
    shopifyReturning([node(++nextId, 2)]);
    const res = await call(syncsRoute.action, "POST", "/api/v1/syncs", { body: { type: "RECONCILE" } });
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(res.headers.get("Location")).toBe(`/api/v1/syncs/${data.id}`);
    expect(data).toMatchObject({ type: "RECONCILE", status: "RUNNING" });
    expect(adminMock).toHaveBeenCalledWith(shopA.shopDomain); // tenant from the key, not the request

    await vi.waitFor(async () => {
      const body = await (await status(data.id)).json();
      expect(body.data.status).toBe("SUCCEEDED");
      expect(body.data.counts).toMatchObject({ fetched: 1, inserted: 1 });
      expect(body.data).not.toHaveProperty("cursor");
    }, { timeout: 10_000, interval: 100 });

    expect((await status(data.id, keyB)).status).toBe(404); // another shop's run id
    expect((await status(0)).status).toBe(400);
  });

  it("a second start while one is running is 409", async () => {
    await db.syncRun.create({ data: { shopId: shopA.id } });
    shopifyReturning([]);
    const res = await call(syncsRoute.action, "POST", "/api/v1/syncs");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("sync_in_progress");
  });

  it("no Shopify session: 409 and NO run is created", async () => {
    adminMock.mockRejectedValue(new Error("Could not find a session"));
    const res = await call(syncsRoute.action, "POST", "/api/v1/syncs");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("shop_session_unavailable");
    expect(await db.syncRun.count({ where: { shopId: shopA.id } })).toBe(0);
  });

  it("bad type is 400; sync starts have their own lower rate limit", async () => {
    expect((await call(syncsRoute.action, "POST", "/api/v1/syncs", { body: { type: "PARTIAL" } })).status).toBe(400);
    adminMock.mockRejectedValue(new Error("no session"));
    let last = await call(syncsRoute.action, "POST", "/api/v1/syncs");
    for (let i = 0; i < 5; i++) last = await call(syncsRoute.action, "POST", "/api/v1/syncs");
    expect(last.status).toBe(429);
    expect((await call(productsRoute.loader, "GET", "/api/v1/products")).status).toBe(200);
  });
});
