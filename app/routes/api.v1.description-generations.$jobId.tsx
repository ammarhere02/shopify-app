import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getJob } from "../repositories/ai-generation.server";
import { ApiError, json, withApiAuth } from "../services/api.server";
import { parseJobId } from "../services/generation-api.server";
import { serializeGeneration } from "../services/generation-view";

// GET /api/v1/description-generations/{jobId}
// Status, validated draft, warnings, usage and error summary. Another shop's job is a 404.
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async ({ shop }) => {
    const job = await getJob(shop.id, parseJobId(params.jobId));
    if (!job) throw new ApiError(404, "not_found", "Generation not found");
    return json({ data: serializeGeneration(job) });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async () => json({}));
