import {
  getJob,
  moveReviewStatus,
  saveDraft,
} from "../repositories/ai-generation.server";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import { GenerationError, startGeneration } from "./description-generation.server";
import type { GenerationDeps } from "./description-generation.server";
import { OUTPUT_LIMITS } from "./description-output";
import type { ReviewStatus } from "./generation-state";
import { htmlToText, sanitizeHtml } from "./html-sanitize";

/**
 * The merchant's side of a generation: edit, reject, approve, regenerate.
 * Nothing here talks to Shopify. Approval only marks the draft as the text the merchant
 * wants; writing it to the store is a separate, explicit step.
 */

async function requireJob(shopId: number, jobId: number) {
  const job = await getJob(shopId, jobId);
  if (!job) throw new GenerationError("NOT_FOUND", "Generation not found");
  return job;
}

/** Sanitize, then store. Returns the stored HTML so the editor shows exactly what was kept. */
export async function saveDraftEdit(shopId: number, jobId: number, html: unknown) {
  if (typeof html !== "string") {
    throw new GenerationError("VALIDATION", "Invalid draft", { descriptionHtml: "Must be text" });
  }
  if (html.length > OUTPUT_LIMITS.descriptionHtml) {
    throw new GenerationError("VALIDATION", "Invalid draft", {
      descriptionHtml: `Must be at most ${OUTPUT_LIMITS.descriptionHtml} characters`,
    });
  }
  const clean = sanitizeHtml(html);
  if (!htmlToText(clean)) {
    throw new GenerationError("VALIDATION", "Invalid draft", { descriptionHtml: "The description is empty" });
  }
  await requireJob(shopId, jobId);
  if (!(await saveDraft(shopId, jobId, clean))) {
    throw new GenerationError("CONFLICT", "Only a draft can be edited");
  }
  logger.info("ai.draft_saved", { shopId, jobId, length: clean.length });
  return clean;
}

const MOVES: Record<"approve" | "reject" | "reopen", [ReviewStatus, ReviewStatus]> = {
  approve: ["DRAFT", "APPROVED"],
  reject: ["DRAFT", "REJECTED"],
  reopen: ["APPROVED", "DRAFT"], // the merchant wants to edit again before applying
};

export async function reviewDraft(shopId: number, jobId: number, decision: keyof typeof MOVES) {
  await requireJob(shopId, jobId);
  const [from, to] = MOVES[decision];
  if (!(await moveReviewStatus(db, shopId, jobId, from, to))) {
    throw new GenerationError("CONFLICT", `Only a ${from.toLowerCase()} generation can be ${decision === "reopen" ? "reopened" : `${decision}d`}`);
  }
  logger.info("ai.draft_reviewed", { shopId, jobId, decision });
  return requireJob(shopId, jobId);
}

/**
 * A new job linked to the previous attempt. The earlier job, its output and its cost stay as
 * they are. Images, context and model default to the previous attempt's and can be overridden.
 */
export async function regenerate(
  deps: GenerationDeps,
  shopId: number,
  jobId: number,
  overrides: { idempotencyKey: string; mediaIds?: string[]; merchantContext?: string | null; model?: string | null },
) {
  const previous = await requireJob(shopId, jobId);
  if (previous.status === "QUEUED" || previous.status === "RUNNING") {
    throw new GenerationError("CONFLICT", "This generation is still running");
  }
  return startGeneration(deps, shopId, {
    productId: previous.productId,
    previousJobId: previous.id,
    idempotencyKey: overrides.idempotencyKey,
    mediaIds: overrides.mediaIds ?? ((previous.input?.selectedMediaIds as string[] | undefined) ?? []),
    merchantContext:
      overrides.merchantContext !== undefined ? overrides.merchantContext : (previous.input?.merchantContext ?? null),
    model: overrides.model ?? previous.model,
  });
}
