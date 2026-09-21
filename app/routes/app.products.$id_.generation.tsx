import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { AiConfigError } from "../ai/config.server";
import { logger } from "../lib/logger.server";
import { getJob } from "../repositories/ai-generation.server";
import {
  GenerationError,
  createGenerationDeps,
  startGeneration,
} from "../services/description-generation.server";
import { regenerate, reviewDraft, saveDraftEdit } from "../services/description-review.server";
import { serializeGeneration } from "../services/generation-view";
import type { GenerationView } from "../services/generation-view";
import { requireActiveShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

// Resource route behind the AI Description section of the product page (no UI of its own).
// The trailing underscore in the file name keeps it out of the product page's layout.

function parseId(raw: unknown) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Response("Not found", { status: 404 });
  return id;
}

export type GenerationActionResult =
  | { ok: true; message: string; job: GenerationView }
  | { ok: false; message: string; errors: Record<string, string> };

// GET ?jobId=<id>: the page polls this while a job is QUEUED or RUNNING. A plain read.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);
  const productId = parseId(params.id);
  const job = await getJob(shop.id, parseId(new URL(request.url).searchParams.get("jobId")));
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

  try {
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
      return { ok: false, message: err.message, errors: err.details ?? {} };
    }
    if (err instanceof AiConfigError) {
      logger.warn("ai.not_configured", { shopId: shop.id, message: err.message });
      return { ok: false, message: "AI generation is not configured on this server.", errors: {} };
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

async function done(shopId: number, jobId: number, message: string): Promise<GenerationActionResult> {
  const job = await getJob(shopId, jobId);
  return { ok: true, message, job: serializeGeneration(job!) };
}
