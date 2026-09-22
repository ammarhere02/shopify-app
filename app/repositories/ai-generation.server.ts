import { Prisma } from "@prisma/client";
import db from "../db.server";
import { APPLY_ABANDON_MS, JOB_ABANDON_MS, canMoveReview } from "../services/generation-state";
import type { ReviewStatus } from "../services/generation-state";

const ERROR_MAX = 1000;

type Tx = Prisma.TransactionClient;

export type NewJobInput = {
  productId: number;
  idempotencyKey: string;
  previousJobId?: number | null;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  selectedMediaIds: string[];
  productSnapshot: Prisma.InputJsonValue;
  merchantContext: string | null;
};

export type JobOutputInput = {
  rawJson: Prisma.InputJsonValue;
  validatedJson: Prisma.InputJsonValue;
  warnings: string[];
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  generationId: string | null;
  latencyMs: number;
  /** Sanitized descriptionHtml: the merchant's working copy starts as the model's text. */
  draftHtml: string;
};

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Create a job and its input in one transaction. Exactly one job exists per
 * (shopId, idempotencyKey): a retried request gets the first job back with created=false,
 * so it never becomes a second billable call. Returns null when the product (or the job
 * being regenerated) does not belong to the shop.
 */
export async function createJob(shopId: number, input: NewJobInput, client: Tx | typeof db = db) {
  const product = await client.product.findFirst({
    where: { id: input.productId, shopId, deletedAt: null },
    select: { id: true },
  });
  if (!product) return null;
  if (input.previousJobId) {
    const previous = await client.aiGenerationJob.findFirst({
      where: { id: input.previousJobId, shopId, productId: input.productId },
      select: { id: true },
    });
    if (!previous) return null;
  }

  try {
    const job = await client.aiGenerationJob.create({
      data: {
        shopId,
        productId: input.productId,
        idempotencyKey: input.idempotencyKey,
        previousJobId: input.previousJobId ?? null,
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        inputHash: input.inputHash,
        input: {
          create: {
            selectedMediaIds: input.selectedMediaIds,
            productSnapshotJson: input.productSnapshot,
            merchantContext: input.merchantContext,
            imageCount: input.selectedMediaIds.length,
          },
        },
      },
    });
    return { job, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const job = await client.aiGenerationJob.findUniqueOrThrow({
    where: { shopId_idempotencyKey: { shopId, idempotencyKey: input.idempotencyKey } },
  });
  return { job, created: false };
}

/** The job a retried request should get back, if its key was already used. */
export function findJobByIdempotencyKey(
  shopId: number,
  idempotencyKey: string,
  client: Tx | typeof db = db,
) {
  return client.aiGenerationJob.findUnique({
    where: { shopId_idempotencyKey: { shopId, idempotencyKey } },
  });
}

/** Shop-scoped lookup. Another shop's job id returns null. */
export function getJob(shopId: number, jobId: number) {
  return db.aiGenerationJob.findFirst({
    where: { id: jobId, shopId },
    include: { input: true, output: true },
  });
}

export function listJobsForProduct(shopId: number, productId: number, limit = 20) {
  return db.aiGenerationJob.findMany({
    where: { shopId, productId },
    orderBy: { id: "desc" },
    take: limit,
    include: { output: { select: { warningsJson: true, cost: true, latencyMs: true } } },
  });
}

/** Spend limits are counted from rows, not memory, so they survive restarts. */
export function countActiveJobs(shopId: number, client: Tx | typeof db = db) {
  return client.aiGenerationJob.count({
    where: { shopId, status: { in: ["QUEUED", "RUNNING"] } },
  });
}

export function countJobsSince(shopId: number, since: Date, client: Tx | typeof db = db) {
  return client.aiGenerationJob.count({ where: { shopId, createdAt: { gte: since } } });
}

/** QUEUED → RUNNING. False when another caller already started (or failed) the job. */
export async function markJobRunning(shopId: number, jobId: number) {
  const { count } = await db.aiGenerationJob.updateMany({
    where: { id: jobId, shopId, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  return count === 1;
}

/**
 * RUNNING → SUCCEEDED, output row and first draft in one transaction, so a job is never
 * SUCCEEDED without its output. False when the job is no longer RUNNING (abandoned meanwhile).
 */
export async function completeJob(shopId: number, jobId: number, output: JobOutputInput) {
  return db.$transaction(async (tx) => {
    const { count } = await tx.aiGenerationJob.updateMany({
      where: { id: jobId, shopId, status: "RUNNING" },
      data: {
        status: "SUCCEEDED",
        reviewStatus: "DRAFT",
        draftHtml: output.draftHtml,
        completedAt: new Date(),
        error: null,
      },
    });
    if (count !== 1) return false;
    await tx.aiGenerationOutput.create({
      data: {
        jobId,
        rawJson: output.rawJson,
        validatedJson: output.validatedJson,
        warningsJson: output.warnings,
        promptTokens: output.promptTokens,
        completionTokens: output.completionTokens,
        cost: output.cost,
        generationId: output.generationId,
        latencyMs: output.latencyMs,
      },
    });
    return true;
  });
}

/** QUEUED | RUNNING → FAILED with a bounded error summary. */
export async function failJob(shopId: number, jobId: number, message: string) {
  const { count } = await db.aiGenerationJob.updateMany({
    where: { id: jobId, shopId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "FAILED", completedAt: new Date(), error: message.slice(0, ERROR_MAX) },
  });
  return count === 1;
}

/** Jobs lost with their process stop counting against the concurrency limit. Returns count. */
export async function failAbandonedJobs(
  shopId: number,
  now = new Date(),
  client: Tx | typeof db = db,
) {
  const cutoff = new Date(now.getTime() - JOB_ABANDON_MS);
  const { count } = await client.aiGenerationJob.updateMany({
    where: {
      shopId,
      OR: [
        { status: "RUNNING", startedAt: { lt: cutoff } },
        { status: "QUEUED", createdAt: { lt: cutoff } },
      ],
    },
    data: { status: "FAILED", completedAt: now, error: "Abandoned: the process stopped before the job finished" },
  });
  return count;
}

/**
 * An APPLYING job whose process died mid-write goes back to APPROVED with an error note, so
 * Apply can be retried. Shopify may already hold the text: the stale check on the retry
 * sees our own write (same hash) and lets it through, and the version row is written then.
 */
export async function recoverAbandonedApplies(shopId: number, now = new Date(), client: Tx | typeof db = db) {
  const cutoff = new Date(now.getTime() - APPLY_ABANDON_MS);
  const { count } = await client.aiGenerationJob.updateMany({
    where: { shopId, reviewStatus: "APPLYING", reviewedAt: { lt: cutoff } },
    data: {
      reviewStatus: "APPROVED",
      reviewedAt: now,
      error: "Apply was interrupted before it was recorded. Check the product in Shopify, then apply again.",
    },
  });
  return count;
}

/**
 * Worker lease: the oldest QUEUED job (older than `graceMs`, so a job whose creating request
 * is about to run it inline is left alone) of a shop that has fewer than `maxRunningPerShop`
 * RUNNING jobs, moved to RUNNING in the same transaction. `FOR UPDATE SKIP LOCKED` lets several
 * worker loops (or processes) lease different rows without waiting on each other.
 * Returns the job with its input, or null when nothing is due.
 */
export async function leaseQueuedJob(maxRunningPerShop: number, graceMs: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - graceMs);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: number; shopId: number }>>`
      SELECT j.id, j.shopId FROM ai_generation_jobs j
      WHERE j.status = 'QUEUED' AND j.createdAt < ${cutoff}
        AND (SELECT COUNT(*) FROM ai_generation_jobs r WHERE r.shopId = j.shopId AND r.status = 'RUNNING') < ${maxRunningPerShop}
      ORDER BY j.id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row) return null;
    const { count } = await tx.aiGenerationJob.updateMany({
      where: { id: row.id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: now },
    });
    if (count !== 1) return null;
    return tx.aiGenerationJob.findUnique({ where: { id: row.id }, include: { input: true } });
  });
}

/** Save the merchant's (already sanitized) edit. Only while the job is a DRAFT. */
export async function saveDraft(shopId: number, jobId: number, draftHtml: string) {
  const { count } = await db.aiGenerationJob.updateMany({
    where: { id: jobId, shopId, status: "SUCCEEDED", reviewStatus: "DRAFT" },
    data: { draftHtml },
  });
  return count === 1;
}

/**
 * Move the merchant's decision. The update matches the `from` state, so of two concurrent
 * callers exactly one wins; this is what makes Apply safe against a double click.
 * Pass a transaction client to commit the move together with other writes.
 */
export async function moveReviewStatus(
  client: Tx | typeof db,
  shopId: number,
  jobId: number,
  from: ReviewStatus,
  to: ReviewStatus,
) {
  if (!canMoveReview(from, to)) return false;
  const { count } = await client.aiGenerationJob.updateMany({
    where: { id: jobId, shopId, status: "SUCCEEDED", reviewStatus: from },
    data: { reviewStatus: to, reviewedAt: new Date() },
  });
  return count === 1;
}
