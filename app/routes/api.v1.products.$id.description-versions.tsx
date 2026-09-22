import type { LoaderFunctionArgs } from "react-router";
import { getProductByGid } from "../repositories/enrichment.server";
import { ApiError, json, productGidFromParam, withApiAuth } from "../services/api.server";
import { listDescriptionVersions, serializeVersion } from "../services/description-apply.server";

// GET /api/v1/products/{id}/description-versions → versions this app wrote, newest first (max 20).
// A soft-deleted product still lists its history.
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async ({ shop }) => {
    const product = await getProductByGid(shop.id, productGidFromParam(params.id));
    if (!product) throw new ApiError(404, "product_not_found", "Product not found");
    const versions = await listDescriptionVersions(shop.id, product.id);
    return json({ data: versions.map(serializeVersion) });
  });
