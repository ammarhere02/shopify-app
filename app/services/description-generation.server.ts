/**
 * Purpose: Creates and runs one AI description generation job (web research, then the description).
 * Called by: The admin generation route and the /api/v1 generation routes (start); the worker (run).
 * Input: Shop, product, selected media ids, merchant context, model, idempotency key.
 * Output: A QUEUED job row (plus a run function for inline use) that ends SUCCEEDED with a draft
 *         (and a research record with source URLs) or FAILED.
 * Uses: Shopify client (product + images), OpenRouter client, ai-generation repository.
 * Does not: Write anything to Shopify or decide what the merchant approves.
 */
import type { AiGenerationJob } from "@prisma/client";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import { loadAiConfig, resolveModel } from "../ai/config.server";
import type { AiConfig } from "../ai/config.server";
import { AiProviderError, createOpenRouterClient } from "../ai/openrouter-client.server";
import type { OpenRouterClient } from "../ai/openrouter-client.server";
import { createShopifyClient } from "../shopify/graphql-client.server";
import type { AdminGraphql, ShopifyClient } from "../shopify/graphql-client.server";
import { PRODUCT_FOR_DESCRIPTION_QUERY } from "../shopify/queries";
import {
  completeJob,
  countActiveJobs,
  countJobsSince,
  createJob,
  failAbandonedJobs,
  failJob,
  findJobByIdempotencyKey,
  markJobRunning,
} from "../repositories/ai-generation.server";
import {
  DESCRIPTION_JSON_SCHEMA,
  RESEARCH_JSON_SCHEMA,
  detectUnsupportedClaims,
  failedResearch,
  mergeWarnings,
  skippedResearch,
  validateModelOutput,
  validateResearchOutput,
} from "./description-output";
import type { ResearchRecord } from "./description-output";
import {
  MERCHANT_CONTEXT_MAX,
  PROMPT_VERSION,
  buildDescriptionMessages,
  buildResearchMessages,
  researchPlan,
  trustedText,
} from "./description-prompt";
import type { PromptImage, PromptProduct } from "./description-prompt";
import { htmlToText } from "./html-sanitize";
import { hashGenerationInput, sha256Hex } from "./input-hash.server";

const PROVIDER = "openrouter";
const DAY_MS = 24 * 60 * 60 * 1000;
const MEDIA_GID = /^gid:\/\/shopify\/MediaImage\/[1-9]\d{0,19}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const RAW_ERROR_SAMPLE = 300;

export type GenerationErrorCode =
  | "VALIDATION" // bad request content → 422
  | "NOT_FOUND" // product unknown to this shop, or gone from Shopify → 404
  | "LIMIT" // per-shop concurrency or daily limit → 429
  | "CONFLICT" // the job is not in a state that allows this → 409
  | "STALE" // the product changed in Shopify since the text was generated → 409
  | "REJECTED" // Shopify answered with userErrors → 422
  | "FORBIDDEN"; // the shop has not granted a scope the operation needs → 403

export class GenerationError extends Error {
  constructor(
    public code: GenerationErrorCode,
    message: string,
    public details?: Record<string, string>,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

export type GenerationDeps = {
  shopify: ShopifyClient;
  ai: OpenRouterClient;
  config: AiConfig;
};

/**
 * The real clients for a request. Throws AiConfigError when OpenRouter is not configured,
 * which routes report as "not configured" instead of failing the whole page.
 */
export function createGenerationDeps(
  graphql: AdminGraphql,
  logContext: Record<string, unknown>,
): GenerationDeps {
  const config = loadAiConfig();
  return {
    config,
    shopify: createShopifyClient(graphql, { logContext }),
    ai: createOpenRouterClient(config, { logContext }),
  };
}

export type StartGenerationInput = {
  productId: number;
  mediaIds: string[];
  merchantContext?: string | null;
  model?: string | null;
  idempotencyKey: string;
  previousJobId?: number | null;
  /**
   * Create the QUEUED row and stop: no `run` is returned, the worker picks the job up.
   * The concurrency limit is skipped (queued jobs wait their turn); the daily limit still counts.
   */
  enqueueOnly?: boolean;
};

type MediaNode = {
  id: string;
  alt: string | null;
  mediaContentType: string;
  status: string;
  image?: { url: string; width: number | null; height: number | null } | null;
};

type ProductForDescription = {
  id: string;
  title: string;
  descriptionHtml: string | null;
  updatedAt: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: string;
  media: { nodes: MediaNode[] };
};

export type ProductImageChoice = { id: string; url: string; alt: string | null };

/** Images the merchant may choose from: READY Shopify-hosted images of this product. */
export function selectableImages(product: ProductForDescription): ProductImageChoice[] {
  return product.media.nodes
    .filter((m) => m.mediaContentType === "IMAGE" && m.status === "READY" && m.image?.url)
    .map((m) => ({ id: m.id, url: m.image!.url, alt: m.alt }));
}

/** Live read of the fields a generation needs. Null when Shopify no longer has the product. */
export async function fetchProductForDescription(shopify: ShopifyClient, shopifyProductGid: string) {
  const data = await shopify.query<{ product: ProductForDescription | null }>(
    "ProductForDescription",
    PRODUCT_FOR_DESCRIPTION_QUERY,
    { id: shopifyProductGid },
  );
  return data.product;
}

function validateRequest(input: StartGenerationInput, config: AiConfig) {
  const errors: Record<string, string> = {};
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey ?? "")) {
    errors.idempotencyKey = "Must be 8-64 characters: letters, digits, - or _";
  }
  const ids = input.mediaIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > config.maxImages) {
    errors.mediaIds = `Select between 1 and ${config.maxImages} images`;
  } else if (!ids.every((id) => typeof id === "string" && MEDIA_GID.test(id))) {
    // Only media ids are accepted. There is no way to pass a URL.
    errors.mediaIds = "Each image must be a Shopify MediaImage id";
  } else if (new Set(ids).size !== ids.length) {
    errors.mediaIds = "The same image was selected twice";
  }
  const context = input.merchantContext;
  if (context != null && typeof context !== "string") errors.merchantContext = "Must be text";
  else if (context && context.length > MERCHANT_CONTEXT_MAX) {
    errors.merchantContext = `Must be at most ${MERCHANT_CONTEXT_MAX} characters`;
  }
  if (Object.keys(errors).length) throw new GenerationError("VALIDATION", "Invalid generation request", errors);
}

type Prepared = { model: string; product: PromptProduct; images: PromptImage[]; merchantContext: string | null };

/**
 * Create a generation job. Returns the job and, when it is new, a `run` function the caller
 * starts WITHOUT awaiting (same pattern as the product sync), then answers 202.
 *
 * Order matters:
 *  1. validate the request (nothing is fetched or stored for a bad request);
 *  2. a known idempotency key returns its job at once: a retry costs nothing and is never rate-limited;
 *  3. live Shopify read: the selected media must belong to THIS product of THIS shop;
 *  4. under a lock on the shop row: limits, then the job row. Two simultaneous clicks cannot both pass.
 */
export async function startGeneration(
  deps: GenerationDeps,
  shopId: number,
  input: StartGenerationInput,
): Promise<{ job: AiGenerationJob; created: boolean; run?: () => Promise<void> }> {
  validateRequest(input, deps.config);
  let model: string;
  try {
    model = resolveModel(deps.config, input.model);
  } catch {
    throw new GenerationError("VALIDATION", "Invalid generation request", { model: "Model is not allowed" });
  }

  const existing = await findJobByIdempotencyKey(shopId, input.idempotencyKey);
  if (existing) return { job: existing, created: false };

  const local = await db.product.findFirst({
    where: { id: input.productId, shopId, deletedAt: null },
    include: { variants: { select: { sku: true } } },
  });
  if (!local) throw new GenerationError("NOT_FOUND", "Product not found");

  const remote = await fetchProductForDescription(deps.shopify, local.shopifyProductGid);
  if (!remote) throw new GenerationError("NOT_FOUND", "Product no longer exists in Shopify");

  const available = new Map(selectableImages(remote).map((image) => [image.id, image]));
  const images = input.mediaIds.map((id) => available.get(id));
  if (images.some((image) => !image)) {
    throw new GenerationError("VALIDATION", "Invalid generation request", {
      mediaIds: "Every image must be a ready image of this product",
    });
  }
  const chosen = images as ProductImageChoice[];

  const merchantContext = input.merchantContext?.trim() || null;
  const descriptionHtml = remote.descriptionHtml ?? "";
  const skus = [...new Set(local.variants.map((v) => v.sku?.trim()).filter((sku): sku is string => !!sku))];
  const product: PromptProduct = {
    title: remote.title,
    vendor: remote.vendor,
    productType: remote.productType,
    tags: remote.tags,
    skus,
    currentDescriptionText: htmlToText(descriptionHtml),
  };
  // What the model was given, plus what Apply needs later to detect a stale product.
  const productSnapshot = {
    shopifyProductGid: remote.id,
    title: remote.title,
    vendor: remote.vendor,
    productType: remote.productType,
    tags: remote.tags,
    skus,
    status: remote.status,
    shopifyUpdatedAt: remote.updatedAt,
    descriptionHtml,
    descriptionHash: sha256Hex(descriptionHtml),
    images: chosen,
  };
  const inputHash = hashGenerationInput({
    productSnapshot,
    merchantContext,
    selectedMediaIds: input.mediaIds,
    model,
    promptVersion: PROMPT_VERSION,
  });

  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM shops WHERE id = ${shopId} FOR UPDATE`;
    const retried = await findJobByIdempotencyKey(shopId, input.idempotencyKey, tx);
    if (retried) return { job: retried, created: false };

    await failAbandonedJobs(shopId, new Date(), tx);
    if (!input.enqueueOnly && (await countActiveJobs(shopId, tx)) >= deps.config.maxConcurrentPerShop) {
      throw new GenerationError("LIMIT", "Another generation is still running for this shop");
    }
    if ((await countJobsSince(shopId, new Date(Date.now() - DAY_MS), tx)) >= deps.config.dailyLimitPerShop) {
      throw new GenerationError("LIMIT", "Daily generation limit reached");
    }
    const created = await createJob(
      shopId,
      {
        productId: local.id,
        idempotencyKey: input.idempotencyKey,
        previousJobId: input.previousJobId ?? null,
        provider: PROVIDER,
        model,
        promptVersion: PROMPT_VERSION,
        inputHash,
        selectedMediaIds: input.mediaIds,
        productSnapshot,
        merchantContext,
      },
      tx,
    );
    if (!created) throw new GenerationError("NOT_FOUND", "Previous generation not found");
    return created;
  });

  if (!result.created) return result;
  const prepared: Prepared = {
    model,
    product,
    images: chosen.map(({ url, alt }) => ({ url, alt })),
    merchantContext,
  };
  logger.info("ai.job_created", { shopId, productId: local.id, jobId: result.job.id, model, images: chosen.length, queued: !!input.enqueueOnly });
  if (input.enqueueOnly) return result;
  return { ...result, run: () => runGeneration(deps, shopId, result.job.id, prepared) };
}

type StoredSnapshot = {
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  /** Absent on jobs created before SKUs were sent to the model. */
  skus?: string[];
  descriptionHtml: string;
  images: ProductImageChoice[];
};

/**
 * Rebuild the prompt input from what the job stored, so a worker can run a job created by
 * another request or another process. Identical to what the inline run would have used:
 * the snapshot is the trusted product data at creation time, by design (see input hash).
 */
export function prepareFromJob(job: AiGenerationJob & { input: { productSnapshotJson: unknown; merchantContext: string | null } | null }): Prepared | null {
  const snapshot = job.input?.productSnapshotJson as StoredSnapshot | null | undefined;
  if (!snapshot || !Array.isArray(snapshot.images)) return null;
  return {
    model: job.model,
    product: {
      title: snapshot.title,
      vendor: snapshot.vendor,
      productType: snapshot.productType,
      tags: snapshot.tags ?? [],
      skus: snapshot.skus ?? [],
      currentDescriptionText: htmlToText(snapshot.descriptionHtml ?? ""),
    },
    images: snapshot.images.map(({ url, alt }) => ({ url, alt })),
    merchantContext: job.input?.merchantContext ?? null,
  };
}

/** What a worker needs to run a job: no Shopify client, the snapshot already holds the product. */
export type RunDeps = Pick<GenerationDeps, "ai" | "config">;

/** Research answers are short JSON; a smaller budget than the description keeps the second call cheap. */
const RESEARCH_MAX_OUTPUT_TOKENS = 1_000;

type Usage = { promptTokens: number | null; completionTokens: number | null; cost: number | null; latencyMs: number };

const addNullable = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/**
 * Call 1 of 2: ask the model, with the web search tool, for the exact product's specifications.
 * Never throws and never fails the job. Any failure (provider error, unreadable answer, product not
 * identified, sources not confirmed) ends as a record the merchant sees; the description is then
 * written from the Shopify data alone. Returns the record and what the call cost.
 */
async function researchProduct(deps: RunDeps, prepared: Prepared, log: Record<string, unknown>): Promise<{ research: ResearchRecord; usage: Usage | null }> {
  const nothing = { usage: null };
  if (!deps.config.research) return { ...nothing, research: skippedResearch("Not researched: web research is switched off for this app.") };
  const plan = researchPlan(prepared.product);
  if (!plan.research) return { ...nothing, research: skippedResearch(plan.reason) };

  try {
    const result = await deps.ai.generate({
      model: prepared.model,
      messages: buildResearchMessages({
        product: prepared.product,
        merchantContext: prepared.merchantContext,
        maxSearches: deps.config.researchMaxSearches,
        images: prepared.images,
      }),
      jsonSchema: RESEARCH_JSON_SCHEMA,
      maxOutputTokens: RESEARCH_MAX_OUTPUT_TOKENS,
      webSearch: { maxUses: deps.config.researchMaxSearches, maxResults: deps.config.researchMaxResults },
    });
    const checked = validateResearchOutput(result.content, result.citations, result.searchCount);
    logger.info("ai.research_done", {
      ...log,
      status: checked.record.status,
      facts: checked.record.facts.length,
      rejected: checked.record.rejected.length,
      citations: result.citations.length,
      searches: result.searchCount,
      latencyMs: result.latencyMs,
    });
    return {
      research: checked.record,
      usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens, cost: result.cost, latencyMs: result.latencyMs },
    };
  } catch (err) {
    const kind = err instanceof AiProviderError ? err.kind : "INTERNAL";
    logger.warn("ai.research_failed", { ...log, kind, message: err instanceof Error ? err.message : String(err) });
    return { ...nothing, research: failedResearch(kind) };
  }
}

/**
 * The background part. Never throws: every outcome ends as a job state.
 * Two provider calls: research (web search, optional, never fatal) then the description, which
 * receives only the research facts whose sources were confirmed.
 * An invalid or refused description FAILS the job and is not retried; the merchant regenerates,
 * which creates a new, linked job. Temporary provider failures were already retried by the client.
 */
export async function runGeneration(
  deps: RunDeps,
  shopId: number,
  jobId: number,
  prepared: Prepared,
  options: { leased?: boolean } = {}, // leased = the worker already moved the row to RUNNING
) {
  const log = { shopId, jobId, model: prepared.model };
  try {
    if (!options.leased && !(await markJobRunning(shopId, jobId))) return;

    const { research, usage: researchUsage } = await researchProduct(deps, prepared, log);

    const result = await deps.ai.generate({
      model: prepared.model,
      messages: buildDescriptionMessages({ ...prepared, researchFacts: research.facts }),
      jsonSchema: DESCRIPTION_JSON_SCHEMA,
      maxOutputTokens: deps.config.maxOutputTokens,
    });

    const checked = validateModelOutput(result.content);
    if (!checked.ok) {
      // Keep a short sample so the failure is diagnosable; the full answer is not stored for failed jobs.
      const sample = result.content.replace(/\s+/g, " ").slice(0, RAW_ERROR_SAMPLE);
      await failJob(shopId, jobId, `INVALID_OUTPUT: ${checked.reason}. Model said: ${sample}`);
      logger.warn("ai.job_failed", { ...log, kind: "INVALID_OUTPUT", reason: checked.reason });
      return;
    }

    const generatedText = [
      htmlToText(checked.value.descriptionHtml),
      checked.value.shortDescription,
      checked.value.seoTitle,
      checked.value.seoDescription,
      ...checked.value.highlights,
    ].join("\n");
    // Research that did not end in USED is a warning the merchant must read before approving;
    // a skipped research is only informative and stays in the Sources view.
    const researchWarnings = research.status === "UNCERTAIN" || research.status === "FAILED" ? [research.reason] : [];
    const warnings = mergeWarnings(
      [...checked.value.warnings, ...researchWarnings],
      detectUnsupportedClaims(generatedText, trustedText(prepared.product, prepared.merchantContext, research.facts)),
    );

    // Both calls are one generation to the merchant: usage, cost and time are summed.
    const saved = await completeJob(shopId, jobId, {
      rawJson: checked.raw as object,
      validatedJson: { ...checked.value, research },
      warnings,
      promptTokens: addNullable(result.promptTokens, researchUsage?.promptTokens ?? null),
      completionTokens: addNullable(result.completionTokens, researchUsage?.completionTokens ?? null),
      cost: addNullable(result.cost, researchUsage?.cost ?? null),
      generationId: result.generationId,
      latencyMs: result.latencyMs + (researchUsage?.latencyMs ?? 0),
      draftHtml: checked.value.descriptionHtml,
    });
    logger.info(saved ? "ai.job_succeeded" : "ai.job_result_discarded", {
      ...log,
      latencyMs: result.latencyMs,
      generationId: result.generationId,
      warnings: warnings.length,
      research: research.status,
    });
  } catch (err) {
    const kind = err instanceof AiProviderError ? err.kind : "INTERNAL";
    const message = err instanceof AiProviderError ? err.message : "Unexpected error while generating";
    await failJob(shopId, jobId, `${kind}: ${message}`).catch(() => undefined);
    logger.error("ai.job_failed", { ...log, kind, message: err instanceof Error ? err.message : String(err) });
  }
}
