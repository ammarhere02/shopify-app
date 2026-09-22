import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getProductByGid } from "../repositories/enrichment.server";
import { ApiError, json, productGidFromParam, readJsonBody, withApiAuth } from "../services/api.server";
import { apiShopifyClient, asObject, withGenerationErrors } from "../services/generation-api.server";
import {
  listPublicationActions,
  listPublications,
  publishProduct,
  serializePublicationAction,
} from "../services/publication.server";

async function requireProduct(shopId: number, idParam: string | undefined) {
  const product = await getProductByGid(shopId, productGidFromParam(idParam));
  if (!product || product.deletedAt) throw new ApiError(404, "product_not_found", "Product not found");
  return product;
}

// POST /api/v1/products/{id}/publish  Body: { publicationId: "gid://shopify/Publication/..." }
// 200 with the audit row. 409 when the product is not ACTIVE, 422 on Shopify userErrors,
// 403 missing_scope when write_publications was not granted.
export const action = ({ request, params }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"], bucket: "generation" }, ({ shop, requestId, actor }) =>
    withGenerationErrors(async () => {
      const product = await requireProduct(shop.id, params.id);
      const body = asObject(await readJsonBody(request));
      const shopify = await apiShopifyClient(shop, requestId);
      const result = await publishProduct({ shopify }, shop, product.id, body.publicationId, actor);
      return json({ data: result });
    }),
  );

// GET /api/v1/products/{id}/publish → the shop's sales channels with the product's state on
// each (live from Shopify), plus this app's publish history for the product.
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET", "POST"] }, ({ shop, requestId }) =>
    withGenerationErrors(async () => {
      const product = await requireProduct(shop.id, params.id);
      const shopify = await apiShopifyClient(shop, requestId);
      const [channels, history] = await Promise.all([
        listPublications({ shopify }, shop, product.id),
        listPublicationActions(shop.id, product.id),
      ]);
      return json({ data: { ...channels, history: history.map(serializePublicationAction) } });
    }),
  );
