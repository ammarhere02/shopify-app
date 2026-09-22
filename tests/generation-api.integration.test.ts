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
// Shopify and the model provider are the only fakes; routes, services and MySQL are real.
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: adminMock },
  authenticate: { admin: authAdminMock },
}));
vi.mock("../app/ai/openrouter-client.server", async (original) => ({
  ...(await original<typeof import("../app/ai/openrouter-client.server")>()),
  createOpenRouterClient: () => ({ generate: generateMock }),
}));

import db from "../app/db.server";
import { createApiKey } from "../app/services/api-key.server";
import { resetRateLimitsForTests } from "../app/services/api.server";
import * as createRoute from "../app/routes/api.v1.products.$id.description-generations";
import * as imagesRoute from "../app/routes/api.v1.products.$id.images";
import * as jobRoute from "../app/routes/api.v1.description-generations.$jobId";
import * as regenerateRoute from "../app/routes/api.v1.description-generations.$jobId.regenerate";
import * as adminRoute from "../app/routes/app.products.$id_.generation";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error("Run through npm run test:integration with a dedicated test database");
}

const IMG1 = "gid://shopify/MediaImage/201";
const IMG2 = "gid://shopify/MediaImage/202";
const answer = {
  descriptionHtml: '<p onclick="x">A warm beanie.</p><script>alert(1)</script>',
  shortDescription: "A warm beanie.",
  seoTitle: "Blue Beanie",
  seoDescription: "A warm blue beanie.",
  highlights: ["Warm"],
  warnings: [],
};

const shops: number[] = [];
let shopA: Shop;
let shopB: Shop;
let keyA: string;
let keyB: string;
let productA: { local: number; shopify: number };
let productB: { local: number; shopify: number };
let nextId = Math.floor(Date.now() / 10) + 700_000;

const makeShop = async () => {
  const shop = await db.shop.create({ data: { shopDomain: `genapi-${randomUUID()}.myshopify.com` } });
  shops.push(shop.id);
  return shop;
};
const makeProduct = async (shop: Shop) => {
  const id = ++nextId;
  const row = await db.product.create({
    data: {
      shopId: shop.id,
      shopifyProductGid: `gid://shopify/Product/${id}`,
      title: "Blue Beanie",
      handle: `h-${id}`,
      status: "ACTIVE",
      updatedAtShopify: new Date(),
      syncedAt: new Date(),
    },
  });
  return { local: row.id, shopify: id };
};
/** What `admin.graphql` returns for ProductForDescription. */
const graphql = vi.fn(async (_doc: string, opts?: { variables?: Record<string, unknown> }) =>
  new Response(
    JSON.stringify({
      data: {
        product: {
          id: opts?.variables?.id,
          title: "Blue Beanie",
          descriptionHtml: "<p>Old</p>",
          updatedAt: "2026-09-21T10:00:00Z",
          vendor: "Acme",
          productType: "Hats",
          tags: [],
          status: "ACTIVE",
          media: {
            nodes: [IMG1, IMG2].map((id, i) => ({
              id,
              alt: null,
              mediaContentType: "IMAGE",
              status: "READY",
              image: { url: `https://cdn.shopify.com/${i}.jpg`, width: 1024, height: 1024 },
            })),
          },
        },
      },
    }),
  ),
);

type Handler = (args: never) => Promise<unknown> | unknown;
const api = (
  handler: Handler,
  method: string,
  path: string,
  opts: { key?: string | null; body?: unknown; params?: Record<string, string>; idempotencyKey?: string } = {},
) => {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.9" };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? keyA}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  const request = new Request(`https://app.example.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return handler({ request, params: opts.params ?? {}, context: {} } as never) as Promise<Response>;
};
const create = (product: { shopify: number }, body: unknown, opts: { key?: string | null; idempotencyKey?: string } = {}) =>
  api(createRoute.action, "POST", `/api/v1/products/${product.shopify}/description-generations`, {
    body,
    params: { id: String(product.shopify) },
    idempotencyKey: opts.idempotencyKey ?? randomUUID(),
    key: opts.key,
  });
const getJob = (id: number | string, key?: string) =>
  api(jobRoute.loader, "GET", `/api/v1/description-generations/${id}`, { key, params: { jobId: String(id) } });
/** The run is not awaited by the route, so tests poll like a real client. */
const waitUntilFinished = async (id: number) => {
  for (let i = 0; i < 100; i++) {
    const { data } = await (await getJob(id)).json();
    if (data.status === "SUCCEEDED" || data.status === "FAILED") return data;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("generation did not finish");
};

beforeEach(async () => {
  resetRateLimitsForTests();
  graphql.mockClear();
  generateMock.mockReset();
  generateMock.mockImplementation(async () => ({
    content: JSON.stringify(answer),
    generationId: "gen-9",
    model: "vendor/vision:free",
    promptTokens: 700,
    completionTokens: 150,
    cost: 0,
    latencyMs: 900,
  }));
  adminMock.mockReset();
  adminMock.mockImplementation(async () => ({ admin: { graphql } }));
  process.env.OPENROUTER_API_KEY = "sk-test-key";
  process.env.OPENROUTER_MODELS = "vendor/vision:free";
  shopA = await makeShop();
  shopB = await makeShop();
  keyA = (await createApiKey(shopA.id, "A")).plaintext;
  keyB = (await createApiKey(shopB.id, "B")).plaintext;
  productA = await makeProduct(shopA);
  productB = await makeProduct(shopB);
});
afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("POST /api/v1/products/{id}/description-generations", () => {
  it("answers 202 with Location, then the job finishes with a sanitized draft and usage", async () => {
    const res = await create(productA, { mediaIds: [IMG1], merchantContext: "For skiers" });
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(res.headers.get("location")).toBe(`/api/v1/description-generations/${data.id}`);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(["QUEUED", "RUNNING", "SUCCEEDED"]).toContain(data.status);

    const done = await waitUntilFinished(data.id);
    expect(done).toMatchObject({
      status: "SUCCEEDED",
      reviewStatus: "DRAFT",
      draftHtml: "<p>A warm beanie.</p>",
      model: "vendor/vision:free",
      input: { mediaIds: [IMG1], merchantContext: "For skiers", imageCount: 1 },
      usage: { promptTokens: 700, completionTokens: 150, estimatedCostUsd: 0, latencyMs: 900, generationId: "gen-9" },
      error: null,
    });
    expect(done.generated.seoTitle).toBe("Blue Beanie");
    // The raw answer, the snapshot and the key never appear in a response.
    const text = JSON.stringify(done);
    for (const hidden of ["<script", "alert(1)", "onclick", "rawJson", "productSnapshot", "sk-test-key"]) expect(text).not.toContain(hidden);
  });

  it("is idempotent: the same key returns 200 with the same job and one model call", async () => {
    const key = randomUUID();
    const first = await create(productA, { mediaIds: [IMG1] }, { idempotencyKey: key });
    const id = (await first.json()).data.id;
    await waitUntilFinished(id);
    const second = await create(productA, { mediaIds: [IMG2], merchantContext: "different" }, { idempotencyKey: key });
    expect(second.status).toBe(200);
    expect((await second.json()).data.id).toBe(id);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("requires an API key and gives the standard 401 envelope", async () => {
    const res = await create(productA, { mediaIds: [IMG1] }, { key: null });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatchObject({ code: "unauthorized", requestId: expect.any(String) });
    expect(await db.aiGenerationJob.count({ where: { shopId: shopA.id } })).toBe(0);
  });

  it("treats another shop's product as not found", async () => {
    const res = await create(productB, { mediaIds: [IMG1] }); // key A, product of shop B
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("product_not_found");
    expect(graphql).not.toHaveBeenCalled();
  });

  it.each([
    ["no images", { mediaIds: [] }, "mediaIds"],
    ["a URL instead of a media id", { mediaIds: ["https://evil.test/a.jpg"] }, "mediaIds"],
    ["five images", { mediaIds: [1, 2, 3, 4, 5].map((n) => `gid://shopify/MediaImage/${n}`) }, "mediaIds"],
    ["an image of another product", { mediaIds: ["gid://shopify/MediaImage/999"] }, "mediaIds"],
    ["oversized context", { mediaIds: [IMG1], merchantContext: "x".repeat(2001) }, "merchantContext"],
    ["context that is not text", { mediaIds: [IMG1], merchantContext: { a: 1 } }, "merchantContext"],
    ["a model outside the allowlist", { mediaIds: [IMG1], model: "vendor/expensive" }, "model"],
  ])("422 for %s, nothing stored, model not called", async (_label, body, field) => {
    const res = await create(productA, body);
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("validation_failed");
    expect(error.details).toHaveProperty(field);
    expect(generateMock).not.toHaveBeenCalled();
    expect(await db.aiGenerationJob.count({ where: { shopId: shopA.id } })).toBe(0);
  });

  it("422 without an idempotency key, 400 for a body that is not an object, 413 for a huge body", async () => {
    const noKey = await api(createRoute.action, "POST", "/x", { body: { mediaIds: [IMG1] }, params: { id: String(productA.shopify) } });
    expect(noKey.status).toBe(422);
    expect((await noKey.json()).error.details).toHaveProperty("idempotencyKey");
    expect((await create(productA, [IMG1])).status).toBe(400);
    expect((await create(productA, { mediaIds: [IMG1], merchantContext: "x".repeat(20_000) })).status).toBe(413);
  });

  it("429 while another generation of the shop is still running", async () => {
    let release = () => undefined as void;
    generateMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ content: JSON.stringify(answer), generationId: null, model: "m", promptTokens: null, completionTokens: null, cost: null, latencyMs: 1 }))),
    );
    const first = await create(productA, { mediaIds: [IMG1] });
    const second = await create(productA, { mediaIds: [IMG1] });
    expect(second.status).toBe(429);
    expect((await second.json()).error.code).toBe("generation_limit_reached");
    release();
    await waitUntilFinished((await first.json()).data.id);
  });

  it("503 when the server has no OpenRouter configuration, 409 without a Shopify session", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const unconfigured = await create(productA, { mediaIds: [IMG1] });
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()).error.code).toBe("ai_not_configured");

    process.env.OPENROUTER_API_KEY = "sk-test-key";
    adminMock.mockRejectedValueOnce(new Error("no session"));
    const noSession = await create(productA, { mediaIds: [IMG1] });
    expect(noSession.status).toBe(409);
    expect((await noSession.json()).error.code).toBe("shop_session_unavailable");
  });

  it("reports a failed generation through GET, with a diagnosable error", async () => {
    generateMock.mockResolvedValueOnce({ content: "I cannot do that", generationId: null, model: "m", promptTokens: null, completionTokens: null, cost: null, latencyMs: 5 });
    const res = await create(productA, { mediaIds: [IMG1] });
    const done = await waitUntilFinished((await res.json()).data.id);
    expect(done).toMatchObject({ status: "FAILED", reviewStatus: null, draftHtml: null, generated: null, usage: null });
    expect(done.error).toMatch(/^INVALID_OUTPUT: .*Model said: I cannot do that/);
  });
});

describe("GET /api/v1/description-generations/{jobId} and the product's lists", () => {
  it("hides a job from another shop and rejects malformed ids", async () => {
    const id = (await (await create(productA, { mediaIds: [IMG1] })).json()).data.id;
    await waitUntilFinished(id);
    expect((await getJob(id, keyB)).status).toBe(404);
    expect((await getJob("abc")).status).toBe(404);
    expect((await getJob(id, "eh_live_wrong")).status).toBe(401);
  });

  it("lists a product's generations newest first and the images it may use", async () => {
    const first = (await (await create(productA, { mediaIds: [IMG1] })).json()).data.id;
    await waitUntilFinished(first);
    const second = (await (await create(productA, { mediaIds: [IMG2] })).json()).data.id;
    await waitUntilFinished(second);

    const list = await api(createRoute.loader, "GET", "/x", { params: { id: String(productA.shopify) } });
    expect((await list.json()).data.map((j: { id: number }) => j.id)).toEqual([second, first]);
    const foreign = await api(createRoute.loader, "GET", "/x", { key: keyB, params: { id: String(productA.shopify) } });
    expect(foreign.status).toBe(404);

    const images = await api(imagesRoute.loader, "GET", "/x", { params: { id: String(productA.shopify) } });
    expect((await images.json()).data).toEqual([
      { id: IMG1, url: "https://cdn.shopify.com/0.jpg", alt: null },
      { id: IMG2, url: "https://cdn.shopify.com/1.jpg", alt: null },
    ]);
  });
});

describe("POST /api/v1/description-generations/{jobId}/regenerate", () => {
  const regen = (id: number | string, body?: unknown, key?: string, idempotencyKey: string = randomUUID()) =>
    api(regenerateRoute.action, "POST", `/x`, { key, body, params: { jobId: String(id) }, idempotencyKey });

  it("creates a new linked job that reuses the previous input, and keeps the old one", async () => {
    const first = (await (await create(productA, { mediaIds: [IMG1], merchantContext: "For skiers" })).json()).data.id;
    await waitUntilFinished(first);

    const res = await regen(first);
    expect(res.status).toBe(202);
    const second = (await res.json()).data;
    expect(second).toMatchObject({ previousGenerationId: first, input: { mediaIds: [IMG1], merchantContext: "For skiers" } });
    expect(second.id).not.toBe(first);
    await waitUntilFinished(second.id);

    const overridden = (await (await regen(second.id, { mediaIds: [IMG2], merchantContext: null })).json()).data;
    expect(overridden.input).toMatchObject({ mediaIds: [IMG2], merchantContext: null });
    await waitUntilFinished(overridden.id);
    expect((await (await getJob(first)).json()).data.status).toBe("SUCCEEDED");
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("404 for another shop's job, 409 while the job is still running, idempotent on the key", async () => {
    const id = (await (await create(productA, { mediaIds: [IMG1] })).json()).data.id;
    await waitUntilFinished(id);
    expect((await regen(id, undefined, keyB)).status).toBe(404);

    const key = randomUUID();
    const a = await regen(id, undefined, undefined, key);
    const newId = (await a.json()).data.id;
    const b = await regen(id, undefined, undefined, key);
    expect(b.status).toBe(200);
    expect((await b.json()).data.id).toBe(newId);
    await waitUntilFinished(newId);

    await db.aiGenerationJob.update({ where: { id: newId }, data: { status: "RUNNING", startedAt: new Date() } });
    const running = await regen(newId);
    expect(running.status).toBe(409);
    expect((await running.json()).error.code).toBe("invalid_state");
  });
});

describe("admin page route (session instead of API key)", () => {
  const form = (fields: Record<string, string | string[]>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      for (const v of Array.isArray(value) ? value : [value]) data.append(name, v);
    }
    return data;
  };
  const act = (productId: number, fields: Record<string, string | string[]>) =>
    adminRoute.action({
      request: new Request(`https://app.example.test/app/products/${productId}/generation`, { method: "POST", body: form(fields) }),
      params: { id: String(productId) },
      context: {},
    } as never);
  const load = (productId: number, jobId: number) =>
    adminRoute.loader({
      request: new Request(`https://app.example.test/app/products/${productId}/generation?jobId=${jobId}`),
      params: { id: String(productId) },
      context: {},
    } as never);
  /** Narrow an action result to its job: the intents used here always return one. */
  const jobOf = (result: Awaited<ReturnType<typeof act>>) => {
    if (!result.ok) throw new Error(result.message);
    if (!result.job) throw new Error("no job in result");
    return result.job;
  };
  const finished = async (productId: number, jobId: number) => {
    for (let i = 0; i < 100; i++) {
      const data = await load(productId, jobId);
      if (!("job" in data)) throw new Error("expected a job");
      const { job } = data;
      if (job.status === "SUCCEEDED" || job.status === "FAILED") return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("generation did not finish");
  };

  beforeEach(() => {
    authAdminMock.mockReset();
    authAdminMock.mockImplementation(async () => ({ session: { shop: shopA.shopDomain }, admin: { graphql } }));
  });

  it("generate → poll → edit (sanitized) → approve → reopen → reject", async () => {
    const started = await act(productA.local, { intent: "generate", idempotencyKey: randomUUID(), mediaIds: [IMG1, IMG2], merchantContext: "For skiers" });
    const jobId = jobOf(started).id;
    expect(await finished(productA.local, jobId)).toMatchObject({ status: "SUCCEEDED", reviewStatus: "DRAFT", draftHtml: "<p>A warm beanie.</p>" });

    const saved = await act(productA.local, { intent: "saveDraft", jobId: String(jobId), descriptionHtml: '<p>Edited</p><img src=x onerror=alert(1)><a href="https://x.test">link</a>' });
    expect(saved).toMatchObject({ ok: true, job: { draftHtml: "<p>Edited</p>link", reviewStatus: "DRAFT" } });
    // The model's own text is untouched by the edit.
    expect(jobOf(saved).generated?.descriptionHtml).toBe("<p>A warm beanie.</p>");

    const approved = await act(productA.local, { intent: "approve", jobId: String(jobId), descriptionHtml: "<p>Final text</p>" });
    expect(approved).toMatchObject({ ok: true, job: { reviewStatus: "APPROVED", draftHtml: "<p>Final text</p>" } });
    expect(await act(productA.local, { intent: "saveDraft", jobId: String(jobId), descriptionHtml: "<p>late</p>" })).toMatchObject({ ok: false, message: "Only a draft can be edited" });

    expect(await act(productA.local, { intent: "reopen", jobId: String(jobId) })).toMatchObject({ ok: true, job: { reviewStatus: "DRAFT" } });
    expect(await act(productA.local, { intent: "reject", jobId: String(jobId) })).toMatchObject({ ok: true, job: { reviewStatus: "REJECTED" } });
    expect(await act(productA.local, { intent: "approve", jobId: String(jobId) })).toMatchObject({ ok: false });
    expect(graphql).toHaveBeenCalledTimes(1); // reviewing never talks to Shopify
  });

  it("returns field errors instead of throwing, and rejects an empty or oversized draft", async () => {
    expect(await act(productA.local, { intent: "generate", idempotencyKey: randomUUID() })).toMatchObject({ ok: false, errors: { mediaIds: expect.any(String) } });

    const started = jobOf(await act(productA.local, { intent: "generate", idempotencyKey: randomUUID(), mediaIds: [IMG1] }));
    await finished(productA.local, started.id);
    const jobId = String(started.id);
    expect(await act(productA.local, { intent: "saveDraft", jobId, descriptionHtml: "<script>x</script>" })).toMatchObject({ ok: false, errors: { descriptionHtml: "The description is empty" } });
    expect(await act(productA.local, { intent: "saveDraft", jobId, descriptionHtml: "x".repeat(10_001) })).toMatchObject({ ok: false, errors: { descriptionHtml: expect.stringMatching(/at most/) } });
  });

  it("cannot reach another shop's job, or a job through the wrong product", async () => {
    const started = jobOf(await act(productA.local, { intent: "generate", idempotencyKey: randomUUID(), mediaIds: [IMG1] }));
    await finished(productA.local, started.id);
    const otherProduct = await makeProduct(shopA);
    expect(await act(otherProduct.local, { intent: "reject", jobId: String(started.id) })).toMatchObject({ ok: false, message: "Generation not found" });
    await expect(load(otherProduct.local, started.id)).rejects.toMatchObject({ status: 404 });

    authAdminMock.mockImplementation(async () => ({ session: { shop: shopB.shopDomain }, admin: { graphql } }));
    expect(await act(productB.local, { intent: "reject", jobId: String(started.id) })).toMatchObject({ ok: false, message: "Generation not found" });
    await expect(load(productA.local, started.id)).rejects.toMatchObject({ status: 404 });
  });

  it("says so when the server is not configured, without an error page", async () => {
    delete process.env.OPENROUTER_MODELS;
    expect(await act(productA.local, { intent: "generate", idempotencyKey: randomUUID(), mediaIds: [IMG1] })).toMatchObject({
      ok: false,
      message: "AI generation is not configured on this server.",
    });
  });
});
