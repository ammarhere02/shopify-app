import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getProductByGid } from "../repositories/enrichment.server";
import { ApiError, json, productGidFromParam, serializeProduct, withApiAuth } from "../services/api.server";

// GET /api/v1/products/{numeric Shopify product id}
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async ({ shop }) => {
    const product = await getProductByGid(shop.id, productGidFromParam(params.id));
    // Another shop's product and a product deleted in Shopify both look like "not found".
    if (!product || product.deletedAt) throw new ApiError(404, "product_not_found", "Product not found");
    return json({ data: serializeProduct(product) });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async () => json({}));
