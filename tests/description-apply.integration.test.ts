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
import { createApiKey } from "../app/services/api-key.server";
import { resetRateLimitsForTests } from "../app/services/api.server";
import { APPLY_ABANDON_MS } from "../app/services/generation-state";
import * as createRoute from "../app/routes/api.v1.products.$id.description-generations";
import * as jobRoute from "../app/routes/api.v1.description-generations.$jobId";
import * as applyRoute from "../app/routes/api.v1.description-generations.$jobId.apply";
import * as versionsRoute from "../app/routes/api.v1.products.$id.description-versions";
import * as restoreRoute from "../app/routes/api.v1.products.$id.description-versions.$versionId.restore";
import * as publishRoute from "../app/routes/api.v1.products.$id.publish";
import * as adminRoute from "../app/routes/app.products.$id_.generation";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error("Run through npm run test:integration with a dedicated test database");
}

/**
 * Writes to Shopify are the subject here, so the GraphQL fake is a small in-memory store:
 * ProductForDescription reads it, productUpdate changes it, publishablePublish records it.
 * Everything else (routes, services, repositories, MySQL) is real.
 */
const IMG1 = "gid://shopify/MediaImage/201";
const PUB_ONLINE = "gid://shopify/Publication/11";
const PUB_POS = "gid://shopify/Publication/12";
const ALL_SCOPES = "read_products,write_products,read_publications,write_publications";

type Remote = { descriptionHtml: string; updatedAt: string; status: string; published: Set<string> };
const remote = new Map<string, Remote>();
const remoteOf = (gid: string) => {
  if (!remote.has(gid)) remote.set(gid, { descriptionHtml: "<p>Old</p>", updatedAt: "2026-09-21T10:00:00Z", status: "ACTIVE", published: new Set() });
  return remote.get(gid)!;
};
let updateUserErrors: Array<{ field: string[] | null; message: string }> = [];
let publishUserErrors: Array<{ field: string[] | null; message: string }> = [];
let updateFailure: Response | null = null;
const calls: string[] = [];

const graphql = vi.fn(async (doc: string, opts?: { variables?: Record<string, unknown> }) => {
  const vars = opts?.variables ?? {};
  const reply = (data: unknown) => new Response(JSON.stringify({ data }));
  if (doc.includes("query ProductForDescription")) {
    calls.push("read");
    const r = remoteOf(vars.id as string);
    return reply({
      product: {
        id: vars.id, title: "Blue Beanie", descriptionHtml: r.descriptionHtml, updatedAt: r.updatedAt,
        vendor: "Acme", productType: "Hats", tags: [], status: r.status,
        media: { nodes: [{ id: IMG1, alt: null, mediaContentType: "IMAGE", status: "READY", image: { url: "https://cdn.shopify.com/0.jpg", width: 10, height: 10 } }] },
      },
    });
  }
  if (doc.includes("mutation ProductDescriptionUpdate")) {
    calls.push("update");
    if (updateFailure) return updateFailure;
    const input = vars.product as { id: string; descriptionHtml: string };
    if (updateUserErrors.length) return reply({ productUpdate: { product: null, userErrors: updateUserErrors } });
    const r = remoteOf(input.id);
    // Shopify normalizes HTML a little; mimic that so tests prove we store what Shopify stored.
    r.descriptionHtml = input.descriptionHtml.trim();
    r.updatedAt = new Date(Date.parse(r.updatedAt) + 60_000).toISOString();
    return reply({ productUpdate: { product: { id: input.id, descriptionHtml: r.descriptionHtml, updatedAt: r.updatedAt, status: r.status }, userErrors: [] } });
  }
  if (doc.includes("query PublicationsForPublish")) {
    calls.push("publications");
    const r = remoteOf(vars.productId as string);
    return reply({
      publications: { nodes: [{ id: PUB_ONLINE, catalog: { id: "gid://shopify/AppCatalog/1", title: "Online Store" } }, { id: PUB_POS, catalog: { id: "gid://shopify/AppCatalog/2", title: "Point of Sale" } }] },
      product: { id: vars.productId, status: r.status, resourcePublications: { nodes: [...r.published].map((id) => ({ publication: { id }, isPublished: true })) } },
    });
  }
  if (doc.includes("mutation PublishProduct")) {
    calls.push("publish");
    if (publishUserErrors.length) return reply({ publishablePublish: { publishable: null, userErrors: publishUserErrors } });
    const r = remoteOf(vars.id as string);
    for (const p of vars.input as Array<{ publicationId: string }>) r.published.add(p.publicationId);
    return reply({ publishablePublish: { publishable: { id: vars.id, status: r.status }, userErrors: [] } });
  }
  throw new Error(`unexpected document: ${doc.slice(0, 60)}`);
});

const answer = { descriptionHtml: "<p>New AI text</p>", shortDescription: "s", seoTitle: "t", seoDescription: "d", highlights: [], warnings: [] };

const shops: number[] = [];
let shopA: Shop;
let shopB: Shop;
let keyA: string;
let keyB: string;
let productA: { local: number; shopify: number; gid: string };
let nextId = Math.floor(Date.now() / 10) + 900_000;

const makeShop = async (scopes = ALL_SCOPES) => {
  const shop = await db.shop.create({ data: { shopDomain: `apply-${randomUUID()}.myshopify.com`, scopes } });
  shops.push(shop.id);
  return shop;
};
const makeProduct = async (shop: Shop) => {
  const id = ++nextId;
  const gid = `gid://shopify/Product/${id}`;
  const row = await db.product.create({
    data: { shopId: shop.id, shopifyProductGid: gid, title: "Blue Beanie", handle: `h-${id}`, status: "ACTIVE", updatedAtShopify: new Date("2026-09-21T10:00:00Z"), syncedAt: new Date() },
  });
  return { local: row.id, shopify: id, gid };
};

type Handler = (args: never) => Promise<unknown> | unknown;
const api = (handler: Handler, method: string, path: string, opts: { key?: string | null; body?: unknown; params?: Record<string, string>; idempotencyKey?: string } = {}) => {
  const headers: Record<string, string> = { "x-forwarded-for": "203.0.113.9" };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? keyA}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  const request = new Request(`https://app.example.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return handler({ request, params: opts.params ?? {}, context: {} } as never) as Promise<Response>;
};
const apply = (jobId: number | string, key?: string | null) =>
  api(applyRoute.action, "POST", `/api/v1/description-generations/${jobId}/apply`, { key, params: { jobId: String(jobId) } });
const versions = (p = productA, key?: string) =>
  api(versionsRoute.loader, "GET", `/api/v1/products/${p.shopify}/description-versions`, { key, params: { id: String(p.shopify) } });
const restore = (versionId: number, body?: unknown, p = productA, key?: string) =>
  api(restoreRoute.action, "POST", `/api/v1/products/${p.shopify}/description-versions/${versionId}/restore`, { key, body, params: { id: String(p.shopify), versionId: String(versionId) } });
const publish = (body: unknown, p = productA, key?: string) =>
  api(publishRoute.action, "POST", `/api/v1/products/${p.shopify}/publish`, { key, body, params: { id: String(p.shopify) } });
const channels = (p = productA) =>
  api(publishRoute.loader, "GET", `/api/v1/products/${p.shopify}/publish`, { params: { id: String(p.shopify) } });

/** Generate + wait + approve through the real routes, so Apply starts from a real APPROVED job. */
const approvedJob = async (product = productA, key = keyA) => {
  const res = await api(createRoute.action, "POST", `/api/v1/products/${product.shopify}/description-generations`, {
    key, body: { mediaIds: [IMG1] }, params: { id: String(product.shopify) }, idempotencyKey: randomUUID(),
  });
  expect(res.status).toBe(202);
  const { data } = await res.json();
  for (let i = 0; i < 100; i++) {
    const { data: job } = await (await api(jobRoute.loader, "GET", `/api/v1/description-generations/${data.id}`, { key, params: { jobId: String(data.id) } })).json();
    if (job.status === "SUCCEEDED") break;
    if (job.status === "FAILED") throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 20));
  }
  await db.aiGenerationJob.update({ where: { id: data.id }, data: { reviewStatus: "APPROVED", reviewedAt: new Date() } });
  calls.length = 0; // the generation's own product read is not what these tests count
  return data.id as number;
};

beforeEach(async () => {
  resetRateLimitsForTests();
  graphql.mockClear();
  calls.length = 0;
  remote.clear();
  updateUserErrors = [];
  publishUserErrors = [];
  updateFailure = null;
  generateMock.mockReset();
  generateMock.mockImplementation(async () => ({ content: JSON.stringify(answer), generationId: "g", model: "vendor/vision:free", promptTokens: 1, completionTokens: 1, cost: 0, latencyMs: 5 }));
  adminMock.mockReset();
  adminMock.mockImplementation(async () => ({ admin: { graphql } }));
  process.env.OPENROUTER_API_KEY = "sk-test-key";
  process.env.OPENROUTER_MODELS = "vendor/vision:free";
  shopA = await makeShop();
  shopB = await makeShop();
  keyA = (await createApiKey(shopA.id, "a")).plaintext;
  keyB = (await createApiKey(shopB.id, "b")).plaintext;
  productA = await makeProduct(shopA);
});

afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("POST /api/v1/description-generations/{id}/apply", () => {
  it("writes the approved draft to Shopify, records a version with before/after, marks the job APPLIED", async () => {
    const jobId = await approvedJob();
    const res = await apply(jobId);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ source: "AI", generationId: jobId, descriptionHtml: "<p>New AI text</p>", previousDescriptionHtml: "<p>Old</p>", restoredFromVersionId: null });
    expect(data.appliedBy).toMatch(/^api-key:/);
    expect(remoteOf(productA.gid).descriptionHtml).toBe("<p>New AI text</p>");
    expect(calls).toEqual(["read", "update"]); // one stale check, one mutation, nothing else

    const job = await db.aiGenerationJob.findUnique({ where: { id: jobId } });
    expect(job).toMatchObject({ reviewStatus: "APPLIED", error: null });
    const product = await db.product.findUnique({ where: { id: productA.local } });
    expect(product!.updatedAtShopify.toISOString()).toBe(remoteOf(productA.gid).updatedAt);

    const list = await (await versions()).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(data.id);
  });

  it("applies once: a second call is 409, a job that is not approved is 409", async () => {
    const jobId = await approvedJob();
    expect((await apply(jobId)).status).toBe(201);
    const again = await apply(jobId);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/already applied/) });
    expect(calls.filter((c) => c === "update")).toHaveLength(1);

    await db.aiGenerationJob.update({ where: { id: jobId }, data: { reviewStatus: "DRAFT" } });
    expect((await apply(jobId)).status).toBe(409);
  });

  it("two simultaneous applies write exactly once", async () => {
    const jobId = await approvedJob();
    const results = await Promise.all([apply(jobId), apply(jobId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(calls.filter((c) => c === "update")).toHaveLength(1);
    expect(await db.productDescriptionVersion.count({ where: { jobId } })).toBe(1);
  });

  it("refuses a stale product (409 stale_product) and leaves the job APPROVED with the reason", async () => {
    const jobId = await approvedJob();
    remoteOf(productA.gid).descriptionHtml = "<p>Edited by a colleague</p>";
    const res = await apply(jobId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "stale_product" });
    expect(calls).toEqual(["read"]); // never reached the mutation
    expect(remoteOf(productA.gid).descriptionHtml).toBe("<p>Edited by a colleague</p>");
    expect(await db.aiGenerationJob.findUnique({ where: { id: jobId } })).toMatchObject({ reviewStatus: "APPROVED", error: expect.stringMatching(/changed in Shopify/) });
    expect(await db.productDescriptionVersion.count({ where: { jobId } })).toBe(0);
  });

  it("is not stale when Shopify already holds our text (retry after an interrupted apply)", async () => {
    const jobId = await approvedJob();
    remoteOf(productA.gid).descriptionHtml = "<p>New AI text</p>";
    expect((await apply(jobId)).status).toBe(201);
  });

  it("surfaces Shopify userErrors as 422 and keeps the job retryable", async () => {
    const jobId = await approvedJob();
    updateUserErrors = [{ field: ["descriptionHtml"], message: "is too long" }];
    const res = await apply(jobId);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "shopify_rejected", details: { descriptionHtml: "is too long" } });
    expect(await db.aiGenerationJob.findUnique({ where: { id: jobId } })).toMatchObject({ reviewStatus: "APPROVED" });
    expect(await db.productDescriptionVersion.count({ where: { jobId } })).toBe(0);
  });

  it("a transport failure returns 500, leaves no version, and Apply can be retried", async () => {
    const jobId = await approvedJob();
    updateFailure = new Response("nope", { status: 500 });
    expect((await apply(jobId)).status).toBe(500);
    expect(await db.aiGenerationJob.findUnique({ where: { id: jobId } })).toMatchObject({ reviewStatus: "APPROVED" });
    updateFailure = null;
    expect((await apply(jobId)).status).toBe(201);
  });

  it("recovers a job stuck in APPLYING after the abandon window", async () => {
    const jobId = await approvedJob();
    await db.aiGenerationJob.update({ where: { id: jobId }, data: { reviewStatus: "APPLYING", reviewedAt: new Date(Date.now() - APPLY_ABANDON_MS - 1000) } });
    expect((await apply(jobId)).status).toBe(201);
    await db.aiGenerationJob.update({ where: { id: (await approvedJob()) }, data: { reviewStatus: "APPLYING", reviewedAt: new Date() } });
  });

  it("refuses when the shop has not granted write_products (403), without touching Shopify", async () => {
    await db.shop.update({ where: { id: shopA.id }, data: { scopes: "read_products" } });
    const jobId = await approvedJob();
    const res = await apply(jobId);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("missing_scope");
    expect(calls.filter((c) => c !== "read")).toEqual([]);
  });

  it("is tenant scoped: another shop's key gets 404 and no write", async () => {
    const jobId = await approvedJob();
    expect((await apply(jobId, keyB)).status).toBe(404);
    expect(calls).toEqual([]);
    expect((await apply(jobId, null)).status).toBe(401);
  });
});

describe("restore", () => {
  it("restores an older version's text through the same path and links the rows", async () => {
    const first = await (await apply(await approvedJob())).json();
    generateMock.mockImplementation(async () => ({ content: JSON.stringify({ ...answer, descriptionHtml: "<p>Second</p>" }), generationId: "g2", model: "vendor/vision:free", promptTokens: 1, completionTokens: 1, cost: 0, latencyMs: 5 }));
    const second = await (await apply(await approvedJob())).json();
    expect(remoteOf(productA.gid).descriptionHtml).toBe("<p>Second</p>");

    const res = await restore(first.data.id);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ source: "RESTORE", generationId: null, restoredFromVersionId: first.data.id, descriptionHtml: "<p>New AI text</p>", previousDescriptionHtml: "<p>Second</p>" });
    expect(remoteOf(productA.gid).descriptionHtml).toBe("<p>New AI text</p>");

    // "previous" brings back what the very first apply replaced: the merchant's original text.
    const original = await (await restore(first.data.id, { which: "previous" })).json();
    expect(original.data).toMatchObject({ descriptionHtml: "<p>Old</p>", restoredFromVersionId: first.data.id });
    expect(remoteOf(productA.gid).descriptionHtml).toBe("<p>Old</p>");

    const list = (await (await versions()).json()).data;
    expect(list.map((v: { id: number }) => v.id)).toEqual([original.data.id, data.id, second.data.id, first.data.id]);
    expect((await restore(first.data.id, { which: "sideways" })).status).toBe(422);
  });

  it("rejects unknown, other-shop and other-product versions with 404", async () => {
    const first = await (await apply(await approvedJob())).json();
    expect((await restore(first.data.id, undefined, productA, keyB)).status).toBe(404);
    const other = await makeProduct(shopA);
    expect((await restore(first.data.id, undefined, other)).status).toBe(404);
    expect((await restore(999_999_999)).status).toBe(404);
    expect(calls.filter((c) => c === "update")).toHaveLength(1);
  });
});

describe("publish", () => {
  it("lists channels with the product's state, publishes to one and audits it", async () => {
    const before = await (await channels()).json();
    expect(before.data).toMatchObject({ productStatus: "ACTIVE", publications: [{ id: PUB_ONLINE, name: "Online Store", published: false }, { id: PUB_POS, published: false }], history: [] });

    const res = await publish({ publicationId: PUB_ONLINE });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ publicationId: PUB_ONLINE });
    expect(remoteOf(productA.gid).published.has(PUB_ONLINE)).toBe(true);

    const after = await (await channels()).json();
    expect(after.data.publications[0]).toMatchObject({ published: true });
    expect(after.data.history[0]).toMatchObject({ status: "SUCCEEDED", publicationId: PUB_ONLINE, requestedBy: expect.stringMatching(/^api-key:/), userErrors: null });
  });

  it("requires an ACTIVE product (409), a known channel (422), and a well-formed id (422)", async () => {
    remoteOf(productA.gid).status = "DRAFT";
    const res = await publish({ publicationId: PUB_ONLINE });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/DRAFT/);
    remoteOf(productA.gid).status = "ACTIVE";
    expect((await publish({ publicationId: "gid://shopify/Publication/999" })).status).toBe(422);
    expect((await publish({ publicationId: "https://evil.test" })).status).toBe(422);
    expect(calls.filter((c) => c === "publish")).toEqual([]);
    expect(await db.publicationAction.count({ where: { shopId: shopA.id } })).toBe(0);
  });

  it("records Shopify userErrors as a FAILED action and answers 422", async () => {
    publishUserErrors = [{ field: ["id"], message: "Publishable not available" }];
    const res = await publish({ publicationId: PUB_POS });
    expect(res.status).toBe(422);
    const action = await db.publicationAction.findFirst({ where: { shopId: shopA.id } });
    expect(action).toMatchObject({ status: "FAILED", publicationGid: PUB_POS, userErrorsJson: publishUserErrors });
  });

  it("refuses without write_publications (403) and for another shop's product (404)", async () => {
    expect((await publish({ publicationId: PUB_ONLINE }, productA, keyB)).status).toBe(404);
    await db.shop.update({ where: { id: shopA.id }, data: { scopes: "read_products,write_products" } });
    expect((await publish({ publicationId: PUB_ONLINE })).status).toBe(403);
    expect((await channels()).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("admin resource route", () => {
  const act = (fields: Record<string, string>, productId = productA.local) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return adminRoute.action({
      request: new Request(`https://app.example.test/app/products/${productId}/generation`, { method: "POST", body: data }),
      params: { id: String(productId) },
      context: {},
    } as never);
  };

  it("apply, publish and restore through the admin page, with the shop as actor", async () => {
    authAdminMock.mockImplementation(async () => ({ session: { shop: shopA.shopDomain }, admin: { graphql } }));
    const jobId = await approvedJob();
    const applied = await act({ intent: "apply", jobId: String(jobId) });
    expect(applied).toMatchObject({ ok: true, job: { reviewStatus: "APPLIED" }, versions: [{ appliedBy: `admin:${shopA.shopDomain}` }] });

    const list = await adminRoute.loader({
      request: new Request(`https://app.example.test/app/products/${productA.local}/generation?publications=1`),
      params: { id: String(productA.local) },
      context: {},
    } as never);
    expect(list).toMatchObject({ productStatus: "ACTIVE", publications: [{ id: PUB_ONLINE }, { id: PUB_POS }] });
    expect(await act({ intent: "publish", publicationId: PUB_POS })).toMatchObject({ ok: true, published: { publicationId: PUB_POS } });

    const versionId = (applied as { versions: Array<{ id: number }> }).versions[0].id;
    const restored = await act({ intent: "restore", versionId: String(versionId), which: "previous" });
    expect(restored).toMatchObject({ ok: true, versions: [{ source: "RESTORE", descriptionHtml: "<p>Old</p>" }, { id: versionId }] });
  });

  it("returns a STALE code the page can react to", async () => {
    authAdminMock.mockImplementation(async () => ({ session: { shop: shopA.shopDomain }, admin: { graphql } }));
    const jobId = await approvedJob();
    remoteOf(productA.gid).descriptionHtml = "<p>changed</p>";
    expect(await act({ intent: "apply", jobId: String(jobId) })).toMatchObject({ ok: false, code: "STALE" });
  });
});
