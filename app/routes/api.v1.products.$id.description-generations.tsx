import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getJob, listJobsForProduct } from "../repositories/ai-generation.server";
import { getProductByGid } from "../repositories/enrichment.server";
import { ApiError, json, productGidFromParam, readJsonBody, withApiAuth } from "../services/api.server";
import { startGeneration } from "../services/description-generation.server";
import {
  apiGenerationDeps,
  asObject,
  generationFields,
  idempotencyKeyFrom,
  withGenerationErrors,
} from "../services/generation-api.server";
import { serializeGeneration } from "../services/generation-view";

async function requireProduct(shopId: number, idParam: string | undefined) {
  const product = await getProductByGid(shopId, productGidFromParam(idParam));
  if (!product || product.deletedAt) throw new ApiError(404, "product_not_found", "Product not found");
  return product;
}

// POST /api/v1/products/{id}/description-generations
// Header: Idempotency-Key (8-64 chars). Body: { mediaIds: string[1..4], merchantContext?, model? }
// 202 + Location for a new job, 200 with the existing job when the key was already used.
export const action = ({ request, params }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"], bucket: "generation" }, ({ shop, requestId }) =>
    withGenerationErrors(async () => {
      const product = await requireProduct(shop.id, params.id);
      const body = asObject(await readJsonBody(request));
      const deps = await apiGenerationDeps(shop, requestId);
      const fields = generationFields(body);
      const started = await startGeneration(deps, shop.id, {
        productId: product.id,
        idempotencyKey: idempotencyKeyFrom(request, body),
        ...fields,
        mediaIds: fields.mediaIds ?? [],
      });
      // Not awaited: the caller polls GET /description-generations/{id}.
      if (started.run) void started.run();
      const job = await getJob(shop.id, started.job.id);
      return json({ data: serializeGeneration(job!) }, started.created ? 202 : 200, {
        Location: `/api/v1/description-generations/${started.job.id}`,
      });
    }),
  );

// GET /api/v1/products/{id}/description-generations  → newest first, at most 20
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET", "POST"] }, async ({ shop }) => {
    const product = await requireProduct(shop.id, params.id);
    const jobs = await listJobsForProduct(shop.id, product.id, 20);
    return json({
      data: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        reviewStatus: job.reviewStatus,
        model: job.model,
        previousGenerationId: job.previousJobId,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt?.toISOString() ?? null,
      })),
    });
  });
