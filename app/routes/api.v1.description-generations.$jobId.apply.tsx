import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json, withApiAuth } from "../services/api.server";
import { applyGeneration, serializeVersion } from "../services/description-apply.server";
import { apiShopifyClient, parseJobId, withGenerationErrors } from "../services/generation-api.server";

// POST /api/v1/description-generations/{jobId}/apply — write the APPROVED draft to Shopify.
// No body. 201 with the version row; 409 invalid_state / stale_product; 422 shopify_rejected;
// 403 missing_scope when the shop has not granted write_products.
export const action = ({ request, params }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"], bucket: "generation" }, ({ shop, requestId, actor }) =>
    withGenerationErrors(async () => {
      const shopify = await apiShopifyClient(shop, requestId);
      const version = await applyGeneration({ shopify }, shop, parseJobId(params.jobId), actor);
      return json({ data: serializeVersion(version) }, 201);
    }),
  );

export const loader = ({ request }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"] }, async () => json({}));
