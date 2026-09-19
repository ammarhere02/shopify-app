import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Shop } from "@prisma/client";
import db from "../app/db.server";
import {
  getProductById,
  listProducts,
  removeEnrichment,
  saveEnrichment,
} from "../app/repositories/enrichment.server";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error(
    "Run through npm run test:integration with a dedicated test database",
  );
}

const shops: number[] = [];
let shopA: Shop;
let shopB: Shop;
let gid = Math.floor(Date.now() / 10);
const badge = {
  badgeText: "Staff Pick",
  badgeColor: "#1A7F37",
  internalNote: "private",
  active: true,
};
const makeShop = async () => {
  const shop = await db.shop.create({
    data: { shopDomain: `enrichment-${randomUUID()}.myshopify.com` },
  });
  shops.push(shop.id);
  return shop;
};
const makeProduct = (shopId: number, title: string, status = "ACTIVE") =>
  db.product.create({
    data: {
      shopId,
      shopifyProductGid: `gid://shopify/Product/${++gid}`,
      title,
      handle: `h-${gid}`,
      status,
      updatedAtShopify: new Date(),
      syncedAt: new Date(),
    },
  });

beforeEach(async () => {
  shopA = await makeShop();
  shopB = await makeShop();
});
afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("enrichment repository (real MySQL)", () => {
  it("saving twice keeps exactly one enrichment per product", async () => {
    const product = await makeProduct(shopA.id, "Red Shirt");
    const first = await saveEnrichment(shopA.id, product.id, badge);
    const second = await saveEnrichment(shopA.id, product.id, {
      ...badge,
      badgeText: "New",
    });
    expect(first?.created).toBe(true);
    expect(second?.created).toBe(false);
    const rows = await db.productEnrichment.findMany({
      where: { productId: product.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].badgeText).toBe("New");
  });

  it("another shop cannot read, write or remove the product", async () => {
    const product = await makeProduct(shopA.id, "Red Shirt");
    await saveEnrichment(shopA.id, product.id, badge);
    expect(await getProductById(shopB.id, product.id)).toBeNull();
    expect(await saveEnrichment(shopB.id, product.id, badge)).toBeNull();
    expect(await removeEnrichment(shopB.id, product.id)).toBe(false);
    expect((await getProductById(shopA.id, product.id))?.enrichment).not.toBeNull();
  });

  it("remove is idempotent", async () => {
    const product = await makeProduct(shopA.id, "Red Shirt");
    await saveEnrichment(shopA.id, product.id, badge);
    expect(await removeEnrichment(shopA.id, product.id)).toBe(true);
    expect(await removeEnrichment(shopA.id, product.id)).toBe(true);
    expect((await getProductById(shopA.id, product.id))?.enrichment).toBeNull();
  });

  it("filters by title, status and badge, and hides deleted and foreign products", async () => {
    const red = await makeProduct(shopA.id, "Red Shirt");
    await makeProduct(shopA.id, "Blue Shirt", "DRAFT");
    const gone = await makeProduct(shopA.id, "Red Hat");
    await db.product.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await makeProduct(shopB.id, "Red Shirt");
    await saveEnrichment(shopA.id, red.id, badge);

    const titles = async (filters: Parameters<typeof listProducts>[1]) =>
      (await listProducts(shopA.id, filters)).products.map((p) => p.title);
    expect(await titles({ query: "red" })).toEqual(["Red Shirt"]);
    expect(await titles({ status: "DRAFT" })).toEqual(["Blue Shirt"]);
    expect(await titles({ hasBadge: true })).toEqual(["Red Shirt"]);
    expect(await titles({ hasBadge: false })).toEqual(["Blue Shirt"]);
  });

  it("paginates with a cursor without repeating rows", async () => {
    for (let i = 0; i < 5; i++) await makeProduct(shopA.id, `P${i}`);
    const first = await listProducts(shopA.id, { limit: 2 });
    const second = await listProducts(shopA.id, { limit: 2, afterId: first.nextCursor! });
    const third = await listProducts(shopA.id, { limit: 2, afterId: second.nextCursor! });
    const all = [...first.products, ...second.products, ...third.products];
    expect(all.map((p) => p.title)).toEqual(["P0", "P1", "P2", "P3", "P4"]);
    expect(third.nextCursor).toBeNull();
  });
});
