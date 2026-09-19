import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getProductByGid, removeEnrichment, saveEnrichment } from "../repositories/enrichment.server";
import { ApiError, json, productGidFromParam, readJsonBody, serializeEnrichment, withApiAuth } from "../services/api.server";
import { validateEnrichment } from "../services/enrichment-validation";

const METHODS = ["PUT", "DELETE"];

// PUT | DELETE /api/v1/products/{id}/enrichment
export const action = ({ request, params }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: METHODS }, async ({ shop }) => {
    const gid = productGidFromParam(params.id);
    // Parse the body before the lookup so malformed JSON is a 400 even for a missing product.
    const body = request.method === "PUT" ? await readJsonBody(request) : undefined;

    const product = await getProductByGid(shop.id, gid);
    if (!product || product.deletedAt) throw new ApiError(404, "product_not_found", "Product not found");

    if (request.method === "DELETE") {
      await removeEnrichment(shop.id, product.id); // idempotent: absent enrichment is still 204
      return json(null, 204);
    }

    const result = validateEnrichment(body);
    if (!result.ok) throw new ApiError(422, "validation_failed", "Enrichment is not valid", result.errors);
    const saved = await saveEnrichment(shop.id, product.id, result.value);
    if (!saved) throw new ApiError(404, "product_not_found", "Product not found");
    return json({ data: serializeEnrichment(saved.enrichment) }, saved.created ? 201 : 200);
  });

export const loader = ({ request }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: METHODS }, async () => json({}));
