import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shop } from "@prisma/client";

const { adminMock, authAdminMock, generateMock } = vi.hoisted(() => ({
  adminMock: vi.fn(),
  authAdminMock: vi.fn(),
  generateMock: vi.fn(),
}));
vi.mock("../app/lib/logger.server", () => {
  const noop = () => undefined;
  return { logger: { info: noop, warn: noop, error: noop } };
});
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
  authenticate: { admin: authAdminMock },
}));
vi.mock("../app/ai/openrouter-client.server", async (original) => ({
  ...(await original<typeof import("../app/ai/openrouter-client.server")>()),
  createOpenRouterClient: () => ({ generate: generateMock }),
}));

import db from "../app/db.server";
import { loadAiConfig } from "../app/ai/config.server";
import { createApiKey } from "../app/services/api-key.server";
import { resetRateLimitsForTests } from "../app/services/api.server";
import { resetAdminLimitsForTests } from "../app/services/admin-limits.server";
import { createShopifyClient } from "../app/shopify/graphql-client.server";
import { startBatchGeneration } from "../app/services/generation-batch.server";
import { LEASE_GRACE_MS, workOnce } from "../app/services/generation-worker.server";
import * as batchRoute from "../app/routes/api.v1.description-generations.batch";
import * as listRoute from "../app/routes/app.products._index";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error("Run through npm run test:integration with a dedicated test database");
}

const answer = { descriptionHtml: "<p>Batch text</p>", shortDescription: "s", seoTitle: "t", seoDescription: "d", highlights: [], warnings: [] };
/** Products with an odd Shopify id have two images; even ids have none (so a batch has something to skip). */
const graphql = vi.fn(async (_doc: string, opts?: { variables?: Record<string, unknown> }) => {
  const gid = String(opts?.variables?.id);
  const n = Number(gid.split("/").pop());
  const images = n % 2 === 1 ? [301, 302, 303, 304, 305] : [];
  return new Response(
    JSON.stringify({
      data: {
        product: {
          id: gid, title: `Product ${n}`, descriptionHtml: "<p>Old</p>", updatedAt: "2026-09-21T10:00:00Z", vendor: null, productType: null, tags: [], status: "ACTIVE",
          media: { nodes: images.map((i) => ({ id: `gid://shopify/MediaImage/${i}`, alt: null, mediaContentType: "IMAGE", status: "READY", image: { url: `https://cdn.shopify.com/${i}.jpg`, width: 10, height: 10 } })) },
        },
      },
    }),
  );
});

const shops: number[] = [];
let shopA: Shop;
let shopB: Shop;
let keyA: string;
let nextId = Math.floor(Date.now() / 10) + 1_200_000;
const makeShop = async () => {
  const shop = await db.shop.create({ data: { shopDomain: `worker-${randomUUID()}.myshopify.com` } });
  shops.push(shop.id);
  return shop;
};
/** `odd` = with images. Ids are forced to the requested parity. */
const makeProduct = async (shop: Shop, odd = true) => {
  nextId += nextId % 2 === (odd ? 1 : 0) ? 2 : 1;
  const id = nextId;
  const row = await db.product.create({ data: { shopId: shop.id, shopifyProductGid: `gid://shopify/Product/${id}`, title: `Product ${id}`, handle: `h-${id}`, status: "ACTIVE", updatedAtShopify: new Date(), syncedAt: new Date() } });
  return { local: row.id, shopify: id };
};
const deps = () => {
  const config = loadAiConfig();
  return { config, ai: { generate: generateMock }, shopify: createShopifyClient(graphql, {}) };
};
/** A job old enough for the worker to take it (the grace period protects inline runs). */
const age = (jobIds: number[]) => db.aiGenerationJob.updateMany({ where: { id: { in: jobIds } }, data: { createdAt: new Date(Date.now() - LEASE_GRACE_MS - 1000) } });
const worker = () => ({ deps: deps(), maxRunningPerShop: 1 });
const drain = async () => {
  let n = 0;
  while (await workOnce(worker())) n++;
  return n;
};

beforeEach(async () => {
  resetRateLimitsForTests();
  resetAdminLimitsForTests();
  graphql.mockClear();
  generateMock.mockReset();
  generateMock.mockImplementation(async () => ({ content: JSON.stringify(answer), generationId: "g", model: "vendor/vision:free", promptTokens: 1, completionTokens: 1, cost: 0, latencyMs: 5 }));
  adminMock.mockReset();
  adminMock.mockImplementation(async () => ({ admin: { graphql } }));
  process.env.OPENROUTER_API_KEY = "sk-test-key";
  process.env.OPENROUTER_MODELS = "vendor/vision:free";
  process.env.AI_MAX_IMAGES = "4";
  delete process.env.AI_DAILY_LIMIT_PER_SHOP;
  shopA = await makeShop();
  shopB = await makeShop();
  keyA = (await createApiKey(shopA.id, "a")).plaintext;
});

afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("batch enqueue", () => {
  it("queues one job per product with its first images, skips products without images, and is idempotent", async () => {
    const [a, b, c] = [await makeProduct(shopA), await makeProduct(shopA, false), await makeProduct(shopA)];
    const key = randomUUID().slice(0, 32);
    const result = await startBatchGeneration(deps(), shopA.id, { productIds: [a.local, b.local, c.local], idempotencyKey: key, merchantContext: "Warm" });
    expect(result.jobs.map((j) => [j.productId, j.created])).toEqual([[a.local, true], [c.local, true]]);
    expect(result.skipped).toEqual([{ productId: b.local, reason: "No ready image" }]);
    const jobs = await db.aiGenerationJob.findMany({ where: { shopId: shopA.id }, include: { input: true }, orderBy: { id: "asc" } });
    expect(jobs.map((j) => j.status)).toEqual(["QUEUED", "QUEUED"]); // nothing ran inline
    expect(jobs[0].input!.imageCount).toBe(4); // capped at AI_MAX_IMAGES, not all five
    expect(jobs[0].input!.merchantContext).toBe("Warm");
    expect(generateMock).not.toHaveBeenCalled();

    const again = await startBatchGeneration(deps(), shopA.id, { productIds: [a.local, b.local, c.local], idempotencyKey: key });
    expect(again.jobs.every((j) => !j.created)).toBe(true);
    expect(await db.aiGenerationJob.count({ where: { shopId: shopA.id } })).toBe(2);
  });

  it("queues past the concurrency limit but stops at the daily limit, keeping what was queued", async () => {
    process.env.AI_DAILY_LIMIT_PER_SHOP = "2";
    const ps = [await makeProduct(shopA), await makeProduct(shopA), await makeProduct(shopA)];
    const result = await startBatchGeneration(deps(), shopA.id, { productIds: ps.map((p) => p.local), idempotencyKey: randomUUID().slice(0, 32) });
    expect(result.jobs).toHaveLength(2);
    expect(result.skipped).toEqual([{ productId: ps[2].local, reason: expect.stringMatching(/Daily generation limit/) }]);
  });

  it("refuses another shop's product, duplicates, and more than 20 products, before creating anything", async () => {
    const mine = await makeProduct(shopA);
    const theirs = await makeProduct(shopB);
    await expect(startBatchGeneration(deps(), shopA.id, { productIds: [mine.local, theirs.local], idempotencyKey: randomUUID().slice(0, 32) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(startBatchGeneration(deps(), shopA.id, { productIds: [mine.local, mine.local], idempotencyKey: randomUUID().slice(0, 32) })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(startBatchGeneration(deps(), shopA.id, { productIds: Array.from({ length: 21 }, (_, i) => i + 1), idempotencyKey: randomUUID().slice(0, 32) })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(startBatchGeneration(deps(), shopA.id, { productIds: [mine.local], idempotencyKey: "short" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.aiGenerationJob.count({ where: { shopId: { in: [shopA.id, shopB.id] } } })).toBe(0);
  });
});

describe("worker", () => {
  it("runs queued jobs oldest first, one per shop at a time, and leaves fresh jobs alone", async () => {
    const ps = [await makeProduct(shopA), await makeProduct(shopA), await makeProduct(shopB)];
    const r = await startBatchGeneration(deps(), shopA.id, { productIds: [ps[0].local, ps[1].local], idempotencyKey: randomUUID().slice(0, 32) });
    const rb = await startBatchGeneration(deps(), shopB.id, { productIds: [ps[2].local], idempotencyKey: randomUUID().slice(0, 32) });
    expect(await workOnce(worker())).toBe(false); // all three are younger than the grace period
    await age([r.jobs[0].jobId, rb.jobs[0].jobId]); // the second A job stays fresh

    expect(await workOnce(worker())).toBe(true);
    let jobs = await db.aiGenerationJob.findMany({ where: { id: { in: r.jobs.map((j) => j.jobId).concat(rb.jobs[0].jobId) } }, orderBy: { id: "asc" } });
    expect(jobs.map((j) => j.status)).toEqual(["SUCCEEDED", "QUEUED", "QUEUED"]);
    expect(jobs[0]).toMatchObject({ reviewStatus: "DRAFT", draftHtml: "<p>Batch text</p>" });
    expect(await drain()).toBe(1); // shop B's job; A's second one is still fresh
    await age([r.jobs[1].jobId]);
    expect(await drain()).toBe(1);
    jobs = await db.aiGenerationJob.findMany({ where: { shopId: { in: [shopA.id, shopB.id] } } });
    expect(jobs.every((j) => j.status === "SUCCEEDED")).toBe(true);
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("respects the per-shop concurrency limit while a job is RUNNING", async () => {
    const ps = [await makeProduct(shopA), await makeProduct(shopA)];
    const r = await startBatchGeneration(deps(), shopA.id, { productIds: ps.map((p) => p.local), idempotencyKey: randomUUID().slice(0, 32) });
    await age(r.jobs.map((j) => j.jobId));
    await db.aiGenerationJob.update({ where: { id: r.jobs[0].jobId }, data: { status: "RUNNING", startedAt: new Date() } });
    expect(await workOnce(worker())).toBe(false);
    await db.aiGenerationJob.update({ where: { id: r.jobs[0].jobId }, data: { status: "FAILED", completedAt: new Date() } });
    expect(await workOnce(worker())).toBe(true);
  });

  it("records a provider failure on the job and moves on; the job's prompt is rebuilt from the stored input", async () => {
    const p = await makeProduct(shopA);
    const r = await startBatchGeneration(deps(), shopA.id, { productIds: [p.local], idempotencyKey: randomUUID().slice(0, 32), merchantContext: "Facts here" });
    await age([r.jobs[0].jobId]);
    generateMock.mockImplementationOnce(async (req: { messages: Array<{ content: unknown }> }) => {
      const text = JSON.stringify(req.messages);
      expect(text).toContain("Facts here");
      expect(text).toContain("https://cdn.shopify.com/301.jpg");
      throw Object.assign(new Error("boom"), { name: "AiProviderError", kind: "TRANSPORT" });
    });
    expect(await workOnce(worker())).toBe(true);
    const job = await db.aiGenerationJob.findUnique({ where: { id: r.jobs[0].jobId } });
    expect(job!.status).toBe("FAILED");
    expect(job!.error).toMatch(/boom|Unexpected error/);
  });

  it("two workers never run the same job", async () => {
    const ps = [await makeProduct(shopA), await makeProduct(shopB)];
    const ra = await startBatchGeneration(deps(), shopA.id, { productIds: [ps[0].local], idempotencyKey: randomUUID().slice(0, 32) });
    const rb = await startBatchGeneration(deps(), shopB.id, { productIds: [ps[1].local], idempotencyKey: randomUUID().slice(0, 32) });
    await age([ra.jobs[0].jobId, rb.jobs[0].jobId]);
    const results = await Promise.all([workOnce(worker()), workOnce(worker()), workOnce(worker())]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(generateMock).toHaveBeenCalledTimes(2);
  });
});

describe("batch routes", () => {
  const api = (body: unknown, opts: { key?: string | null; idempotencyKey?: string } = {}) => {
    const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.9", "content-type": "application/json", "idempotency-key": opts.idempotencyKey ?? randomUUID().slice(0, 32) };
    if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? keyA}`;
    return batchRoute.action({ request: new Request("https://app.example.test/api/v1/description-generations/batch", { method: "POST", headers, body: JSON.stringify(body) }), params: {}, context: {} } as never) as Promise<Response>;
  };

  it("POST /description-generations/batch → 202 with job ids by Shopify id; 404 for another shop's product; 401", async () => {
    const [a, b] = [await makeProduct(shopA), await makeProduct(shopA, false)];
    const res = await api({ productIds: [String(a.shopify), String(b.shopify)], merchantContext: "x" });
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data.jobs).toEqual([{ productId: `gid://shopify/Product/${a.shopify}`, generationId: expect.any(Number), created: true }]);
    expect(data.skipped).toEqual([{ productId: `gid://shopify/Product/${b.shopify}`, reason: "No ready image" }]);
    const theirs = await makeProduct(shopB);
    expect((await api({ productIds: [String(a.shopify), String(theirs.shopify)] })).status).toBe(404);
    expect((await api({ productIds: "nope" })).status).toBe(422);
    expect((await api({ productIds: [String(a.shopify)] }, { key: null })).status).toBe(401);
  });

  it("admin list action queues for selected products and reports skipped ones", async () => {
    authAdminMock.mockImplementation(async () => ({ session: { shop: shopA.shopDomain }, admin: { graphql } }));
    const [a, b] = [await makeProduct(shopA), await makeProduct(shopA, false)];
    const form = new FormData();
    form.set("intent", "generateBatch");
    form.set("idempotencyKey", randomUUID().slice(0, 32));
    form.set("merchantContext", "Cosy");
    form.set("model", "vendor/vision:free");
    form.append("productIds", String(a.local));
    form.append("productIds", String(b.local));
    const result = await listRoute.action({ request: new Request("https://app.example.test/app/products", { method: "POST", body: form }), params: {}, context: {} } as never);
    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/1 generation queued, 1 skipped/), result: { jobs: [{ productId: a.local, created: true }], skipped: [{ productId: b.local }] } });
    expect(await db.aiGenerationJob.count({ where: { shopId: shopA.id, status: "QUEUED" } })).toBe(1);
    expect((await db.aiGenerationJob.findFirst({ where: { shopId: shopA.id } }))!.model).toBe("vendor/vision:free");

    form.set("model", "vendor/not-allowed");
    form.set("idempotencyKey", randomUUID().slice(0, 32));
    expect(await listRoute.action({ request: new Request("https://app.example.test/app/products", { method: "POST", body: form }), params: {}, context: {} } as never)).toMatchObject({ ok: false, errors: { model: "Model is not allowed" } });
  });
});
