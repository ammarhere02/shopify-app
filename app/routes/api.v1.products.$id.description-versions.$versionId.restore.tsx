import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getProductByGid } from "../repositories/enrichment.server";
import { ApiError, json, productGidFromParam, readJsonBody, withApiAuth } from "../services/api.server";
import { restoreVersion, serializeVersion } from "../services/description-apply.server";
import { apiShopifyClient, asObject, withGenerationErrors } from "../services/generation-api.server";

// POST /api/v1/products/{id}/description-versions/{versionId}/restore
// Body (optional): { which: "written" | "previous" } — the text that version wrote (default)
// or the text it replaced. Writes to Shopify and answers 201 with the NEW version row.
export const action = ({ request, params }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"], bucket: "generation" }, ({ shop, requestId, actor }) =>
    withGenerationErrors(async () => {
      const product = await getProductByGid(shop.id, productGidFromParam(params.id));
      if (!product || product.deletedAt) throw new ApiError(404, "product_not_found", "Product not found");
      if (!params.versionId || !/^[1-9]\d{0,9}$/.test(params.versionId)) throw new ApiError(404, "not_found", "Version not found");
      const body = asObject((await readJsonBody(request, { allowEmpty: true })) ?? {});
      if (body.which !== undefined && body.which !== "written" && body.which !== "previous") {
        throw new ApiError(422, "validation_failed", "Invalid restore request", { which: 'Must be "written" or "previous"' });
      }
      const shopify = await apiShopifyClient(shop, requestId);
      const version = await restoreVersion({ shopify }, shop, product.id, Number(params.versionId), body.which ?? "written", actor);
      return json({ data: serializeVersion(version) }, 201);
    }),
  );

export const loader = ({ request }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"] }, async () => json({}));
