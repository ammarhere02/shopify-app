import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PRODUCT_STATUSES } from "../lib/product-status";
import { listProducts, MAX_PAGE_SIZE } from "../repositories/enrichment.server";
import { ApiError, decodeCursor, encodeCursor, json, serializeProduct, withApiAuth } from "../services/api.server";

// GET /api/v1/products?query=&status=&hasBadge=&limit=&cursor=
export const loader = ({ request }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async ({ shop }) => {
    const params = new URL(request.url).searchParams;
    // Strict: a typo in a filter is a 400, not a silently unfiltered list.
    const query = params.get("query")?.trim() || undefined;
    if (query && query.length > 100) throw new ApiError(400, "invalid_filter", "query must be at most 100 characters");

    const statusParam = params.get("status");
    const status = PRODUCT_STATUSES.find((s) => s === statusParam);
    if (statusParam !== null && !status)
      throw new ApiError(400, "invalid_filter", `status must be one of ${PRODUCT_STATUSES.join(", ")}`);

    const badgeParam = params.get("hasBadge");
    if (badgeParam !== null && badgeParam !== "true" && badgeParam !== "false")
      throw new ApiError(400, "invalid_filter", "hasBadge must be true or false");

    const limitParam = params.get("limit");
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE))
      throw new ApiError(400, "invalid_filter", `limit must be between 1 and ${MAX_PAGE_SIZE}`);

    const cursorParam = params.get("cursor");
    const { products, nextCursor } = await listProducts(shop.id, {
      query,
      status,
      hasBadge: badgeParam === null ? undefined : badgeParam === "true",
      limit,
      afterId: cursorParam === null ? undefined : decodeCursor(cursorParam),
    });

    return json({
      data: products.map(serializeProduct),
      pageInfo: { hasNextPage: nextCursor !== null, nextCursor: nextCursor === null ? null : encodeCursor(nextCursor) },
    });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async () => json({}));
