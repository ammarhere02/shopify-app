import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shop } from "@prisma/client";
import db from "../app/db.server";
import {
  runProductSync,
  startSyncRun,
  SyncConflictError,
} from "../app/services/sync.server";
import type { ShopifyClient } from "../app/shopify/graphql-client.server";
import type { ShopifyProductNode } from "../app/services/product-mapping";
import { product } from "./fixtures";

// Shopify is mocked; every repository call and transaction uses real MySQL.
vi.mock("../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error(
    "Run through npm run test:integration with a dedicated test database",
  );
}
const shops: number[] = [];
let shop: Shop;
let nextId = Math.floor(Date.now() / 10);
const makeProduct = (variants = 1) => product(++nextId, variants);
const page = (
  nodes: ShopifyProductNode[],
  endCursor: string | null = null,
  hasNextPage = false,
) => ({ products: { nodes, pageInfo: { hasNextPage, endCursor } } });
const api = (pages: unknown[], variantPages: unknown[] = []) => {
  let index = 0;
  let variantIndex = 0;
  return {
    query: vi.fn(async (operation: string) => {
      if (operation === "ShopIdentity")
        return { shop: { id: "gid://shopify/Shop/1", name: "Test Shop" } };
      const result =
        operation === "ProductVariantsPage"
          ? variantPages[variantIndex++]
          : pages[index++];
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error("Unexpected extra API request");
      return result;
    }),
  } as unknown as ShopifyClient;
};
const sync = async (client: ShopifyClient) =>
  runProductSync(client, shop.id, await startSyncRun(shop.id, "FULL"));
const rows = () =>
  db.product.findMany({
    where: { shopId: shop.id },
    include: { variants: true, enrichment: true },
  });

beforeEach(async () => {
  shop = await db.shop.create({
    data: { shopDomain: `sync-${randomUUID()}.myshopify.com` },
  });
  shops.push(shop.id);
});
afterAll(async () => {
  // Only delete fixtures created by this test process; never reset a database.
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("sync with real MySQL", () => {
  it("imports 60 products across pages, updates titles on repeat, preserves enrichments and isolates shops", async () => {
    const nodes = Array.from({ length: 60 }, () => makeProduct());
    const client = api([
      page(nodes.slice(0, 25), "p1", true),
      page(nodes.slice(25, 50), "p2", true),
      page(nodes.slice(50)),
    ]);
    const first = await sync(client);
    expect(first).toMatchObject({
      status: "SUCCEEDED",
      fetched: 60,
      inserted: 60,
      updated: 0,
    });
    expect(client.query).toHaveBeenCalledWith(
      "ProductsPage",
      expect.any(String),
      expect.objectContaining({ after: "p1" }),
      expect.any(Number),
    );
    const before = await rows();
    const target = before.find((r) => r.shopifyProductGid === nodes[0].id)!;
    await db.productEnrichment.create({
      data: {
        productId: target.id,
        badgeText: "Staff Pick",
        badgeColor: "#235E45",
        internalNote: "Private",
      },
    });
    const other = await db.shop.create({
      data: { shopDomain: `sync-other-${randomUUID()}.myshopify.com` },
    });
    shops.push(other.id);
    await db.product.create({
      data: {
        shopId: other.id,
        shopifyProductGid: nodes[0].id,
        title: "Other shop",
        handle: "other",
        status: "ACTIVE",
        updatedAtShopify: new Date(),
        syncedAt: new Date(0),
      },
    });
    nodes[0].title = "Classic T-shirt";
    const second = await sync(api([page(nodes)]));
    expect(second).toMatchObject({
      status: "SUCCEEDED",
      inserted: 0,
      updated: 60,
    });
    const after = await rows();
    expect(after).toHaveLength(60);
    expect(after.reduce((n, r) => n + r.variants.length, 0)).toBe(60);
    expect(after.find((r) => r.id === target.id)).toMatchObject({
      title: "Classic T-shirt",
      enrichment: { badgeText: "Staff Pick", internalNote: "Private" },
    });
    expect(
      await db.product.findFirst({ where: { shopId: other.id } }),
    ).toMatchObject({ title: "Other shop", deletedAt: null });
  });

  it("loads every variant page and removes an obsolete variant only after the complete read", async () => {
    const node = makeProduct(131);
    await sync(api([page([node])]));
    const all = node.variants.nodes.slice(0, 130);
    const partial = {
      ...node,
      variants: {
        nodes: all.slice(0, 25),
        pageInfo: { hasNextPage: true, endCursor: "v1" },
      },
    };
    const client = api(
      [page([partial])],
      [
        {
          product: {
            id: node.id,
            updatedAt: node.updatedAt,
            variants: {
              nodes: all.slice(25, 125),
              pageInfo: { hasNextPage: true, endCursor: "v2" },
            },
          },
        },
        {
          product: {
            id: node.id,
            updatedAt: node.updatedAt,
            variants: {
              nodes: all.slice(125),
              pageInfo: { hasNextPage: false, endCursor: "v3" },
            },
          },
        },
      ],
    );
    expect((await sync(client)).status).toBe("SUCCEEDED");
    expect((await rows())[0].variants).toHaveLength(130);
    expect(client.query).toHaveBeenCalledWith(
      "ProductVariantsPage",
      expect.any(String),
      expect.objectContaining({ after: "v2" }),
      expect.any(Number),
    );
  });

  it("fails validation without marking an existing product deleted", async () => {
    const node = makeProduct();
    await sync(api([page([node])]));
    const result = await sync(api([page([{ ...node, updatedAt: "invalid" }])]));
    expect(result).toMatchObject({
      status: "FAILED",
      failed: 1,
      markedStale: 0,
    });
    expect((await rows())[0].deletedAt).toBeNull();
  });

  it("rolls back a failed page and reports only committed writes", async () => {
    const nodes = [makeProduct(), { ...makeProduct(), title: "x".repeat(256) }];
    const result = await sync(api([page(nodes)]));
    expect(result).toMatchObject({
      status: "FAILED",
      inserted: 0,
      updated: 0,
      cursor: null,
    });
    expect(await rows()).toHaveLength(0);
  });

  it("keeps a committed first page on a later API failure, then safely re-runs", async () => {
    const old = makeProduct();
    await sync(api([page([old])]));
    const node = makeProduct();
    const result = await sync(
      api([page([node], "page1", true), new Error("Network failure")]),
    );
    expect(result).toMatchObject({
      status: "FAILED",
      inserted: 1,
      cursor: "page1",
      markedStale: 0,
    });
    expect((await rows()).every((r) => r.deletedAt === null)).toBe(true);
    const retry = await sync(api([page([old, node])]));
    expect(retry).toMatchObject({
      status: "SUCCEEDED",
      inserted: 0,
      updated: 2,
    });
    expect(await rows()).toHaveLength(2);
  });

  it("soft-deletes missing products after success and retains their enrichment", async () => {
    const node = makeProduct();
    await sync(api([page([node])]));
    const saved = (await rows())[0];
    await db.productEnrichment.create({
      data: { productId: saved.id, badgeText: "Keep", badgeColor: "#000000" },
    });
    // Separate timestamps explicitly; deletion uses a millisecond precision cutoff.
    await db.product.update({
      where: { id: saved.id },
      data: { syncedAt: new Date(0) },
    });
    expect((await sync(api([page([])]))).markedStale).toBe(1);
    expect((await rows())[0].deletedAt).not.toBeNull();
    expect((await rows())[0].enrichment?.badgeText).toBe("Keep");
    await sync(api([page([node])]));
    expect((await rows())[0].deletedAt).toBeNull();
  });

  it("rejects simultaneous starts and an uninstalled shop", async () => {
    const results = await Promise.allSettled([
      startSyncRun(shop.id, "FULL"),
      startSyncRun(shop.id, "FULL"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SyncConflictError);
    await db.shop.update({
      where: { id: shop.id },
      data: { uninstalledAt: new Date() },
    });
    await expect(startSyncRun(shop.id, "FULL")).rejects.toBeInstanceOf(
      Response,
    );
  });

  it("fences an abandoned run after a replacement starts", async () => {
    const old = await startSyncRun(shop.id, "FULL");
    await db.syncRun.update({
      where: { id: old.id },
      data: { startedAt: new Date(Date.now() - 16 * 60_000) },
    });
    const replacement = await startSyncRun(shop.id, "FULL");
    // A delayed original worker has its original in-memory run; it must not commit.
    const result = await runProductSync(
      api([page([makeProduct()])]),
      shop.id,
      old,
    );
    expect(result.status).toBe("FAILED");
    expect(await rows()).toHaveLength(0);
    expect(
      (await db.syncRun.findUniqueOrThrow({ where: { id: replacement.id } }))
        .status,
    ).toBe("RUNNING");
  });

  it("does not remove saved variants when fetching the remaining variants fails", async () => {
    const node = makeProduct(30);
    await sync(api([page([node])]));
    const partial = {
      ...node,
      variants: {
        nodes: node.variants.nodes.slice(0, 25),
        pageInfo: { hasNextPage: true, endCursor: "v1" },
      },
    };
    expect(
      (await sync(api([page([partial])], [new Error("Variant read failed")])))
        .status,
    ).toBe("FAILED");
    expect((await rows())[0].variants).toHaveLength(30);
  });

  it("fails safely if a product changes during variant pagination", async () => {
    const node = makeProduct(30);
    node.variants.pageInfo = { hasNextPage: true, endCursor: "v1" };
    const result = await sync(
      api(
        [page([node])],
        [{ product: { ...node, updatedAt: "2026-07-02T00:00:00Z" } }],
      ),
    );
    expect(result.status).toBe("FAILED");
    expect(await rows()).toHaveLength(0);
  });
});
