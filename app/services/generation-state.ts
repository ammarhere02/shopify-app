/**
 * State rules for a description generation. Two independent fields:
 *  - status:       did the machine finish?      QUEUED → RUNNING → SUCCEEDED | FAILED
 *  - reviewStatus: what did the merchant decide? DRAFT → APPROVED | REJECTED, APPROVED → APPLIED
 * Pure functions, so every transition is unit-testable and repositories can turn them
 * into conditional updates (`WHERE status = from`).
 */
export type GenerationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type ReviewStatus = "DRAFT" | "APPROVED" | "REJECTED" | "APPLIED";

/** A RUNNING or QUEUED job older than this was lost with its process (same idea as sync runs). */
export const JOB_ABANDON_MS = 5 * 60_000;

const JOB_TRANSITIONS: Record<GenerationStatus, readonly GenerationStatus[]> = {
  QUEUED: ["RUNNING", "FAILED"],
  RUNNING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
};

const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  DRAFT: ["APPROVED", "REJECTED"],
  // Back to DRAFT when the write to Shopify is refused (stale product, userErrors).
  APPROVED: ["APPLIED", "DRAFT"],
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

export function isAbandoned(
  job: { status: GenerationStatus; createdAt: Date; startedAt: Date | null },
  now: Date,
) {
  if (job.status !== "QUEUED" && job.status !== "RUNNING") return false;
  const since = job.startedAt ?? job.createdAt;
  return now.getTime() - since.getTime() >= JOB_ABANDON_MS;
}
