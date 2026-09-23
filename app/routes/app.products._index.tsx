import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { requireActiveShop } from "../services/shop.server";
import { listProducts } from "../repositories/enrichment.server";
import { latestJobStatusByProduct } from "../repositories/ai-generation.server";
import { aiStatusLabel } from "../services/generation-view";
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

  // One query for the whole page: the latest generation of each listed product.
  const latestJobs = await latestJobStatusByProduct(shop.id, products.map((p) => p.id));

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
      aiStatus: aiStatusLabel(latestJobs.get(p.id)),
      badge: p.enrichment && {
        text: p.enrichment.badgeText,
        active: p.enrichment.active,
      },
    })),
  };
};

const STATUS_TONE = { ACTIVE: "success", DRAFT: "info", ARCHIVED: "neutral" } as const;

export default function Products() {
  const { products, filters, nextCursor, aiModels } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const loadingList = navigation.state === "loading";
  const [query, setQuery] = useState(filters.query);
  const [status, setStatus] = useState(filters.status);
  const [hasBadge, setHasBadge] = useState(filters.hasBadge);

  // Batch AI descriptions: one idempotency key per intended batch, replaced after success.
  const batch = useFetcher<BatchActionResult>();
  const batchBusy = batch.state !== "idle";
  const [selected, setSelected] = useState<number[]>([]);
  const [batchContext, setBatchContext] = useState("");
  const [batchModel, setBatchModel] = useState(aiModels[0] ?? "");
  const batchKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (batch.state !== "idle" || !batch.data?.ok) return;
    batchKey.current = crypto.randomUUID();
    setSelected([]);
    shopify.toast.show(batch.data.message);
  }, [batch.state, batch.data]);
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
  const filtered = Boolean(filters.query || filters.status || filters.hasBadge);
  const skipped = batch.data?.ok ? batch.data.result.skipped : [];

  return (
    <s-page heading="Products">
      <s-link slot="secondary-actions" href="/app/sync">
        Sync
      </s-link>

      {batch.data && !batch.data.ok && (
        <s-banner tone="critical" heading="Could not queue descriptions">
          {batch.data.message}
        </s-banner>
      )}
      {skipped.length > 0 && (
        <s-banner tone="warning" heading={`${skipped.length} product${skipped.length === 1 ? "" : "s"} skipped`}>
          <s-unordered-list>
            {skipped.map((s) => (
              <s-list-item key={s.productId}>
                {products.find((p) => p.id === s.productId)?.title ?? `#${s.productId}`}: {s.reason}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      <s-section accessibilityLabel="Product catalogue">
        <s-stack gap="base">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              search();
            }}
          >
            <s-grid gridTemplateColumns="@container (inline-size > 640px) 2fr 1fr 1fr auto, 1fr" gap="base" alignItems="end">
              <s-search-field
                label="Search"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by title"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <s-select label="Status" labelAccessibilityVisibility="exclusive" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
                <s-option value="">Any status</s-option>
                {PRODUCT_STATUSES.map((s) => (
                  <s-option key={s} value={s}>
                    {s.charAt(0) + s.slice(1).toLowerCase()}
                  </s-option>
                ))}
              </s-select>
              <s-select label="Badge" labelAccessibilityVisibility="exclusive" value={hasBadge} onChange={(e) => setHasBadge(e.currentTarget.value)}>
                <s-option value="">Any badge</s-option>
                <s-option value="true">Has badge</s-option>
                <s-option value="false">No badge</s-option>
              </s-select>
              <s-button type="submit" loading={loadingList}>
                Filter
              </s-button>
            </s-grid>
          </form>

          {products.length === 0 ? (
            <s-box padding="large" border="base" borderRadius="base">
              <s-stack gap="small" alignItems="center">
                <s-heading>{filtered ? "No products match these filters" : "No products yet"}</s-heading>
                <s-paragraph>
                  {filtered ? "Change the filters or clear the search." : "Run a sync to copy your Shopify catalogue into the app."}
                </s-paragraph>
                {!filtered && <s-link href="/app/sync">Go to Sync</s-link>}
              </s-stack>
            </s-box>
          ) : (
            <s-table
              loading={loadingList}
              paginate
              hasNextPage={Boolean(nextCursor)}
              hasPreviousPage={false}
              onNextPage={() => nextCursor && search(nextCursor)}
            >
              <s-table-header-row>
                <s-table-header listSlot="inline">Select</s-table-header>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="secondary">Status</s-table-header>
                <s-table-header listSlot="labeled">AI description</s-table-header>
                <s-table-header listSlot="labeled">Badge</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {products.map((p) => (
                  <s-table-row key={p.id}>
                    <s-table-cell>
                      <s-checkbox
                        label=""
                        accessibilityLabel={`Select ${p.title}`}
                        checked={selected.includes(p.id)}
                        disabled={(p.status !== "ACTIVE" && p.status !== "DRAFT") || batchBusy}
                        onChange={(e) => toggle(p.id, e.currentTarget.checked)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack gap="none">
                        <s-link href={`/app/products/${p.id}`}>{p.title}</s-link>
                        {p.vendor && <s-text color="subdued">{p.vendor}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[p.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                        {p.status.charAt(0) + p.status.slice(1).toLowerCase()}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={p.aiStatus.tone}>{p.aiStatus.label}</s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {p.badge ? (
                        <s-badge tone={p.badge.active ? "success" : "neutral"}>
                          {p.badge.text}
                          {p.badge.active ? "" : " (inactive)"}
                        </s-badge>
                      ) : (
                        <s-text color="subdued">None</s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>

      {products.length > 0 && aiModels.length > 0 && (
        <s-section heading="Generate AI descriptions">
          <s-stack gap="base">
            <s-paragraph>
              Select up to {BATCH_MAX} active or draft products above. One draft is written per product from its first
              images; review each draft on the product page. Nothing is sent to Shopify.
            </s-paragraph>
            <s-grid gridTemplateColumns={aiModels.length > 1 ? "@container (inline-size > 640px) 2fr 1fr, 1fr" : "1fr"} gap="base">
              <s-text-area
                label="Facts for the writer (optional, applied to every product)"
                value={batchContext}
                rows={2}
                maxLength={2000}
                disabled={batchBusy}
                onInput={(e) => setBatchContext(e.currentTarget.value)}
              />
              {aiModels.length > 1 && (
                <s-select label="Model" value={batchModel} disabled={batchBusy} onChange={(e) => setBatchModel(e.currentTarget.value)}>
                  {aiModels.map((m) => (
                    <s-option key={m} value={m}>
                      {m}
                    </s-option>
                  ))}
                </s-select>
              )}
            </s-grid>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button variant="primary" disabled={selected.length === 0 || batchBusy} loading={batchBusy} onClick={queueBatch}>
                Generate for {selected.length} selected
              </s-button>
              {selected.length > 0 && !batchBusy && (
                <s-button variant="tertiary" onClick={() => setSelected([])}>
                  Clear selection
                </s-button>
              )}
              <s-text color="subdued">
                {selected.length === 0 ? "No products selected." : `${selected.length} of ${BATCH_MAX} selected.`}
              </s-text>
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
