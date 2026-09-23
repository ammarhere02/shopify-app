import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getProductById,
  removeEnrichment,
  saveEnrichment,
} from "../repositories/enrichment.server";
import {
  BADGE_TEXT_MAX,
  validateEnrichment,
} from "../services/enrichment-validation";
import { logger } from "../lib/logger.server";
import { AiConfigError, loadAiConfig } from "../ai/config.server";
import { AiDescriptionSection } from "../components/AiDescriptionSection";
import type { AiImage } from "../components/AiDescriptionSection";
import { getJob, listJobsForProduct } from "../repositories/ai-generation.server";
import {
  fetchProductForDescription,
  selectableImages,
} from "../services/description-generation.server";
import { listDescriptionVersions, serializeVersion } from "../services/description-apply.server";
import { serializeGeneration } from "../services/generation-view";
import { hasScope, requireActiveShop } from "../services/shop.server";
import { createShopifyClient } from "../shopify/graphql-client.server";

function parseId(raw: string | undefined) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0)
    throw new Response("Product not found", { status: 404 });
  return id;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);
  // Scoped by shop: another shop's id simply looks like "not found".
  const product = await getProductById(shop.id, parseId(params.id));
  if (!product) throw new Response("Product not found", { status: 404 });

  // AI description: only names and limits reach the browser, never the key.
  let ai = { configured: false, models: [] as string[], maxImages: 4 };
  try {
    const config = loadAiConfig();
    ai = { configured: true, models: config.models, maxImages: config.maxImages };
  } catch (err) {
    if (!(err instanceof AiConfigError)) throw err;
  }
  // Images are read live: the local projection does not store media. A failure here must not
  // take the badge editor down with it.
  let images: AiImage[] = [];
  let imagesError: string | null = null;
  if (!product.deletedAt) {
    try {
      const client = createShopifyClient(admin.graphql, { logContext: { shopId: shop.id, productId: product.id } });
      const remote = await fetchProductForDescription(client, product.shopifyProductGid);
      images = remote ? selectableImages(remote) : [];
    } catch (err) {
      if (err instanceof Response) throw err; // re-authentication
      imagesError = "Could not load this product's images from Shopify. Reload to try again.";
    }
  }
  const jobs = await listJobsForProduct(shop.id, product.id, 10);
  const latest = jobs[0] ? await getJob(shop.id, jobs[0].id) : null;
  const versions = (await listDescriptionVersions(shop.id, product.id)).map(serializeVersion);

  return {
    ai: {
      ...ai,
      images,
      imagesError,
      // Writing needs scopes granted after the first install; the page says so instead of failing late.
      canWrite: hasScope(shop.scopes, "write_products"),
      canPublish: hasScope(shop.scopes, "write_publications"),
      versions,
      latest: latest ? serializeGeneration(latest) : null,
      history: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        reviewStatus: j.reviewStatus,
        model: j.model,
        createdAt: j.createdAt.toISOString(),
      })),
    },
    product: {
      id: product.id,
      title: product.title,
      status: product.status,
      shopifyProductGid: product.shopifyProductGid,
      deleted: product.deletedAt !== null,
      variants: product.variants.map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        price: v.price.toString(),
      })),
    },
    enrichment: product.enrichment && {
      badgeText: product.enrichment.badgeText,
      badgeColor: product.enrichment.badgeColor,
      internalNote: product.enrichment.internalNote ?? "",
      active: product.enrichment.active,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);
  const productId = parseId(params.id);
  const form = await request.formData();

  if (form.get("intent") === "remove") {
    const found = await removeEnrichment(shop.id, productId);
    if (!found) throw new Response("Product not found", { status: 404 });
    logger.info("enrichment.removed", { shopId: shop.id, productId });
    return { ok: true, message: "Badge removed.", errors: {} };
  }

  const result = validateEnrichment({
    badgeText: form.get("badgeText"),
    badgeColor: form.get("badgeColor"),
    internalNote: form.get("internalNote"),
    active: form.get("active") === "true",
  });
  if (!result.ok)
    return { ok: false, message: "Please fix the errors.", errors: result.errors };

  const saved = await saveEnrichment(shop.id, productId, result.value);
  if (!saved) throw new Response("Product not found", { status: 404 });
  logger.info("enrichment.saved", { shopId: shop.id, productId });
  return { ok: true, message: "Badge saved.", errors: {} };
};

const STATUS_TONE = { ACTIVE: "success", DRAFT: "info", ARCHIVED: "neutral" } as const;

export default function ProductDetail() {
  const { product, enrichment, ai } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const pending = fetcher.formData?.get("intent");
  const errors: Record<string, string> = fetcher.data?.errors ?? {};
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [badgeText, setBadgeText] = useState(enrichment?.badgeText ?? "");
  const [badgeColor, setBadgeColor] = useState(
    enrichment?.badgeColor ?? "#1A7F37",
  );
  const [internalNote, setInternalNote] = useState(
    enrichment?.internalNote ?? "",
  );
  const [active, setActive] = useState(enrichment?.active ?? true);

  // Success is a toast; validation errors stay next to the fields.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) shopify.toast.show(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  const save = () =>
    fetcher.submit(
      {
        intent: "save",
        badgeText,
        badgeColor,
        internalNote,
        active: String(active),
      },
      { method: "post" },
    );

  // Rendered exactly once: inside the AI workspace's left column, or on its own for a deleted product.
  const badgeEditor = (
    <s-section heading="Storefront badge">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <s-stack gap="small">
          {fetcher.data && !fetcher.data.ok && <s-banner tone="critical">{fetcher.data.message}</s-banner>}
          <s-text-field
            label="Badge text"
            value={badgeText}
            maxLength={BADGE_TEXT_MAX}
            required
            disabled={busy}
            error={errors.badgeText}
            onInput={(e) => setBadgeText(e.currentTarget.value)}
          />
          <s-color-field
            label="Colour"
            value={badgeColor}
            disabled={busy}
            error={errors.badgeColor}
            onChange={(e) => setBadgeColor(e.currentTarget.value)}
          />
          <s-checkbox
            label="Show on storefront"
            checked={active}
            disabled={busy}
            onChange={(e) => setActive(e.currentTarget.checked)}
          />
          <s-text-area
            label="Internal note"
            details="Private. Never sent to the storefront."
            value={internalNote}
            rows={2}
            disabled={busy}
            error={errors.internalNote}
            onInput={(e) => setInternalNote(e.currentTarget.value)}
          />
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-button variant="primary" type="submit" loading={pending === "save"} disabled={busy}>
              {enrichment ? "Save badge" : "Add badge"}
            </s-button>
            {enrichment && (
              <s-button
                tone="critical"
                variant="tertiary"
                loading={pending === "remove"}
                disabled={busy}
                onClick={() =>
                  fetcher.submit({ intent: "remove" }, { method: "post" })
                }
              >
                Remove
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </form>
    </s-section>
  );

  const details = (
    <s-section heading="Product details">
      <s-stack gap="small">
        <s-text color="subdued">Read-only copy from the last sync.</s-text>
        <s-button variant="tertiary" onClick={() => setDetailsOpen((v) => !v)}>
          {detailsOpen ? "Hide details" : `Show details (${product.variants.length} variant${product.variants.length === 1 ? "" : "s"})`}
        </s-button>
        {detailsOpen && (
          <s-stack gap="small">
            <s-text color="subdued">{product.shopifyProductGid.replace("gid://shopify/Product/", "Shopify ID ")}</s-text>
            {product.variants.length === 0 ? (
              <s-text color="subdued">No variants synced.</s-text>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Variant</s-table-header>
                  <s-table-header listSlot="secondary">SKU</s-table-header>
                  <s-table-header listSlot="inline" format="numeric">Price</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {product.variants.map((v) => (
                    <s-table-row key={v.id}>
                      <s-table-cell>{v.title}</s-table-cell>
                      <s-table-cell>{v.sku || "—"}</s-table-cell>
                      <s-table-cell>{v.price}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );

  return (
    <s-page heading={product.title}>
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>

      <s-stack direction="inline" gap="small" alignItems="center">
        {ai.images[0] && <s-thumbnail src={ai.images[0].url} alt={ai.images[0].alt ?? product.title} size="small" />}
        <s-badge tone={STATUS_TONE[product.status as keyof typeof STATUS_TONE] ?? "neutral"}>
          {product.status.charAt(0) + product.status.slice(1).toLowerCase()}
        </s-badge>
        {product.deleted && <s-badge tone="warning">Deleted in Shopify</s-badge>}
        {enrichment && (
          <s-badge tone={enrichment.active ? "success" : "neutral"}>
            {enrichment.active ? "Badge live" : "Badge inactive"}
          </s-badge>
        )}
      </s-stack>

      {product.deleted && (
        <s-banner tone="warning">
          This product no longer exists in Shopify. Its badge is kept for
          history but will not show on the storefront.
        </s-banner>
      )}

      {product.deleted ? (
        <s-grid gridTemplateColumns="@container (inline-size > 900px) 300px minmax(0, 1fr), minmax(0, 1fr)" gap="base" alignItems="start">
          <s-stack gap="base">
            {badgeEditor}
            {details}
          </s-stack>
        </s-grid>
      ) : (
        <AiDescriptionSection
          productId={product.id}
          configured={ai.configured}
          models={ai.models}
          maxImages={ai.maxImages}
          images={ai.images}
          imagesError={ai.imagesError}
          latest={ai.latest}
          history={ai.history}
          versions={ai.versions}
          canWrite={ai.canWrite}
          canPublish={ai.canPublish}
          productStatus={product.status}
          asideTop={badgeEditor}
          asideBottom={details}
        />
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
