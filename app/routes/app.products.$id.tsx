import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { requireActiveShop } from "../services/shop.server";
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
import { serializeGeneration } from "../services/generation-view";
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

  return {
    ai: {
      ...ai,
      images,
      imagesError,
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

export default function ProductDetail() {
  const { product, enrichment, ai } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const errors: Record<string, string> = fetcher.data?.errors ?? {};

  const [badgeText, setBadgeText] = useState(enrichment?.badgeText ?? "");
  const [badgeColor, setBadgeColor] = useState(
    enrichment?.badgeColor ?? "#1A7F37",
  );
  const [internalNote, setInternalNote] = useState(
    enrichment?.internalNote ?? "",
  );
  const [active, setActive] = useState(enrichment?.active ?? true);

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

  return (
    <s-page heading={product.title}>
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>

      {product.deleted && (
        <s-banner tone="warning">
          This product no longer exists in Shopify. Its badge is kept for
          history but will not show on the storefront.
        </s-banner>
      )}
      {fetcher.data && (
        <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
          {fetcher.data.message}
        </s-banner>
      )}

      <s-section heading="Badge and note">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <s-stack gap="base">
            <s-text-field
              label="Badge text"
              details="Shown publicly on the product page."
              value={badgeText}
              maxLength={BADGE_TEXT_MAX}
              required
              error={errors.badgeText}
              onInput={(e) => setBadgeText(e.currentTarget.value)}
            />
            <s-color-field
              label="Badge color"
              value={badgeColor}
              error={errors.badgeColor}
              onChange={(e) => setBadgeColor(e.currentTarget.value)}
            />
            <s-checkbox
              label="Active (show on storefront)"
              checked={active}
              onChange={(e) => setActive(e.currentTarget.checked)}
            />
            <s-text-area
              label="Internal note"
              details="Private. Never sent to the storefront."
              value={internalNote}
              rows={4}
              error={errors.internalNote}
              onInput={(e) => setInternalNote(e.currentTarget.value)}
            />
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" type="submit" loading={busy}>
                Save
              </s-button>
              {enrichment && (
                <s-button
                  tone="critical"
                  disabled={busy}
                  onClick={() =>
                    fetcher.submit({ intent: "remove" }, { method: "post" })
                  }
                >
                  Remove badge
                </s-button>
              )}
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      {!product.deleted && (
        <AiDescriptionSection
          productId={product.id}
          configured={ai.configured}
          models={ai.models}
          maxImages={ai.maxImages}
          images={ai.images}
          imagesError={ai.imagesError}
          latest={ai.latest}
          history={ai.history}
        />
      )}

      <s-section heading="Shopify data (read-only)">
        <s-paragraph>Status: {product.status}</s-paragraph>
        <s-paragraph>ID: {product.shopifyProductGid}</s-paragraph>
        <s-unordered-list>
          {product.variants.map((v) => (
            <s-list-item key={v.id}>
              {v.title} · {v.sku || "no SKU"} · {v.price}
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
