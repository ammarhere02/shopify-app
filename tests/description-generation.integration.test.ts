import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product, Shop } from "@prisma/client";
import db from "../app/db.server";
import { loadAiConfig } from "../app/ai/config.server";
import { AiProviderError } from "../app/ai/openrouter-client.server";
import type { GenerationRequest, GenerationResult, OpenRouterClient } from "../app/ai/openrouter-client.server";
import type { ShopifyClient } from "../app/shopify/graphql-client.server";
import { getJob } from "../app/repositories/ai-generation.server";
import {
  GenerationError,
  startGeneration,
} from "../app/services/description-generation.server";
import type { GenerationDeps, StartGenerationInput } from "../app/services/description-generation.server";
import { JOB_ABANDON_MS } from "../app/services/generation-state";
import { sha256Hex } from "../app/services/input-hash.server";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error(
    "Run through npm run test:integration with a dedicated test database",
  );
}

const IMG1 = "gid://shopify/MediaImage/101";
const IMG2 = "gid://shopify/MediaImage/102";
const NOT_READY = "gid://shopify/MediaImage/103";
const FOREIGN = "gid://shopify/MediaImage/999";
const CURRENT_HTML = "<p>Old description, 100% wool.</p>";

const shops: number[] = [];
let shop: Shop;
let otherShop: Shop;
let product: Product;
let otherProduct: Product;
let gid = Math.floor(Date.now() / 10);

const makeShop = async () => {
  const row = await db.shop.create({ data: { shopDomain: `descgen-${randomUUID()}.myshopify.com` } });
  shops.push(row.id);
  return row;
};
const makeProduct = (shopId: number) =>
  db.product.create({
    data: {
      shopId,
      shopifyProductGid: `gid://shopify/Product/${++gid}`,
      title: "Blue Beanie",
      handle: `h-${gid}`,
      status: "ACTIVE",
      updatedAtShopify: new Date(),
      syncedAt: new Date(),
    },
  });

const shopifyProduct = (id: string) => ({
  id,
  title: "Blue Beanie",
  descriptionHtml: CURRENT_HTML,
  updatedAt: "2026-09-21T10:00:00Z",
  vendor: "Acme",
  productType: "Hats",
  tags: ["winter"],
  status: "ACTIVE",
  media: {
    nodes: [
      { id: IMG1, alt: "front", mediaContentType: "IMAGE", status: "READY", image: { url: "https://cdn.shopify.com/1.jpg", width: 1024, height: 1024 } },
      { id: IMG2, alt: null, mediaContentType: "IMAGE", status: "READY", image: { url: "https://cdn.shopify.com/2.jpg", width: 1024, height: 1024 } },
      { id: NOT_READY, alt: null, mediaContentType: "IMAGE", status: "PROCESSING", image: null },
      { id: "gid://shopify/Video/5", alt: null, mediaContentType: "VIDEO", status: "READY" },
    ],
  },
});

const answer = {
  descriptionHtml: '<p onclick="x">A warm beanie, waterproof and made of 100% wool.</p><script>alert(1)</script>',
  shortDescription: "A warm beanie.",
  seoTitle: "Blue Beanie",
  seoDescription: "A warm blue beanie.",
  highlights: ["Warm"],
  warnings: ["Colour judged from the photo"],
};
const result = (content: string): GenerationResult => ({
  content,
  generationId: "gen-1",
  model: "vendor/vision:free",
  promptTokens: 800,
  completionTokens: 200,
  cost: 0,
  latencyMs: 1500,
});

const config = loadAiConfig({
  OPENROUTER_API_KEY: "sk-test",
  OPENROUTER_MODELS: "vendor/vision:free,vendor/other:free",
  AI_DAILY_LIMIT_PER_SHOP: "3",
});
let generate: ReturnType<typeof vi.fn<(request: GenerationRequest) => Promise<GenerationResult>>>;
let shopifyQuery: ReturnType<typeof vi.fn>;
let deps: GenerationDeps;

const input = (overrides: Partial<StartGenerationInput> = {}): StartGenerationInput => ({
  productId: product.id,
  mediaIds: [IMG1, IMG2],
  merchantContext: "For skiers",
  idempotencyKey: randomUUID(),
  ...overrides,
});
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as GenerationError;
  }
  throw new Error("expected a rejection");
};
/** Each test gets a fresh shop, so limits and running jobs never leak between tests. */
beforeEach(async () => {
  shop = await makeShop();
  product = await makeProduct(shop.id);
  generate = vi.fn(async () => result(JSON.stringify(answer)));
  shopifyQuery = vi.fn(async (_name: string, _doc: string, variables: { id: string }) => ({
    product: shopifyProduct(variables.id),
  }));
  deps = {
    config,
    ai: { generate } as OpenRouterClient,
    shopify: { query: shopifyQuery } as unknown as ShopifyClient,
  };
});

beforeAll(async () => {
  otherShop = await makeShop();
  otherProduct = await makeProduct(otherShop.id);
});

afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("a successful generation", () => {
  it("returns a QUEUED job first, then the run stores a sanitized draft, warnings and usage", async () => {
    const started = await startGeneration(deps, shop.id, input());
    expect(started.created).toBe(true);
    expect(started.job).toMatchObject({ status: "QUEUED", model: "vendor/vision:free", provider: "openrouter", promptVersion: "v3" });
    expect(started.job.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(generate).not.toHaveBeenCalled();

    await started.run!();
    const job = await getJob(shop.id, started.job.id);
    expect(job).toMatchObject({
      status: "SUCCEEDED",
      reviewStatus: "DRAFT",
      draftHtml: "<p>A warm beanie, waterproof and made of 100% wool.</p>",
    });
    expect(job!.output).toMatchObject({ generationId: "gen-1", promptTokens: 800, completionTokens: 200, latencyMs: 1500 });
    expect(job!.output!.rawJson).toEqual(answer); // the model's words, untouched
    expect((job!.output!.validatedJson as { descriptionHtml: string }).descriptionHtml).not.toContain("script");

    const warnings = job!.output!.warningsJson as string[];
    expect(warnings).toContain("Colour judged from the photo");
    expect(warnings.some((w) => w.includes("performance"))).toBe(true); // "waterproof" is nowhere in the trusted data
    expect(warnings.some((w) => w.includes("material"))).toBe(false); // "100% wool" is in the current description
  });

  it("snapshots what Apply needs later and sends only this product's Shopify images", async () => {
    const started = await startGeneration(deps, shop.id, input({ mediaIds: [IMG2] }));
    await started.run!();
    const job = await getJob(shop.id, started.job.id);
    expect(job!.input).toMatchObject({ imageCount: 1, merchantContext: "For skiers", selectedMediaIds: [IMG2] });
    expect(job!.input!.productSnapshotJson).toMatchObject({
      shopifyProductGid: product.shopifyProductGid,
      shopifyUpdatedAt: "2026-09-21T10:00:00Z",
      descriptionHtml: CURRENT_HTML,
      descriptionHash: sha256Hex(CURRENT_HTML),
      images: [{ id: IMG2, url: "https://cdn.shopify.com/2.jpg", alt: null }],
    });

    const request = generate.mock.calls[0][0];
    expect(request.model).toBe("vendor/vision:free");
    expect(request.maxOutputTokens).toBe(1500);
    const parts = request.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(parts[1].image_url!.url).toBe("https://cdn.shopify.com/2.jpg");
    expect(shopifyQuery).toHaveBeenCalledWith("ProductForDescription", expect.any(String), { id: product.shopifyProductGid });
  });

  it("accepts an allowlisted model and links a regeneration", async () => {
    const first = await startGeneration(deps, shop.id, input());
    await first.run!();
    const second = await startGeneration(deps, shop.id, input({ model: "vendor/other:free", previousJobId: first.job.id }));
    expect(second.job).toMatchObject({ model: "vendor/other:free", previousJobId: first.job.id });
    expect(second.job.inputHash).not.toBe(first.job.inputHash);
  });
});

describe("idempotency", () => {
  it("returns the same job for a repeated key without calling Shopify or the model again", async () => {
    const request = input();
    const first = await startGeneration(deps, shop.id, request);
    await first.run!();
    const again = await startGeneration(deps, shop.id, request);
    expect(again).toMatchObject({ created: false });
    expect(again.job.id).toBe(first.job.id);
    expect(again.run).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(shopifyQuery).toHaveBeenCalledTimes(1);
  });

  it("creates one job for simultaneous identical requests", async () => {
    const request = input();
    const results = await Promise.all(Array.from({ length: 4 }, () => startGeneration(deps, shop.id, request)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
  });

  it("never rate-limits a retry of an accepted request", async () => {
    const request = input();
    await startGeneration(deps, shop.id, request); // stays QUEUED: the concurrency slot is taken
    expect((await errorOf(startGeneration(deps, shop.id, input()))).code).toBe("LIMIT");
    expect((await startGeneration(deps, shop.id, request)).created).toBe(false);
  });
});

describe("failures end as diagnosable FAILED jobs", () => {
  it("fails, without retrying, when the answer is not valid", async () => {
    generate.mockResolvedValueOnce(result('Sure! {"descriptionHtml": "<p>x</p>"'));
    const started = await startGeneration(deps, shop.id, input());
    await started.run!();
    const job = await getJob(shop.id, started.job.id);
    expect(job).toMatchObject({ status: "FAILED", reviewStatus: null, draftHtml: null, output: null });
    expect(job!.error).toMatch(/^INVALID_OUTPUT: Model output is not valid JSON\. Model said: Sure!/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("fails on an extra field even though the JSON parses", async () => {
    generate.mockResolvedValueOnce(result(JSON.stringify({ ...answer, price: "9.99" })));
    const started = await startGeneration(deps, shop.id, input());
    await started.run!();
    expect((await getJob(shop.id, started.job.id))!.error).toMatch(/Unexpected field: price/);
  });

  it.each([
    ["REFUSED", new AiProviderError("REFUSED", "The model declined to describe this product", false)],
    ["RATE_LIMITED", new AiProviderError("RATE_LIMITED", "OpenRouter returned 429", true)],
    ["TIMEOUT", new AiProviderError("TIMEOUT", "No answer within 60000 ms", true)],
  ])("records a %s provider failure", async (kind, error) => {
    generate.mockRejectedValueOnce(error);
    const started = await startGeneration(deps, shop.id, input());
    await started.run!(); // never throws
    const job = await getJob(shop.id, started.job.id);
    expect(job!.status).toBe("FAILED");
    expect(job!.error).toMatch(new RegExp(`^${kind}: `));
    expect(job!.completedAt).not.toBeNull();
  });

  it("hides internal error text and frees the slot for a regeneration", async () => {
    generate.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:3306 password=hunter2"));
    const failed = await startGeneration(deps, shop.id, input());
    await failed.run!();
    expect((await getJob(shop.id, failed.job.id))!.error).toBe("INTERNAL: Unexpected error while generating");

    const retry = await startGeneration(deps, shop.id, input({ previousJobId: failed.job.id }));
    await retry.run!();
    expect((await getJob(shop.id, retry.job.id))!.status).toBe("SUCCEEDED");
  });
});

describe("request validation (nothing is stored, nothing is called)", () => {
  it.each([
    ["no images", { mediaIds: [] }, "mediaIds"],
    ["five images", { mediaIds: [1, 2, 3, 4, 5].map((n) => `gid://shopify/MediaImage/${n}`) }, "mediaIds"],
    ["a URL instead of a media id", { mediaIds: ["https://evil.test/x.jpg"] }, "mediaIds"],
    ["an internal address", { mediaIds: ["http://169.254.169.254/latest/meta-data"] }, "mediaIds"],
    ["a non-image gid", { mediaIds: ["gid://shopify/Product/1"] }, "mediaIds"],
    ["the same image twice", { mediaIds: [IMG1, IMG1] }, "mediaIds"],
    ["oversized context", { merchantContext: "x".repeat(2001) }, "merchantContext"],
    ["a short idempotency key", { idempotencyKey: "abc" }, "idempotencyKey"],
    ["a model outside the allowlist", { model: "vendor/expensive" }, "model"],
  ])("rejects %s", async (_label, overrides, field) => {
    const error = await errorOf(startGeneration(deps, shop.id, input(overrides as Partial<StartGenerationInput>)));
    expect(error).toBeInstanceOf(GenerationError);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toHaveProperty(field);
    expect(shopifyQuery).not.toHaveBeenCalled();
    expect(await db.aiGenerationJob.count({ where: { shopId: shop.id } })).toBe(0);
  });

  it.each([
    ["an image of another product", [IMG1, FOREIGN]],
    ["an image that is still processing", [NOT_READY]],
  ])("rejects %s after checking Shopify", async (_label, mediaIds) => {
    const error = await errorOf(startGeneration(deps, shop.id, input({ mediaIds })));
    expect(error).toMatchObject({ code: "VALIDATION", details: { mediaIds: expect.any(String) } });
    expect(generate).not.toHaveBeenCalled();
    expect(await db.aiGenerationJob.count({ where: { shopId: shop.id } })).toBe(0);
  });
});

describe("tenant isolation and missing products", () => {
  it("treats another shop's product as not found, before any Shopify call", async () => {
    const error = await errorOf(startGeneration(deps, shop.id, input({ productId: otherProduct.id })));
    expect(error.code).toBe("NOT_FOUND");
    expect(shopifyQuery).not.toHaveBeenCalled();
  });

  it("does not return another shop's job for the same idempotency key", async () => {
    const key = randomUUID();
    const theirs = await startGeneration(deps, otherShop.id, input({ productId: otherProduct.id, idempotencyKey: key }));
    const mine = await startGeneration(deps, shop.id, input({ idempotencyKey: key }));
    expect(mine.created).toBe(true);
    expect(mine.job.id).not.toBe(theirs.job.id);
    await theirs.run!();
  });

  it("refuses a previous job of another shop, a deleted product and a product gone from Shopify", async () => {
    const theirs = await startGeneration(deps, otherShop.id, input({ productId: otherProduct.id }));
    await theirs.run!();
    expect((await errorOf(startGeneration(deps, shop.id, input({ previousJobId: theirs.job.id })))).code).toBe("NOT_FOUND");

    shopifyQuery.mockResolvedValueOnce({ product: null });
    expect((await errorOf(startGeneration(deps, shop.id, input()))).code).toBe("NOT_FOUND");

    await db.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } });
    expect((await errorOf(startGeneration(deps, shop.id, input()))).code).toBe("NOT_FOUND");
  });
});

describe("spend limits, counted in MySQL", () => {
  it("allows one running generation per shop, and another shop is unaffected", async () => {
    const running = await startGeneration(deps, shop.id, input());
    const error = await errorOf(startGeneration(deps, shop.id, input()));
    expect(error).toMatchObject({ code: "LIMIT", message: expect.stringMatching(/still running/) });

    const elsewhere = await startGeneration(deps, otherShop.id, input({ productId: otherProduct.id }));
    expect(elsewhere.created).toBe(true);
    await Promise.all([running.run!(), elsewhere.run!()]);
    expect((await startGeneration(deps, shop.id, input())).created).toBe(true);
  });

  it("lets only one of two simultaneous different requests through", async () => {
    const results = await Promise.allSettled([
      startGeneration(deps, shop.id, input()),
      startGeneration(deps, shop.id, input()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.aiGenerationJob.count({ where: { shopId: shop.id } })).toBe(1);
  });

  it("stops at the daily limit, counting failed attempts too", async () => {
    generate.mockRejectedValueOnce(new AiProviderError("RATE_LIMITED", "429", true));
    for (let i = 0; i < 3; i++) {
      const started = await startGeneration(deps, shop.id, input());
      await started.run!();
    }
    const error = await errorOf(startGeneration(deps, shop.id, input()));
    expect(error).toMatchObject({ code: "LIMIT", message: expect.stringMatching(/Daily/) });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("releases the slot of a job that was lost with its process", async () => {
    const lost = await startGeneration(deps, shop.id, input()); // run() is never called
    await db.aiGenerationJob.update({
      where: { id: lost.job.id },
      data: { createdAt: new Date(Date.now() - JOB_ABANDON_MS - 1000) },
    });
    const next = await startGeneration(deps, shop.id, input());
    expect(next.created).toBe(true);
    expect(await getJob(shop.id, lost.job.id)).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Abandoned/) });

    await lost.run!(); // the lost process wakes up late: it must not run or overwrite anything
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("logging", () => {
  it("logs identifiers only: no context, no description, no image URL", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
    }
    const started = await startGeneration(deps, shop.id, input({ merchantContext: "SECRET LAUNCH PLAN" }));
    await started.run!();
    vi.restoreAllMocks();
    const all = lines.join("\n");
    expect(all).toContain('"event":"ai.job_created"');
    expect(all).toContain('"event":"ai.job_succeeded"');
    expect(all).toContain(`"jobId":${started.job.id}`);
    for (const secret of ["SECRET LAUNCH PLAN", "cdn.shopify.com", "warm beanie", "Old description", "sk-test"]) {
      expect(all).not.toContain(secret);
    }
  });
});
