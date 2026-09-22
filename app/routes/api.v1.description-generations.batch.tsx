import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { ApiError, json, productGidFromParam, readJsonBody, withApiAuth } from "../services/api.server";
import { apiGenerationDeps, asObject, idempotencyKeyFrom, withGenerationErrors } from "../services/generation-api.server";
import { startBatchGeneration } from "../services/generation-batch.server";
import db from "../db.server";

// POST /api/v1/description-generations/batch
// Header: Idempotency-Key. Body: { productIds: string[1..20] (numeric Shopify ids), merchantContext?, model? }
// Queues one job per product (first images of each, up to AI_MAX_IMAGES); the worker runs them.
// 202 with the job ids and the skipped products. Poll each job at GET /description-generations/{id}.
export const action = ({ request }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"], bucket: "generation" }, ({ shop, requestId }) =>
    withGenerationErrors(async () => {
      const body = asObject(await readJsonBody(request));
      if (!Array.isArray(body.productIds)) throw new ApiError(422, "validation_failed", "Invalid batch request", { productIds: "Must be a list" });
      // The API speaks Shopify ids; the service works with local ids scoped to this shop.
      const gids = body.productIds.map((id) => productGidFromParam(String(id)));
      const rows = await db.product.findMany({ where: { shopId: shop.id, shopifyProductGid: { in: gids }, deletedAt: null }, select: { id: true, shopifyProductGid: true } });
      if (rows.length !== new Set(gids).size) throw new ApiError(404, "product_not_found", "One or more products were not found");
      const byGid = new Map(rows.map((r) => [r.shopifyProductGid, r]));
      const deps = await apiGenerationDeps(shop, requestId);
      const result = await startBatchGeneration(deps, shop.id, {
        productIds: gids.map((g) => byGid.get(g)!.id),
        merchantContext: typeof body.merchantContext === "string" ? body.merchantContext : null,
        model: typeof body.model === "string" ? body.model : null,
        idempotencyKey: idempotencyKeyFrom(request, body),
      });
      const gidOf = new Map(rows.map((r) => [r.id, r.shopifyProductGid]));
      return json(
        {
          data: {
            jobs: result.jobs.map((j) => ({ productId: gidOf.get(j.productId), generationId: j.jobId, created: j.created })),
            skipped: result.skipped.map((s) => ({ productId: gidOf.get(s.productId), reason: s.reason })),
          },
        },
        202,
      );
    }),
  );

export const loader = ({ request }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"] }, async () => json({}));
