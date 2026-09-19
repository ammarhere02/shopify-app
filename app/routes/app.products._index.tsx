import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { requireActiveShop } from "../services/shop.server";
import { listProducts } from "../repositories/enrichment.server";
import { PRODUCT_STATUSES } from "../lib/product-status";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);

  // Untrusted input: anything unexpected falls back to "no filter".
  const params = new URL(request.url).searchParams;
  const query = (params.get("query") ?? "").trim().slice(0, 100);
  const statusParam = params.get("status") ?? "";
  const status = PRODUCT_STATUSES.find((s) => s === statusParam);
  const badgeParam = params.get("hasBadge");
  const hasBadge =
    badgeParam === "true" ? true : badgeParam === "false" ? false : undefined;
  const after = Number(params.get("after"));

  const { products, nextCursor } = await listProducts(shop.id, {
    query: query || undefined,
    status,
    hasBadge,
    afterId: Number.isInteger(after) && after > 0 ? after : undefined,
  });

  return {
    filters: { query, status: status ?? "", hasBadge: badgeParam ?? "" },
    nextCursor,
    products: products.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      vendor: p.vendor,
      badge: p.enrichment && {
        text: p.enrichment.badgeText,
        active: p.enrichment.active,
      },
    })),
  };
};

export default function Products() {
  const { products, filters, nextCursor } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [query, setQuery] = useState(filters.query);
  const [status, setStatus] = useState(filters.status);
  const [hasBadge, setHasBadge] = useState(filters.hasBadge);

  const search = (after?: number) => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (status) params.set("status", status);
    if (hasBadge) params.set("hasBadge", hasBadge);
    if (after) params.set("after", String(after));
    navigate(`/app/products?${params}`);
  };

  return (
    <s-page heading="Products">
      <s-section heading="Search">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-search-field
              label="Title"
              placeholder="Search by title"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <s-select
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.currentTarget.value)}
            >
              <s-option value="">Any status</s-option>
              {PRODUCT_STATUSES.map((s) => (
                <s-option key={s} value={s}>
                  {s}
                </s-option>
              ))}
            </s-select>
            <s-select
              label="Badge"
              value={hasBadge}
              onChange={(e) => setHasBadge(e.currentTarget.value)}
            >
              <s-option value="">Any</s-option>
              <s-option value="true">Has badge</s-option>
              <s-option value="false">No badge</s-option>
            </s-select>
            <s-button variant="primary" type="submit">
              Search
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section heading="Results">
        {products.length === 0 ? (
          <s-paragraph>
            No products found. Run a sync from Home, or change the filters.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Vendor</s-table-header>
              <s-table-header>Badge</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-link href={`/app/products/${p.id}`}>{p.title}</s-link>
                  </s-table-cell>
                  <s-table-cell>{p.status}</s-table-cell>
                  <s-table-cell>{p.vendor || "—"}</s-table-cell>
                  <s-table-cell>
                    {p.badge ? (
                      <s-badge tone={p.badge.active ? "success" : "neutral"}>
                        {p.badge.text}
                        {p.badge.active ? "" : " (inactive)"}
                      </s-badge>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {nextCursor && (
          <s-button onClick={() => search(nextCursor)}>Next page</s-button>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
