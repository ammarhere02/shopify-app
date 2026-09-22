import db from "../db.server";
import { BATCH_MAX } from "../lib/generation-limits";
import { logger } from "../lib/logger.server";
import {
  GenerationError,
  fetchProductForDescription,
  selectableImages,
  startGeneration,
} from "./description-generation.server";
import type { GenerationDeps } from "./description-generation.server";

/**
 * Batch generation: one QUEUED job per product, run later by the worker. Nothing is generated
 * inline, so the request answers in the time of N product reads. Each job gets its own
 * idempotency key derived from the batch key, so a retried batch call creates nothing twice.
 * Limits: at most BATCH_MAX products; the per-shop daily limit is enforced per job, and the
 * first product that hits it stops the batch (the rest are reported as skipped).
 */
export { BATCH_MAX };
const KEY = /^[A-Za-z0-9_-]{8,48}$/; // shorter than a job key: "-p<id>" is appended

export type BatchInput = {
  productIds: unknown;
  merchantContext?: string | null;
  model?: string | null;
  idempotencyKey: string;
};

export type BatchResult = {
  jobs: Array<{ productId: number; jobId: number; created: boolean }>;
  skipped: Array<{ productId: number; reason: string }>;
};

export async function startBatchGeneration(deps: GenerationDeps, shopId: number, input: BatchInput): Promise<BatchResult> {
  const ids = input.productIds;
  const errors: Record<string, string> = {};
  if (!KEY.test(input.idempotencyKey ?? "")) errors.idempotencyKey = "Must be 8-48 characters: letters, digits, - or _";
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > BATCH_MAX) {
    errors.productIds = `Select between 1 and ${BATCH_MAX} products`;
  } else if (!ids.every((id) => Number.isInteger(id) && (id as number) > 0)) {
    errors.productIds = "Each product id must be a positive integer";
  } else if (new Set(ids).size !== ids.length) {
    errors.productIds = "The same product was selected twice";
  }
  if (Object.keys(errors).length) throw new GenerationError("VALIDATION", "Invalid batch request", errors);
  const productIds = ids as number[];

  // Tenant check up front: an id from another shop is refused before anything is created.
  const own = await db.product.findMany({ where: { id: { in: productIds }, shopId, deletedAt: null }, select: { id: true, shopifyProductGid: true } });
  const known = new Map(own.map((p) => [p.id, p.shopifyProductGid]));
  if (known.size !== productIds.length) throw new GenerationError("NOT_FOUND", "One or more products were not found");

  const result: BatchResult = { jobs: [], skipped: [] };
  for (const productId of productIds) {
    const remote = await fetchProductForDescription(deps.shopify, known.get(productId)!);
    const images = remote ? selectableImages(remote).slice(0, deps.config.maxImages) : [];
    if (images.length === 0) {
      result.skipped.push({ productId, reason: remote ? "No ready image" : "No longer in Shopify" });
      continue;
    }
    try {
      const started = await startGeneration(deps, shopId, {
        productId,
        mediaIds: images.map((i) => i.id),
        merchantContext: input.merchantContext ?? null,
        model: input.model ?? null,
        idempotencyKey: `${input.idempotencyKey}-p${productId}`,
        enqueueOnly: true,
      });
      result.jobs.push({ productId, jobId: started.job.id, created: started.created });
    } catch (err) {
      if (err instanceof GenerationError && err.code === "LIMIT") {
        // Daily limit reached: stop here, report the rest, keep what was queued.
        for (const rest of productIds.slice(productIds.indexOf(productId))) {
          result.skipped.push({ productId: rest, reason: err.message });
        }
        break;
      }
      throw err;
    }
  }
  logger.info("ai.batch_queued", { shopId, requested: productIds.length, queued: result.jobs.filter((j) => j.created).length, skipped: result.skipped.length });
  return result;
}
