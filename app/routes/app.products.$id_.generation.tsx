import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { AiConfigError } from "../ai/config.server";
import { logger } from "../lib/logger.server";
import { getJob } from "../repositories/ai-generation.server";
import {
  GenerationError,
  createGenerationDeps,
  startGeneration,
} from "../services/description-generation.server";
import {
  applyGeneration,
  listDescriptionVersions,
  restoreVersion,
  serializeVersion,
} from "../services/description-apply.server";
import type { VersionView } from "../services/description-apply.server";
import { regenerate, reviewDraft, saveDraftEdit } from "../services/description-review.server";
import { serializeGeneration } from "../services/generation-view";
import type { GenerationView } from "../services/generation-view";
import { listPublications, publishProduct } from "../services/publication.server";
import type { PublicationChoice } from "../services/publication.server";
import { adminWriteLimiter } from "../services/admin-limits.server";
import { requireActiveShop } from "../services/shop.server";
import { ShopifyApiError, createShopifyClient } from "../shopify/graphql-client.server";
import { shopifyErrorMessage } from "../services/generation-api.server";
import { authenticate } from "../shopify.server";

// Resource route behind the AI Description section of the product page (no UI of its own).
// The trailing underscore in the file name keeps it out of the product page's layout.

const WRITE_INTENTS = new Set(["generate", "regenerate", "apply", "restore", "publish"]);

function parseId(raw: unknown) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Response("Not found", { status: 404 });
  return id;
}

export type GenerationActionResult =
  | { ok: true; message: string; job: GenerationView | null; versions?: VersionView[]; published?: { publicationId: string } }
  | { ok: false; message: string; errors: Record<string, string>; code?: string };

export type GenerationLoaderData =
  | { job: GenerationView }
  | { publications: PublicationChoice[]; productStatus: string }
  | { publicationsError: string };

// GET ?jobId=<id>: the page polls this while a job is QUEUED or RUNNING. A plain read.
// GET ?publications=1: sales channels for the Publish dialog (a live Shopify read).
export const loader = async ({ request, params }: LoaderFunctionArgs): Promise<GenerationLoaderData> => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);
  const productId = parseId(params.id);
  const url = new URL(request.url);
  if (url.searchParams.get("publications")) {
    try {
      const shopify = createShopifyClient(admin.graphql, { logContext: { shopId: shop.id, productId } });
      return await listPublications({ shopify }, shop, productId);
    } catch (err) {
      if (err instanceof GenerationError) return { publicationsError: err.message };
      if (err instanceof ShopifyApiError) return { publicationsError: shopifyErrorMessage(err) };
      throw err;
    }
  }
  const job = await getJob(shop.id, parseId(url.searchParams.get("jobId")));
  if (!job || job.productId !== productId) throw new Response("Not found", { status: 404 });
  return { job: serializeGeneration(job) };
};

export const action = async ({ request, params }: ActionFunctionArgs): Promise<GenerationActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);
  const productId = parseId(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  // Audit column for writes to Shopify. Sessions are offline (no staff identity), so the
  // most precise value available is "someone in this shop's admin".
  const actor = `admin:${session.shop}`;

  // Session auth has no per-key bucket like /api/v1, so the costly or Shopify-writing intents
  // get a per-shop limit here. Reads (saveDraft, approve, ...) are not limited.
  if (WRITE_INTENTS.has(intent)) {
    const hit = adminWriteLimiter.hit(String(shop.id));
    if (!hit.allowed) {
      logger.warn("ai.admin_rate_limited", { shopId: shop.id, productId, intent, retryAfterSec: hit.retryAfterSec });
      return { ok: false, message: `Too many requests. Try again in ${hit.retryAfterSec} seconds.`, errors: {}, code: "RATE_LIMITED" };
    }
  }

  try {
    if (intent === "apply" || intent === "restore" || intent === "publish") {
      const shopify = createShopifyClient(admin.graphql, { logContext: { shopId: shop.id, productId } });
      if (intent === "publish") {
        const published = await publishProduct({ shopify }, shop, productId, form.get("publicationId"), actor);
        return { ok: true, message: "Product published to the sales channel.", job: null, published };
      }
      if (intent === "apply") {
        const jobId = await ownJobId(shop.id, productId, form.get("jobId"));
        await applyGeneration({ shopify }, shop, jobId, actor);
        return done(shop.id, jobId, "Description written to Shopify.", productId);
      }
      const which = text("which") === "previous" ? "previous" : "written";
      await restoreVersion({ shopify }, shop, productId, parseId(form.get("versionId")), which, actor);
      return {
        ok: true,
        message: "Previous description restored in Shopify.",
        job: null,
        versions: (await listDescriptionVersions(shop.id, productId)).map(serializeVersion),
      };
    }

    if (intent === "generate" || intent === "regenerate") {
      const deps = createGenerationDeps(admin.graphql, { shopId: shop.id, productId });
      const common = {
        idempotencyKey: text("idempotencyKey"),
        mediaIds: form.getAll("mediaIds").map(String),
        merchantContext: text("merchantContext") || null,
        model: text("model") || null,
      };
      const started =
        intent === "generate"
          ? await startGeneration(deps, shop.id, { productId, ...common })
          : await regenerate(deps, shop.id, await ownJobId(shop.id, productId, form.get("jobId")), common);
      // Not awaited: the page polls the loader above. runGeneration records its own failures.
      if (started.run) void started.run();
      const job = await getJob(shop.id, started.job.id);
      return { ok: true, message: "Generation started.", job: serializeGeneration(job!) };
    }

    const jobId = await ownJobId(shop.id, productId, form.get("jobId"));
    if (intent === "saveDraft") {
      await saveDraftEdit(shop.id, jobId, form.get("descriptionHtml"));
      return done(shop.id, jobId, "Draft saved. Nothing was changed in Shopify.");
    }
    if (intent === "approve" || intent === "reject" || intent === "reopen") {
      // Approve stores the editor's current text first, so what is approved is what is on screen.
      if (intent === "approve" && form.has("descriptionHtml")) {
        await saveDraftEdit(shop.id, jobId, form.get("descriptionHtml"));
      }
      await reviewDraft(shop.id, jobId, intent);
      const message = { approve: "Draft approved.", reject: "Draft rejected.", reopen: "Draft reopened for editing." }[intent];
      return done(shop.id, jobId, message);
    }
    throw new Response("Unknown intent", { status: 400 });
  } catch (err) {
    if (err instanceof GenerationError) {
      return { ok: false, message: err.message, errors: err.details ?? {}, code: err.code };
    }
    if (err instanceof AiConfigError) {
      logger.warn("ai.not_configured", { shopId: shop.id, message: err.message });
      return { ok: false, message: "AI generation is not configured on this server.", errors: {} };
    }
    if (err instanceof ShopifyApiError) {
      // Shopify's own message stays in the log; the merchant gets a plain sentence and can retry.
      logger.warn("ai.shopify_failed", { shopId: shop.id, productId, intent, kind: err.kind, message: err.message });
      return { ok: false, message: shopifyErrorMessage(err), errors: {}, code: `SHOPIFY_${err.kind}` };
    }
    throw err;
  }
};

/** A job id only counts if it belongs to this shop AND this product. */
async function ownJobId(shopId: number, productId: number, raw: FormDataEntryValue | null) {
  const job = await getJob(shopId, parseId(raw));
  if (!job || job.productId !== productId) throw new GenerationError("NOT_FOUND", "Generation not found");
  return job.id;
}

async function done(shopId: number, jobId: number, message: string, productId?: number): Promise<GenerationActionResult> {
  const job = await getJob(shopId, jobId);
  const versions = productId ? (await listDescriptionVersions(shopId, productId)).map(serializeVersion) : undefined;
  return { ok: true, message, job: serializeGeneration(job!), versions };
}
