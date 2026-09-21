import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getJob } from "../repositories/ai-generation.server";
import { json, readJsonBody, withApiAuth } from "../services/api.server";
import { regenerate } from "../services/description-review.server";
import {
  apiGenerationDeps,
  asObject,
  generationFields,
  idempotencyKeyFrom,
  parseJobId,
  withGenerationErrors,
} from "../services/generation-api.server";
import { serializeGeneration } from "../services/generation-view";

// POST /api/v1/description-generations/{jobId}/regenerate
// Header: Idempotency-Key. Body (optional): { mediaIds?, merchantContext?, model? } to override
// the previous attempt's input. Always a NEW job linked by previousGenerationId; history is kept.
export const action = ({ request, params }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"], bucket: "generation" }, ({ shop, requestId }) =>
    withGenerationErrors(async () => {
      const jobId = parseJobId(params.jobId);
      const body = asObject((await readJsonBody(request, { allowEmpty: true })) ?? {});
      const deps = await apiGenerationDeps(shop, requestId);
      const started = await regenerate(deps, shop.id, jobId, {
        idempotencyKey: idempotencyKeyFrom(request, body),
        ...generationFields(body),
      });
      if (started.run) void started.run();
      const job = await getJob(shop.id, started.job.id);
      return json({ data: serializeGeneration(job!) }, started.created ? 202 : 200, {
        Location: `/api/v1/description-generations/${started.job.id}`,
      });
    }),
  );

export const loader = ({ request }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"] }, async () => json({}));
