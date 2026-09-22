import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shop } from "@prisma/client";

// vi.hoisted runs before the imports below, and shopify.server.ts reads these at import time.
const SECRET = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-webhook-secret";
  process.env.SHOPIFY_APP_URL = "https://app.example.test";
  process.env.SCOPES = "read_products";
  return process.env.SHOPIFY_API_SECRET;
});
// The Shopify node adapter captures globalThis.fetch when it is imported, so the stub must be in
// place first. It forwards everything unless a test installs a handler for the shop's GraphQL URL.
const shopifyFetch = vi.hoisted(() => {
  const real = globalThis.fetch;
  const state: { handler: ((url: string) => Response | null) | null } = { handler: null };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return state.handler?.(url) ?? real(input, init);
  }) as typeof fetch;
  return state;
});

const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("../app/lib/logger.server", () => {
  const record = (...args: unknown[]) => void logged.push(args);
  return { logger: { info: record, warn: record, error: record } };
});

import db from "../app/db.server";
import {
  handleProductDelete,
  handleProductUpdate,
  type VerifiedWebhook,
} from "../app/services/webhook.server";
import { claimReceipt } from "../app/repositories/webhook-receipt.server";
import { saveEnrichment } from "../app/repositories/enrichment.server";
import { action as deleteRoute } from "../app/routes/webhooks.products.delete";
import { action as createRoute } from "../app/routes/webhooks.products.create";
import { action as uninstalledRoute } from "../app/routes/webhooks.app.uninstalled";
import { product as node } from "./fixtures";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error("Run through npm run test:integration with a dedicated test database");
}

const shops: number[] = [];
const receipts: string[] = [];
let shopA: Shop;
let shopB: Shop;
let nextId = Math.floor(Date.now() / 10) + 500_000;
const badge = { badgeText: "Staff Pick", badgeColor: "#1A7F37", internalNote: "secret note", active: true };

const makeShop = async () => {
  const shop = await db.shop.create({ data: { shopDomain: `webhook-${randomUUID()}.myshopify.com` } });
  shops.push(shop.id);
  return shop;
};
const webhookId = () => {
  const id = randomUUID();
  receipts.push(id);
  return id;
};
/** A fake `admin.graphql` that returns one product node (or null). */
const adminReturning = (product: unknown) => ({
  graphql: vi.fn(async () => new Response(JSON.stringify({ data: { product } }))),
});
const updateEvent = (shop: Shop, id: number, product: unknown, extra: Partial<VerifiedWebhook> = {}) =>
  ({
    shop: shop.shopDomain,
    topic: "PRODUCTS_UPDATE",
    webhookId: webhookId(),
    payload: { id, admin_graphql_api_id: `gid://shopify/Product/${id}`, title: "PAYLOAD TITLE MUST NOT BE USED" },
    admin: adminReturning(product),
    ...extra,
  }) as VerifiedWebhook;
const deleteEvent = (shop: Shop, id: number): VerifiedWebhook => ({
  shop: shop.shopDomain,
  topic: "PRODUCTS_DELETE",
  webhookId: webhookId(),
  payload: { id },
});
const receipt = (id: string) => db.webhookReceipt.findUniqueOrThrow({ where: { webhookId: id } });
const local = (shop: Shop, id: number) =>
  db.product.findUnique({
    where: { shopId_shopifyProductGid: { shopId: shop.id, shopifyProductGid: `gid://shopify/Product/${id}` } },
    include: { variants: true, enrichment: true },
  });

beforeEach(async () => {
  logged.length = 0;
  shopA = await makeShop();
  shopB = await makeShop();
});
afterAll(async () => {
  await db.webhookReceipt.deleteMany({ where: { webhookId: { in: receipts } } });
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("products/update", () => {
  it("creates an unknown product from the GraphQL re-fetch, not from the payload", async () => {
    const id = ++nextId;
    const event = updateEvent(shopA, id, node(id, 2));
    const res = await handleProductUpdate(event);
    expect(res.status).toBe(200);
    const row = await local(shopA, id);
    expect(row?.title).toBe("Red T-shirt");
    expect(row?.variants).toHaveLength(2);
    const saved = await receipt(event.webhookId);
    expect(saved).toMatchObject({ status: "PROCESSED", shopId: shopA.id, topic: "PRODUCTS_UPDATE", error: null });
    expect(saved.processedAt).not.toBeNull();
  });

  it("updates the same row, removes dropped variants and keeps the enrichment", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, node(id, 3)));
    const before = await local(shopA, id);
    await saveEnrichment(shopA.id, before!.id, badge);

    const newer = { ...node(id, 1), title: "Classic T-shirt", updatedAt: "2026-08-01T00:00:00Z" };
    await handleProductUpdate(updateEvent(shopA, id, newer));
    const after = await local(shopA, id);
    expect(after).toMatchObject({ id: before!.id, title: "Classic T-shirt" });
    expect(after?.variants).toHaveLength(1);
    expect(after?.enrichment).toMatchObject({ badgeText: "Staff Pick", internalNote: "secret note" });
  });

  it("a duplicate delivery has no second side effect and makes no second API call", async () => {
    const id = ++nextId;
    const event = updateEvent(shopA, id, node(id));
    await handleProductUpdate(event);
    const repeat = { ...event, admin: adminReturning({ ...node(id), title: "Should not apply" }) };
    const res = await handleProductUpdate(repeat);
    expect(res.status).toBe(200);
    expect(repeat.admin.graphql).not.toHaveBeenCalled();
    expect((await local(shopA, id))?.title).toBe("Red T-shirt");
    expect(await db.webhookReceipt.count({ where: { webhookId: event.webhookId } })).toBe(1);
  });

  it("skips a stale event without calling Shopify", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, { ...node(id), updatedAt: "2026-08-01T00:00:00Z" }));
    const stale = updateEvent(shopA, id, { ...node(id), title: "Old" });
    stale.payload.updated_at = "2026-07-01T00:00:00Z";
    expect((await handleProductUpdate(stale)).status).toBe(200);
    expect(stale.admin!.graphql).not.toHaveBeenCalled();
    expect((await receipt(stale.webhookId)).error).toBe("skipped: stale event");
  });

  it("in-transaction guard: an older fetched version cannot overwrite a newer local one", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, { ...node(id), title: "Newer", updatedAt: "2026-08-01T00:00:00Z" }));
    // No usable payload timestamp, so the cheap pre-check cannot catch it.
    const racing = updateEvent(shopA, id, { ...node(id), title: "Older", updatedAt: "2026-07-01T00:00:00Z" });
    expect((await handleProductUpdate(racing)).status).toBe(200);
    expect((await local(shopA, id))?.title).toBe("Newer");
    expect(await receipt(racing.webhookId)).toMatchObject({ status: "PROCESSED", error: "skipped: local copy is newer" });
  });

  it("product gone from Shopify: PROCESSED as skipped, nothing written", async () => {
    const id = ++nextId;
    const event = updateEvent(shopA, id, null);
    expect((await handleProductUpdate(event)).status).toBe(200);
    expect(await local(shopA, id)).toBeNull();
    expect((await receipt(event.webhookId)).error).toMatch(/no longer exists/);
  });

  it("failure -> FAILED + 500, then the retry with the SAME webhook id succeeds", async () => {
    const id = ++nextId;
    const event = updateEvent(shopA, id, node(id), { admin: undefined });
    expect((await handleProductUpdate(event)).status).toBe(500);
    const failed = await receipt(event.webhookId);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/No offline session/);

    const retry = { ...event, admin: adminReturning(node(id)) };
    expect((await handleProductUpdate(retry)).status).toBe(200);
    expect(await receipt(event.webhookId)).toMatchObject({ status: "PROCESSED", error: null });
    expect(await local(shopA, id)).not.toBeNull();
  });

  it("invalid product data from Shopify fails the receipt and writes no product", async () => {
    const id = ++nextId;
    const event = updateEvent(shopA, id, { ...node(id), updatedAt: "invalid" });
    expect((await handleProductUpdate(event)).status).toBe(500);
    expect(await local(shopA, id)).toBeNull();
    expect((await receipt(event.webhookId)).status).toBe("FAILED");
  });

  it("tenant isolation: shop B's event never touches shop A's product with the same GID", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, node(id)));
    await handleProductUpdate(updateEvent(shopB, id, { ...node(id), title: "B's product", updatedAt: "2026-08-01T00:00:00Z" }));
    expect((await local(shopA, id))?.title).toBe("Red T-shirt");
    expect((await local(shopB, id))?.title).toBe("B's product");
  });
});

describe("products/delete", () => {
  it("soft-deletes, keeps variants and enrichment, and is idempotent", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, node(id, 2)));
    await saveEnrichment(shopA.id, (await local(shopA, id))!.id, badge);

    const event = deleteEvent(shopA, id);
    expect((await handleProductDelete(event)).status).toBe(200);
    const row = await local(shopA, id);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.variants).toHaveLength(2);
    expect(row?.enrichment?.badgeText).toBe("Staff Pick");
    expect((await receipt(event.webhookId)).status).toBe("PROCESSED");

    const firstDeletedAt = row!.deletedAt;
    const second = deleteEvent(shopA, id); // a different delivery for an already-deleted product
    expect((await handleProductDelete(second)).status).toBe(200);
    expect((await local(shopA, id))?.deletedAt).toEqual(firstDeletedAt);
    expect((await receipt(second.webhookId)).error).toMatch(/no-op/);
  });

  it("does not delete another shop's product; unknown product is a 200 no-op", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, node(id)));
    expect((await handleProductDelete(deleteEvent(shopB, id))).status).toBe(200);
    expect((await local(shopA, id))?.deletedAt).toBeNull();
  });
});

describe("shop state and receipts", () => {
  it("uninstalled or unknown shop: 200, receipt kept, nothing processed", async () => {
    const id = ++nextId;
    await db.shop.update({ where: { id: shopA.id }, data: { uninstalledAt: new Date() } });
    const event = updateEvent(shopA, id, node(id));
    expect((await handleProductUpdate(event)).status).toBe(200);
    expect(event.admin!.graphql).not.toHaveBeenCalled();
    expect(await local(shopA, id)).toBeNull();
    expect(await receipt(event.webhookId)).toMatchObject({ status: "PROCESSED", error: "ignored: shop not active" });

    const ghost = deleteEvent({ shopDomain: `ghost-${randomUUID()}.myshopify.com` } as Shop, id);
    expect((await handleProductDelete(ghost)).status).toBe(200);
    expect(await receipt(ghost.webhookId)).toMatchObject({ shopId: null, error: "ignored: shop not active" });
  });

  it("only one of many concurrent claims for the same webhook id wins", async () => {
    const input = { webhookId: webhookId(), topic: "PRODUCTS_UPDATE", shopDomain: shopA.shopDomain, shopId: shopA.id };
    const first = await Promise.all(Array.from({ length: 5 }, () => claimReceipt(input)));
    expect(first.filter((r) => r === "claimed")).toHaveLength(1);

    await db.webhookReceipt.update({ where: { webhookId: input.webhookId }, data: { status: "FAILED" } });
    const retries = await Promise.all(Array.from({ length: 5 }, () => claimReceipt(input)));
    expect(retries.filter((r) => r === "claimed")).toHaveLength(1);
  });

  it("an abandoned RECEIVED is taken over, a fresh one is not", async () => {
    const input = { webhookId: webhookId(), topic: "PRODUCTS_UPDATE", shopDomain: shopA.shopDomain, shopId: shopA.id };
    expect(await claimReceipt(input)).toBe("claimed");
    expect(await claimReceipt(input)).toBe("duplicate");
    await db.webhookReceipt.update({
      where: { webhookId: input.webhookId },
      data: { receivedAt: new Date(Date.now() - 61_000) },
    });
    expect(await claimReceipt(input)).toBe("claimed");
  });

  it("logs event metadata only: no payload content, notes or secrets", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, node(id)));
    await handleProductUpdate(updateEvent(shopA, ++nextId, node(nextId), { admin: undefined }));
    const text = JSON.stringify(logged);
    expect(text).toContain("webhook.processed");
    expect(text).toContain("webhook.failed");
    expect(text).not.toContain("PAYLOAD TITLE");
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/hmac|accessToken/i);
  });
});

// These go through the real authenticate.webhook(): raw body + HMAC with the app secret.
describe("route + framework signature check", () => {
  const signed = (path: string, topic: string, shop: string, body: string, opts: { id?: string; hmac?: string } = {}) => {
    const id = opts.id ?? webhookId();
    return {
      id,
      request: new Request(`https://app.example.test${path}`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-Sha256": opts.hmac ?? createHmac("sha256", SECRET).update(body, "utf8").digest("base64"),
          "X-Shopify-Topic": topic,
          "X-Shopify-Shop-Domain": shop,
          "X-Shopify-Webhook-Id": id,
          "X-Shopify-API-Version": "2026-07",
        },
      }),
    };
  };
  /**
   * The real authenticate.webhook builds `admin` from the shop's stored offline session and
   * the library calls Shopify with the global fetch, so a route test that needs the re-fetch
   * gets a session row plus a fetch stub answering the GraphQL request with one product node.
   */
  const graphqlMockFor = (product: unknown) => {
    shopifyFetch.handler = (url) =>
      url.includes(".myshopify.com") && url.includes("graphql")
        ? new Response(JSON.stringify({ data: { product } }), { headers: { "content-type": "application/json" } })
        : null;
    return () => {
      shopifyFetch.handler = null;
    };
  };
  const withSession = (shop: Shop) =>
    db.session.upsert({
      where: { id: `offline_${shop.shopDomain}` },
      create: { id: `offline_${shop.shopDomain}`, shop: shop.shopDomain, state: "x", isOnline: false, accessToken: "shpat_test", scope: "read_products" },
      update: {},
    });

  const call = async (route: typeof deleteRoute, request: Request) => {
    try {
      return (await route({ request, params: {}, context: {} } as never)) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  };

  it("products/create: a signed delivery creates the local row from the re-fetch, receipt keeps the CREATE topic", async () => {
    const id = ++nextId;
    await withSession(shopA);
    const restore = graphqlMockFor(node(id, 2));
    try {
      const body = JSON.stringify({ id, admin_graphql_api_id: `gid://shopify/Product/${id}`, title: "PAYLOAD TITLE MUST NOT BE USED" });
      const first = signed("/webhooks/products/create", "products/create", shopA.shopDomain, body);
      expect((await call(createRoute, first.request)).status).toBe(200);
      const row = await local(shopA, id);
      expect(row?.title).toBe("Red T-shirt");
      expect(row?.variants).toHaveLength(2);
      expect(await receipt(first.id)).toMatchObject({ status: "PROCESSED", topic: "PRODUCTS_CREATE", shopId: shopA.id });
      // The same delivery again is a no-op; a forged signature is refused before any DB work.
      expect((await call(createRoute, signed("/webhooks/products/create", "products/create", shopA.shopDomain, body, { id: first.id }).request)).status).toBe(200);
      expect(await db.webhookReceipt.count({ where: { webhookId: first.id } })).toBe(1);
      expect((await call(createRoute, signed("/webhooks/products/create", "products/create", shopA.shopDomain, body, { hmac: "AAAA" }).request)).status).toBe(401);
    } finally {
      restore();
    }
  });

  it("valid signature: processed; same delivery again: no second effect", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, node(id)));
    const body = JSON.stringify({ id });
    const first = signed("/webhooks/products/delete", "products/delete", shopA.shopDomain, body);
    expect((await call(deleteRoute, first.request)).status).toBe(200);
    const deletedAt = (await local(shopA, id))?.deletedAt;
    expect(deletedAt).not.toBeNull();

    const again = signed("/webhooks/products/delete", "products/delete", shopA.shopDomain, body, { id: first.id });
    expect((await call(deleteRoute, again.request)).status).toBe(200);
    expect(await db.webhookReceipt.count({ where: { webhookId: first.id } })).toBe(1);
    expect((await local(shopA, id))?.deletedAt).toEqual(deletedAt);
  });

  it("invalid signature or tampered body: 401 and no database side effect", async () => {
    const id = ++nextId;
    await handleProductUpdate(updateEvent(shopA, id, node(id)));
    const body = JSON.stringify({ id });
    const goodHmac = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");

    const forged = signed("/webhooks/products/delete", "products/delete", shopA.shopDomain, body, { hmac: "AAAA" });
    expect((await call(deleteRoute, forged.request)).status).toBe(401);
    const tampered = signed("/webhooks/products/delete", "products/delete", shopA.shopDomain, JSON.stringify({ id, x: 1 }), { hmac: goodHmac });
    expect((await call(deleteRoute, tampered.request)).status).toBe(401);

    expect((await local(shopA, id))?.deletedAt).toBeNull();
    expect(await db.webhookReceipt.count({ where: { webhookId: { in: [forged.id, tampered.id] } } })).toBe(0);
  });

  it("app/uninstalled records a receipt and a repeat delivery stays harmless", async () => {
    const first = signed("/webhooks/app/uninstalled", "app/uninstalled", shopA.shopDomain, "{}");
    expect((await call(uninstalledRoute, first.request)).status).toBe(200);
    expect((await db.shop.findUniqueOrThrow({ where: { id: shopA.id } })).uninstalledAt).not.toBeNull();
    expect(await receipt(first.id)).toMatchObject({ status: "PROCESSED", topic: "APP_UNINSTALLED" });

    const second = signed("/webhooks/app/uninstalled", "app/uninstalled", shopA.shopDomain, "{}");
    expect((await call(uninstalledRoute, second.request)).status).toBe(200);
    expect((await receipt(second.id)).status).toBe("PROCESSED");
  });
});
