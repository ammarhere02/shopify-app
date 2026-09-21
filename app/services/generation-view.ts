import type { DescriptionOutput } from "./description-output";

type JobRow = {
  id: number;
  productId: number;
  status: string;
  reviewStatus: string | null;
  draftHtml: string | null;
  previousJobId: number | null;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  reviewedAt: Date | null;
  input?: { selectedMediaIds: unknown; merchantContext: string | null; imageCount: number } | null;
  output?: {
    validatedJson: unknown;
    warningsJson: unknown;
    promptTokens: number | null;
    completionTokens: number | null;
    cost: { toString(): string } | null;
    generationId: string | null;
    latencyMs: number;
  } | null;
};

/**
 * The one public shape of a generation, used by the admin page and by /api/v1.
 * Left out on purpose: the raw model answer, the product snapshot and local product ids.
 */
export function serializeGeneration(job: JobRow) {
  const generated = (job.output?.validatedJson ?? null) as DescriptionOutput | null;
  return {
    id: job.id,
    status: job.status,
    reviewStatus: job.reviewStatus,
    previousGenerationId: job.previousJobId,
    provider: job.provider,
    model: job.model,
    promptVersion: job.promptVersion,
    inputHash: job.inputHash,
    input: job.input
      ? {
          mediaIds: job.input.selectedMediaIds as string[],
          merchantContext: job.input.merchantContext,
          imageCount: job.input.imageCount,
        }
      : null,
    // The merchant's working copy. `generated` stays as the model wrote it (after sanitizing).
    draftHtml: job.draftHtml,
    generated,
    warnings: (job.output?.warningsJson ?? []) as string[],
    usage: job.output
      ? {
          promptTokens: job.output.promptTokens,
          completionTokens: job.output.completionTokens,
          estimatedCostUsd: job.output.cost === null ? null : Number(job.output.cost.toString()),
          latencyMs: job.output.latencyMs,
          generationId: job.output.generationId,
        }
      : null,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    reviewedAt: job.reviewedAt?.toISOString() ?? null,
  };
}

export type GenerationView = ReturnType<typeof serializeGeneration>;

export const isGenerationFinished = (status: string) => status === "SUCCEEDED" || status === "FAILED";
