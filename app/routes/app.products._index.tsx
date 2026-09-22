import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { requireActiveShop } from "../services/shop.server";
import { listProducts } from "../repositories/enrichment.server";
import { PRODUCT_STATUSES } from "../lib/product-status";
import { AiConfigError, loadAiConfig } from "../ai/config.server";
import { logger } from "../lib/logger.server";
import { adminWriteLimiter } from "../services/admin-limits.server";
import { GenerationError, createGenerationDeps } from "../services/description-generation.server";
import { BATCH_MAX } from "../lib/generation-limits";
import { startBatchGeneration } from "../services/generation-batch.server";
import type { BatchResult } from "../services/generation-batch.server";

export type BatchActionResult =
  | { ok: true; message: string; result: BatchResult }
  | { ok: false; message: string; errors: Record<string, string> };

// intent=generateBatch: queue one description generation per selected product; the worker runs them.
export const action = async ({ request }: ActionFunctionArgs): Promise<BatchActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);
  const form = await request.formData();
  if (form.get("intent") !== "generateBatch") throw new Response("Unknown intent", { status: 400 });
  const hit = adminWriteLimiter.hit(String(shop.id));
  if (!hit.allowed) return { ok: false, message: `Too many requests. Try again in ${hit.retryAfterSec} seconds.`, errors: {} };
  try {
    const deps = createGenerationDeps(admin.graphql, { shopId: shop.id, batch: true });
    const result = await startBatchGeneration(deps, shop.id, {
      productIds: form.getAll("productIds").map((v) => Number(v)),
      merchantContext: String(form.get("merchantContext") ?? "") || null,
      model: String(form.get("model") ?? "") || null,
      idempotencyKey: String(form.get("idempotencyKey") ?? ""),
    });
    const queued = result.jobs.filter((j) => j.created).length;
    return { ok: true, message: `${queued} generation${queued === 1 ? "" : "s"} queued${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}. Open a product to review its draft.`, result };
  } catch (err) {
    if (err instanceof GenerationError) return { ok: false, message: err.message, errors: err.details ?? {} };
    if (err instanceof AiConfigError) {
      logger.warn("ai.not_configured", { shopId: shop.id, message: err.message });
      return { ok: false, message: "AI generation is not configured on this server.", errors: {} };
    }
    throw err;
  }
};

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

  // Model names only (never the key); an unconfigured server just hides the batch section.
  let aiModels: string[] = [];
  try {
    aiModels = loadAiConfig().models;
  } catch (err) {
    if (!(err instanceof AiConfigError)) throw err;
  }

  return {
    filters: { query, status: status ?? "", hasBadge: badgeParam ?? "" },
    nextCursor,
    aiModels,
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
  const { products, filters, nextCursor, aiModels } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [query, setQuery] = useState(filters.query);
  const [status, setStatus] = useState(filters.status);
  const [hasBadge, setHasBadge] = useState(filters.hasBadge);

  // Batch AI descriptions: one idempotency key per intended batch, replaced after success.
  const batch = useFetcher<BatchActionResult>();
  const [selected, setSelected] = useState<number[]>([]);
  const [batchContext, setBatchContext] = useState("");
  const [batchModel, setBatchModel] = useState(aiModels[0] ?? "");
  const batchKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (batch.data?.ok) {
      batchKey.current = crypto.randomUUID();
      setSelected([]);
    }
  }, [batch.data]);
  const toggle = (id: number, on: boolean) =>
    setSelected((ids) => (on ? [...ids.filter((i) => i !== id), id].slice(-BATCH_MAX) : ids.filter((i) => i !== id)));
  const queueBatch = () => {
    const form = new FormData();
    form.set("intent", "generateBatch");
    form.set("idempotencyKey", batchKey.current);
    form.set("merchantContext", batchContext);
    form.set("model", batchModel);
    for (const id of selected) form.append("productIds", String(id));
    batch.submit(form, { method: "post" });
  };

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
        {batch.data && (
          <s-banner tone={batch.data.ok ? "success" : "critical"}>
            {batch.data.message}
            {batch.data.ok && batch.data.result.skipped.length > 0 && (
              <s-unordered-list>
                {batch.data.result.skipped.map((s) => (
                  <s-list-item key={s.productId}>
                    {products.find((p) => p.id === s.productId)?.title ?? `#${s.productId}`}: {s.reason}
                  </s-list-item>
                ))}
              </s-unordered-list>
            )}
          </s-banner>
        )}
        {products.length === 0 ? (
          <s-paragraph>
            No products found. Run a sync from Home, or change the filters.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Select</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Vendor</s-table-header>
              <s-table-header>Badge</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.map((p) => (
                <s-table-row key={p.id}>
                  <s-table-cell>
                    <s-checkbox
                      label=""
                      accessibilityLabel={`Select ${p.title}`}
                      checked={selected.includes(p.id)}
                      disabled={p.status !== "ACTIVE" && p.status !== "DRAFT"}
                      onChange={(e) => toggle(p.id, e.currentTarget.checked)}
                    />
                  </s-table-cell>
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

      {products.length > 0 && aiModels.length > 0 && (
        <s-section heading="AI descriptions for selected products">
          <s-stack gap="base">
            <s-paragraph>
              Queues one generation per selected product (up to {BATCH_MAX}), using each product&apos;s first images. Drafts appear on
              each product page for review; nothing is written to Shopify.
            </s-paragraph>
            <s-text-area
              label="Facts for the writer (optional, applied to every product)"
              value={batchContext}
              rows={2}
              maxLength={2000}
              onInput={(e) => setBatchContext(e.currentTarget.value)}
            />
            {aiModels.length > 1 && (
              <s-select label="Model" value={batchModel} onChange={(e) => setBatchModel(e.currentTarget.value)}>
                {aiModels.map((m) => (
                  <s-option key={m} value={m}>
                    {m}
                  </s-option>
                ))}
              </s-select>
            )}
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button variant="primary" disabled={selected.length === 0 || batch.state !== "idle"} loading={batch.state !== "idle"} onClick={queueBatch}>
                Generate descriptions for {selected.length} selected
              </s-button>
              {selected.length > 0 && (
                <s-button variant="tertiary" onClick={() => setSelected([])}>
                  Clear selection
                </s-button>
              )}
            </s-stack>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
