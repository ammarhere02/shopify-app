import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getProductByGid } from "../repositories/enrichment.server";
import { ApiError, json, productGidFromParam, withApiAuth } from "../services/api.server";
import { fetchProductForDescription, selectableImages } from "../services/description-generation.server";
import { apiGenerationDeps, withGenerationErrors } from "../services/generation-api.server";

// GET /api/v1/products/{id}/images
// The images a generation may use, read live from Shopify. Their ids are the only accepted
// `mediaIds`; a generation never takes an image URL from the caller.
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, ({ shop, requestId }) =>
    withGenerationErrors(async () => {
      const product = await getProductByGid(shop.id, productGidFromParam(params.id));
      if (!product || product.deletedAt) throw new ApiError(404, "product_not_found", "Product not found");
      const deps = await apiGenerationDeps(shop, requestId);
      const remote = await fetchProductForDescription(deps.shopify, product.shopifyProductGid);
      if (!remote) throw new ApiError(404, "product_not_found", "Product not found");
      return json({ data: selectableImages(remote) });
    }),
  );

export const action = ({ request }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async () => json({}));
