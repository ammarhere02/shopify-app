/**
 * State rules for a description generation. Two independent fields:
 *  - status:       did the machine finish?      QUEUED → RUNNING → SUCCEEDED | FAILED
 *  - reviewStatus: what did the merchant decide? DRAFT → APPROVED | REJECTED,
 *                  APPROVED → APPLYING → APPLIED (APPLYING = the Shopify write is in flight)
 * Pure functions, so every transition is unit-testable and repositories can turn them
 * into conditional updates (`WHERE status = from`).
 */
export type GenerationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type ReviewStatus = "DRAFT" | "APPROVED" | "REJECTED" | "APPLYING" | "APPLIED";

/** A RUNNING or QUEUED job older than this was lost with its process (same idea as sync runs). */
export const JOB_ABANDON_MS = 5 * 60_000;
/** An APPLYING job older than this lost its process mid-write; Shopify may or may not have the text. */
export const APPLY_ABANDON_MS = 2 * 60_000;

const JOB_TRANSITIONS: Record<GenerationStatus, readonly GenerationStatus[]> = {
  QUEUED: ["RUNNING", "FAILED"],
  RUNNING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
};

const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  DRAFT: ["APPROVED", "REJECTED"],
  APPROVED: ["APPLYING", "DRAFT"], // DRAFT = the merchant wants to edit again
  // Back to APPROVED when the write is refused (stale product, userErrors) so Apply can be retried.
  APPLYING: ["APPLIED", "APPROVED"],
  REJECTED: [],
  APPLIED: [],
};

export function canMoveJob(from: GenerationStatus, to: GenerationStatus) {
  return JOB_TRANSITIONS[from].includes(to);
}

export function canMoveReview(from: ReviewStatus, to: ReviewStatus) {
  return REVIEW_TRANSITIONS[from].includes(to);
}

/** Only a finished generation has something to review. */
export function canHaveReview(status: GenerationStatus) {
  return status === "SUCCEEDED";
}

/** The merchant may edit the working copy only while it is still a draft. */
export function canEditDraft(status: GenerationStatus, review: ReviewStatus | null) {
  return status === "SUCCEEDED" && review === "DRAFT";
}

/** Only an approved draft can be written to Shopify. */
export function canApply(status: GenerationStatus, review: ReviewStatus | null) {
  return status === "SUCCEEDED" && review === "APPROVED";
}

export function isApplyAbandoned(job: { reviewStatus: ReviewStatus | null; reviewedAt: Date | null }, now: Date) {
  if (job.reviewStatus !== "APPLYING" || !job.reviewedAt) return false;
  return now.getTime() - job.reviewedAt.getTime() >= APPLY_ABANDON_MS;
}

export function isAbandoned(
  job: { status: GenerationStatus; createdAt: Date; startedAt: Date | null },
  now: Date,
) {
  if (job.status !== "QUEUED" && job.status !== "RUNNING") return false;
  const since = job.startedAt ?? job.createdAt;
  return now.getTime() - since.getTime() >= JOB_ABANDON_MS;
}
