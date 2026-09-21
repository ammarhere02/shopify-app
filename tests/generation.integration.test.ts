import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Product, Shop } from "@prisma/client";
import db from "../app/db.server";
import {
  completeJob,
  countActiveJobs,
  countJobsSince,
  createJob,
  failAbandonedJobs,
  failJob,
  getJob,
  listJobsForProduct,
  markJobRunning,
  moveReviewStatus,
  saveDraft,
} from "../app/repositories/ai-generation.server";
import type { NewJobInput } from "../app/repositories/ai-generation.server";
import {
  createVersion,
  getVersion,
  listVersions,
} from "../app/repositories/description-version.server";
import {
  completePublicationAction,
  createPublicationAction,
  listPublicationActions,
} from "../app/repositories/publication-action.server";
import { JOB_ABANDON_MS } from "../app/services/generation-state";

const parsed = new URL(process.env.DATABASE_URL!);
if (!parsed.pathname.endsWith("_test") || process.env.RUN_MYSQL_TESTS !== "1") {
  throw new Error(
    "Run through npm run test:integration with a dedicated test database",
  );
}

const shops: number[] = [];
let shopA: Shop;
let shopB: Shop;
let productA: Product;
let productB: Product;
let gid = Math.floor(Date.now() / 10);

const makeShop = async () => {
  const shop = await db.shop.create({
    data: { shopDomain: `generation-${randomUUID()}.myshopify.com` },
  });
  shops.push(shop.id);
  return shop;
};
const makeProduct = (shopId: number) =>
  db.product.create({
    data: {
      shopId,
      shopifyProductGid: `gid://shopify/Product/${++gid}`,
      title: "Board",
      handle: `h-${gid}`,
      status: "ACTIVE",
      updatedAtShopify: new Date(),
      syncedAt: new Date(),
    },
  });
const jobInput = (productId: number, overrides: Partial<NewJobInput> = {}): NewJobInput => ({
  productId,
  idempotencyKey: randomUUID(),
  provider: "openrouter",
  model: "vendor/model",
  promptVersion: "v1",
  inputHash: "a".repeat(64),
  selectedMediaIds: ["gid://shopify/MediaImage/1", "gid://shopify/MediaImage/2"],
  productSnapshot: { title: "Board", descriptionHash: "b".repeat(64) },
  merchantContext: "For beginners",
  ...overrides,
});
const output = {
  rawJson: { descriptionHtml: "<p>Raw</p><script>x</script>" },
  validatedJson: { descriptionHtml: "<p>Raw</p>" },
  warnings: ["Unverified material claim"],
  promptTokens: 900,
  completionTokens: 250,
  cost: 0.000412,
  generationId: "gen-123",
  latencyMs: 2100,
  draftHtml: "<p>Raw</p>",
};
/** A job that reached SUCCEEDED + DRAFT. */
const succeededJob = async (shopId: number, productId: number) => {
  const created = await createJob(shopId, jobInput(productId));
  const id = created!.job.id;
  await markJobRunning(shopId, id);
  await completeJob(shopId, id, output);
  return id;
};

beforeAll(async () => {
  shopA = await makeShop();
  shopB = await makeShop();
  productA = await makeProduct(shopA.id);
  productB = await makeProduct(shopB.id);
});

afterAll(async () => {
  await db.shop.deleteMany({ where: { id: { in: shops } } });
  await db.$disconnect();
});

describe("createJob", () => {
  it("stores the job QUEUED with its input and no review yet", async () => {
    const result = await createJob(shopA.id, jobInput(productA.id));
    expect(result!.created).toBe(true);
    const job = await getJob(shopA.id, result!.job.id);
    expect(job).toMatchObject({ status: "QUEUED", reviewStatus: null, draftHtml: null, output: null });
    expect(job!.input).toMatchObject({ imageCount: 2, merchantContext: "For beginners" });
    expect(job!.input!.selectedMediaIds).toEqual([
      "gid://shopify/MediaImage/1",
      "gid://shopify/MediaImage/2",
    ]);
  });

  it("returns the first job for a repeated idempotency key, even with different content", async () => {
    const first = await createJob(shopA.id, jobInput(productA.id, { idempotencyKey: "retry-1" }));
    const second = await createJob(
      shopA.id,
      jobInput(productA.id, { idempotencyKey: "retry-1", merchantContext: "changed" }),
    );
    expect(second).toMatchObject({ created: false });
    expect(second!.job.id).toBe(first!.job.id);
    expect(await db.aiGenerationInput.count({ where: { jobId: first!.job.id } })).toBe(1);
    expect((await getJob(shopA.id, first!.job.id))!.input!.merchantContext).toBe("For beginners");
  });

  it("lets exactly one of several concurrent identical requests create the job", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createJob(shopA.id, jobInput(productA.id, { idempotencyKey: key }))),
    );
    expect(results.filter((r) => r!.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r!.job.id)).size).toBe(1);
  });

  it("scopes the idempotency key by shop", async () => {
    const a = await createJob(shopA.id, jobInput(productA.id, { idempotencyKey: "shared-key" }));
    const b = await createJob(shopB.id, jobInput(productB.id, { idempotencyKey: "shared-key" }));
    expect(b!.created).toBe(true);
    expect(b!.job.id).not.toBe(a!.job.id);
  });

  it("refuses another shop's product, a deleted product and a foreign previous job", async () => {
    expect(await createJob(shopA.id, jobInput(productB.id))).toBeNull();

    const gone = await makeProduct(shopA.id);
    await db.product.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expect(await createJob(shopA.id, jobInput(gone.id))).toBeNull();

    const foreign = await createJob(shopB.id, jobInput(productB.id));
    expect(await createJob(shopA.id, jobInput(productA.id, { previousJobId: foreign!.job.id }))).toBeNull();
  });

  it("links a regeneration to the previous attempt and keeps both", async () => {
    const first = await createJob(shopA.id, jobInput(productA.id));
    const second = await createJob(shopA.id, jobInput(productA.id, { previousJobId: first!.job.id }));
    expect(second!.job.previousJobId).toBe(first!.job.id);
    const ids = (await listJobsForProduct(shopA.id, productA.id, 100)).map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([first!.job.id, second!.job.id]));
  });
});

describe("tenant isolation", () => {
  it("hides a job from another shop on every read and write", async () => {
    const id = await succeededJob(shopA.id, productA.id);
    expect(await getJob(shopB.id, id)).toBeNull();
    expect(await listJobsForProduct(shopB.id, productA.id)).toEqual([]);
    expect(await saveDraft(shopB.id, id, "<p>hacked</p>")).toBe(false);
    expect(await moveReviewStatus(db, shopB.id, id, "DRAFT", "APPROVED")).toBe(false);
    expect(await failJob(shopB.id, id, "x")).toBe(false);
    expect(await getJob(shopA.id, id)).toMatchObject({ reviewStatus: "DRAFT", draftHtml: "<p>Raw</p>" });
  });
});

describe("job lifecycle", () => {
  it("starts a job once", async () => {
    const { job } = (await createJob(shopA.id, jobInput(productA.id)))!;
    const starts = await Promise.all([markJobRunning(shopA.id, job.id), markJobRunning(shopA.id, job.id)]);
    expect(starts.filter(Boolean)).toHaveLength(1);
    await failJob(shopA.id, job.id, "cleanup");
  });

  it("completes with output, usage and a first draft in one step", async () => {
    const id = await succeededJob(shopA.id, productA.id);
    const job = await getJob(shopA.id, id);
    expect(job).toMatchObject({ status: "SUCCEEDED", reviewStatus: "DRAFT", draftHtml: "<p>Raw</p>" });
    expect(job!.completedAt).not.toBeNull();
    expect(job!.output).toMatchObject({
      promptTokens: 900,
      completionTokens: 250,
      generationId: "gen-123",
      latencyMs: 2100,
      warningsJson: ["Unverified material claim"],
    });
    expect(Number(job!.output!.cost)).toBeCloseTo(0.000412, 6);
  });

  it("does not complete a job that is not RUNNING, and leaves no output row", async () => {
    const { job } = (await createJob(shopA.id, jobInput(productA.id)))!;
    expect(await completeJob(shopA.id, job.id, output)).toBe(false);
    await markJobRunning(shopA.id, job.id);
    await failJob(shopA.id, job.id, "provider down");
    expect(await completeJob(shopA.id, job.id, output)).toBe(false);
    expect(await db.aiGenerationOutput.count({ where: { jobId: job.id } })).toBe(0);
    expect(await getJob(shopA.id, job.id)).toMatchObject({ status: "FAILED", reviewStatus: null });
  });

  it("bounds the stored error and never fails a finished job", async () => {
    const { job } = (await createJob(shopA.id, jobInput(productA.id)))!;
    expect(await failJob(shopA.id, job.id, "e".repeat(5000))).toBe(true);
    expect((await getJob(shopA.id, job.id))!.error).toHaveLength(1000);
    expect(await failJob(shopA.id, job.id, "again")).toBe(false);
    const done = await succeededJob(shopA.id, productA.id);
    expect(await failJob(shopA.id, done, "late")).toBe(false);
  });

  it("fails abandoned jobs and only those, for that shop only", async () => {
    const shop = await makeShop();
    const other = await makeShop();
    const product = await makeProduct(shop.id);
    const otherProduct = await makeProduct(other.id);
    const long = new Date(Date.now() - JOB_ABANDON_MS - 1000);

    const stuckRunning = (await createJob(shop.id, jobInput(product.id)))!.job.id;
    const stuckQueued = (await createJob(shop.id, jobInput(product.id)))!.job.id;
    const fresh = (await createJob(shop.id, jobInput(product.id)))!.job.id;
    const foreign = (await createJob(other.id, jobInput(otherProduct.id)))!.job.id;
    await db.aiGenerationJob.update({ where: { id: stuckRunning }, data: { status: "RUNNING", startedAt: long } });
    await db.aiGenerationJob.update({ where: { id: stuckQueued }, data: { createdAt: long } });
    await db.aiGenerationJob.update({ where: { id: foreign }, data: { createdAt: long } });

    expect(await countActiveJobs(shop.id)).toBe(3);
    expect(await failAbandonedJobs(shop.id)).toBe(2);
    expect(await countActiveJobs(shop.id)).toBe(1);
    expect((await getJob(shop.id, stuckRunning))!.error).toMatch(/Abandoned/);
    expect((await getJob(shop.id, fresh))!.status).toBe("QUEUED");
    expect((await getJob(other.id, foreign))!.status).toBe("QUEUED");
  });

  it("counts a shop's jobs since a moment", async () => {
    const shop = await makeShop();
    const product = await makeProduct(shop.id);
    const old = (await createJob(shop.id, jobInput(product.id)))!.job.id;
    await db.aiGenerationJob.update({ where: { id: old }, data: { createdAt: new Date(Date.now() - 48 * 3600_000) } });
    await createJob(shop.id, jobInput(product.id));
    expect(await countJobsSince(shop.id, new Date(Date.now() - 24 * 3600_000))).toBe(1);
  });
});

describe("merchant review", () => {
  it("edits the draft without touching the model's output", async () => {
    const id = await succeededJob(shopA.id, productA.id);
    expect(await saveDraft(shopA.id, id, "<p>Edited by merchant</p>")).toBe(true);
    const job = await getJob(shopA.id, id);
    expect(job!.draftHtml).toBe("<p>Edited by merchant</p>");
    expect(job!.output!.rawJson).toEqual(output.rawJson);
    expect(job!.output!.validatedJson).toEqual(output.validatedJson);
  });

  it("refuses edits and decisions on a job that did not succeed", async () => {
    const { job } = (await createJob(shopA.id, jobInput(productA.id)))!;
    expect(await saveDraft(shopA.id, job.id, "<p>x</p>")).toBe(false);
    await failJob(shopA.id, job.id, "failed");
    expect(await saveDraft(shopA.id, job.id, "<p>x</p>")).toBe(false);
    expect(await moveReviewStatus(db, shopA.id, job.id, "DRAFT", "APPROVED")).toBe(false);
  });

  it("walks DRAFT → APPROVED → APPLIED and freezes the draft after approval", async () => {
    const id = await succeededJob(shopA.id, productA.id);
    expect(await moveReviewStatus(db, shopA.id, id, "DRAFT", "APPLIED")).toBe(false);
    expect(await moveReviewStatus(db, shopA.id, id, "DRAFT", "APPROVED")).toBe(true);
    expect(await saveDraft(shopA.id, id, "<p>late edit</p>")).toBe(false);
    expect(await moveReviewStatus(db, shopA.id, id, "APPROVED", "APPLIED")).toBe(true);
    expect(await moveReviewStatus(db, shopA.id, id, "APPLIED", "DRAFT")).toBe(false);
    const job = await getJob(shopA.id, id);
    expect(job).toMatchObject({ reviewStatus: "APPLIED", draftHtml: "<p>Raw</p>" });
    expect(job!.reviewedAt).not.toBeNull();
  });

  it("lets only one of two concurrent applies win", async () => {
    const id = await succeededJob(shopA.id, productA.id);
    await moveReviewStatus(db, shopA.id, id, "DRAFT", "APPROVED");
    const wins = await Promise.all([
      moveReviewStatus(db, shopA.id, id, "APPROVED", "APPLIED"),
      moveReviewStatus(db, shopA.id, id, "APPROVED", "APPLIED"),
    ]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("returns an approved draft to DRAFT when the write is refused, and keeps REJECTED final", async () => {
    const id = await succeededJob(shopA.id, productA.id);
    await moveReviewStatus(db, shopA.id, id, "DRAFT", "APPROVED");
    expect(await moveReviewStatus(db, shopA.id, id, "APPROVED", "DRAFT")).toBe(true);
    expect(await moveReviewStatus(db, shopA.id, id, "DRAFT", "REJECTED")).toBe(true);
    expect(await moveReviewStatus(db, shopA.id, id, "REJECTED", "DRAFT")).toBe(false);
  });

  it("rolls the decision back with the surrounding transaction", async () => {
    const id = await succeededJob(shopA.id, productA.id);
    await moveReviewStatus(db, shopA.id, id, "DRAFT", "APPROVED");
    await expect(
      db.$transaction(async (tx) => {
        await moveReviewStatus(tx, shopA.id, id, "APPROVED", "APPLIED");
        await createVersion(tx, shopA.id, {
          productId: productA.id,
          jobId: id,
          source: "AI",
          descriptionHtml: "<p>Raw</p>",
          previousDescriptionHtml: null,
          shopifyUpdatedAt: new Date(),
          appliedBy: "test",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await getJob(shopA.id, id))!.reviewStatus).toBe("APPROVED");
    expect(await db.productDescriptionVersion.count({ where: { jobId: id } })).toBe(0);
  });
});

describe("description versions", () => {
  it("keeps history newest first and records a restore as a new row", async () => {
    const shop = await makeShop();
    const product = await makeProduct(shop.id);
    const jobId = await succeededJob(shop.id, product.id);
    const v1 = await createVersion(db, shop.id, {
      productId: product.id,
      jobId,
      source: "AI",
      descriptionHtml: "<p>One</p>",
      previousDescriptionHtml: "<p>Original</p>",
      shopifyUpdatedAt: new Date(),
      appliedBy: "staff@example.com",
    });
    const v2 = await createVersion(db, shop.id, {
      productId: product.id,
      jobId: null,
      source: "RESTORE",
      descriptionHtml: "<p>Original</p>",
      previousDescriptionHtml: "<p>One</p>",
      shopifyUpdatedAt: new Date(),
      appliedBy: "staff@example.com",
      restoredFromId: v1.id,
    });
    const versions = await listVersions(shop.id, product.id);
    expect(versions.map((v) => v.id)).toEqual([v2.id, v1.id]);
    expect(versions[0]).toMatchObject({ source: "RESTORE", restoredFromId: v1.id });
    expect(versions[1]).toMatchObject({ descriptionHtml: "<p>One</p>", previousDescriptionHtml: "<p>Original</p>" });

    expect(await getVersion(shopB.id, product.id, v1.id)).toBeNull();
    expect(await getVersion(shop.id, productA.id, v1.id)).toBeNull();
    expect(await listVersions(shopB.id, product.id)).toEqual([]);
  });
});

describe("publication actions", () => {
  it("records the attempt first, completes once, and keeps userErrors", async () => {
    const ok = await createPublicationAction(shopA.id, {
      productId: productA.id,
      publicationGid: "gid://shopify/Publication/1",
      requestedBy: "staff@example.com",
    });
    expect(ok).toMatchObject({ status: "REQUESTED", action: "PUBLISH", completedAt: null });
    expect(await completePublicationAction(shopB.id, ok.id, { ok: true })).toBe(false);
    expect(await completePublicationAction(shopA.id, ok.id, { ok: true })).toBe(true);
    expect(await completePublicationAction(shopA.id, ok.id, { ok: true })).toBe(false);

    const bad = await createPublicationAction(shopA.id, {
      productId: productA.id,
      publicationGid: "gid://shopify/Publication/2",
      requestedBy: "staff@example.com",
    });
    const userErrors = [{ field: ["id"], message: "Product is not active" }];
    await completePublicationAction(shopA.id, bad.id, { ok: false, userErrors });

    const actions = await listPublicationActions(shopA.id, productA.id);
    expect(actions.map((a) => a.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(actions[0].userErrorsJson).toEqual(userErrors);
    expect(await listPublicationActions(shopB.id, productA.id)).toEqual([]);
  });
});
