/**
 * Purpose: The only code that talks to OpenRouter (chat completion with images, a JSON schema and,
 *          for product research, OpenRouter's web search server tool).
 * Called by: runGeneration, through the OpenRouterClient interface.
 * Input: Model, messages (text first, then image URLs), JSON schema, token limit, optional web-search limits.
 * Output: The raw answer text plus usage, cost, latency, generation id, search count and the URLs the
 *         search tool actually returned (citations); or AiProviderError.
 * Uses: fetch to the OpenRouter API, with timeout and bounded retries.
 * Does not: Validate or sanitize the answer, or log the prompt, images, answer or key.
 */
import { logger } from "../lib/logger.server";
import type { AiConfig } from "./config.server";

/**
 * The contract between the generation service and the model provider.
 * Services depend on this interface, not on fetch, so tests pass a fake and
 * no test ever makes a billable call. `createOpenRouterClient` below is the HTTP implementation.
 */

/** Why a provider call failed. Mirrors ShopifyApiError: each kind is handled differently. */
export type AiErrorKind =
  | "TRANSPORT" // network error or HTTP 5xx
  | "TIMEOUT" // our deadline passed
  | "RATE_LIMITED" // HTTP 429
  | "AUTH" // 401/403: bad key or no credit
  | "REFUSED" // the model declined to answer
  | "INVALID_OUTPUT" // not JSON, or JSON that fails the schema
  | "UNSUPPORTED"; // model cannot do images or structured output

export class AiProviderError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
    public retryable: boolean,
    /** From a Retry-After header, when the provider sent one. */
    public retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: ChatContentPart[] };

/**
 * Bounds for OpenRouter's `openrouter:web_search` server tool. The model decides when to search;
 * these caps bound what one request can spend (each search is billed on top of the tokens).
 */
export type WebSearchOptions = {
  /** Searches the model may run in this request (`max_uses` and `max_tool_calls`). */
  maxUses: number;
  /** Results per search (`max_results`). */
  maxResults: number;
};

export type GenerationRequest = {
  model: string;
  messages: ChatMessage[];
  /** JSON Schema the provider must enforce (strict). The server validates again. */
  jsonSchema: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  /** When set, the request carries the web search server tool with these limits. */
  webSearch?: WebSearchOptions;
  signal?: AbortSignal;
};

/** A page the search tool returned to the model, as OpenRouter reports it in `annotations`. */
export type Citation = { url: string; title: string | null };

export type GenerationResult = {
  /** Message content exactly as returned. Untrusted until validated. */
  content: string;
  generationId: string | null;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  /** USD, when the provider reports it. */
  cost: number | null;
  latencyMs: number;
  /**
   * URLs the search tool really fetched for this answer (`url_citation` annotations), deduplicated.
   * Empty without web search. The research validator only trusts a source that appears here.
   */
  citations: Citation[];
  /** Searches the model ran (`usage.server_tool_use.web_search_requests`), null when not reported. */
  searchCount: number | null;
};

export interface OpenRouterClient {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------


type ClientDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseDelayMs?: number;
  logContext?: Record<string, unknown>;
};

/** A provider asking us to wait longer than this is treated as a failure, not slept through. */
const MAX_RETRY_WAIT_MS = 15_000;
const ERROR_TEXT_MAX = 300;
const CITATIONS_MAX = 40;
const CITATION_TITLE_MAX = 200;

type Annotation = {
  type?: string;
  url_citation?: { url?: unknown; title?: unknown };
};

type CompletionBody = {
  id?: string;
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    error?: { code?: number | string; message?: string };
    message?: { content?: string | null; refusal?: string | null; annotations?: Annotation[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    server_tool_use?: { web_search_requests?: number };
  };
};

/** HTTP status → error kind. 408/429/5xx are temporary; everything else will fail the same way again. */
export function classifyStatus(status: number, detail: string): AiProviderError {
  const message = `OpenRouter returned ${status}${detail ? `: ${detail.slice(0, ERROR_TEXT_MAX)}` : ""}`;
  if (status === 429) return new AiProviderError("RATE_LIMITED", message, true);
  if (status === 408) return new AiProviderError("TIMEOUT", message, true);
  if (status >= 500) return new AiProviderError("TRANSPORT", message, true);
  if (status === 401 || status === 402 || status === 403) return new AiProviderError("AUTH", message, false);
  // 400/404/422: bad request, unknown model, or no endpoint supports images + structured output
  // under the configured data policy.
  return new AiProviderError("UNSUPPORTED", message, false);
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

const numberOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `url_citation` annotations → unique http(s) URLs. Anything malformed is dropped, never thrown. */
export function extractCitations(annotations: unknown): Citation[] {
  if (!Array.isArray(annotations)) return [];
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const item of annotations as Annotation[]) {
    const url = item?.url_citation?.url;
    if (item?.type !== "url_citation" || typeof url !== "string") continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    const title = item.url_citation?.title;
    citations.push({ url: parsed.href, title: typeof title === "string" && title.trim() ? title.trim().slice(0, CITATION_TITLE_MAX) : null });
    if (citations.length >= CITATIONS_MAX) break;
  }
  return citations;
}

/**
 * OpenRouter chat completions with a per-attempt timeout and a bounded retry for temporary
 * failures only. Invalid or refused answers are NOT retried: the same prompt would most likely
 * fail the same way, and every call spends the merchant's quota.
 * Never logs the key, the Authorization header, the prompt or the answer.
 */
export function createOpenRouterClient(config: AiConfig, deps: ClientDeps = {}): OpenRouterClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const baseDelayMs = deps.baseDelayMs ?? 1000;
  const context = deps.logContext ?? {};
  const maxAttempts = config.maxRetries + 1;

  async function attemptOnce(request: GenerationRequest): Promise<GenerationResult> {
    const started = now();
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await doFetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Merchant Product Enrichment Hub",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          temperature: 0.4,
          response_format: {
            type: "json_schema",
            json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema },
          },
          // OpenRouter runs the searches server-side and returns one final answer with citations.
          // Both caps bound the spend: max_uses per tool, max_tool_calls for the whole request.
          ...(request.webSearch
            ? {
                tools: [
                  {
                    type: "openrouter:web_search",
                    parameters: {
                      max_uses: request.webSearch.maxUses,
                      max_results: request.webSearch.maxResults,
                      max_total_results: request.webSearch.maxUses * request.webSearch.maxResults,
                    },
                  },
                ],
                max_tool_calls: request.webSearch.maxUses,
              }
            : {}),
          // Route only to endpoints that honour every parameter above (images + json_schema [+ tools]).
          provider: { require_parameters: true, data_collection: config.dataCollection },
          usage: { include: true },
        }),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (request.signal?.aborted) throw new AiProviderError("TIMEOUT", "Generation was cancelled", false);
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AiProviderError("TIMEOUT", `No answer within ${config.timeoutMs} ms`, true);
      }
      throw new AiProviderError("TRANSPORT", "Could not reach OpenRouter", true);
    }

    if (!res.ok) {
      const detail = await res
        .json()
        .then((b: CompletionBody) => b?.error?.message ?? "")
        .catch(() => "");
      const error = classifyStatus(res.status, detail);
      error.retryAfterMs = retryAfterMs(res);
      throw error;
    }

    let body: CompletionBody;
    try {
      body = (await res.json()) as CompletionBody;
    } catch {
      throw new AiProviderError("TRANSPORT", "OpenRouter returned a body that is not JSON", true);
    }

    // OpenRouter can answer 200 and still report an upstream provider failure in the body.
    const bodyError = body.error ?? body.choices?.[0]?.error;
    if (bodyError) {
      const code = Number(bodyError.code);
      throw classifyStatus(Number.isInteger(code) && code >= 400 ? code : 502, bodyError.message ?? "");
    }

    const choice = body.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
      throw new AiProviderError("REFUSED", "The model declined to describe this product", false);
    }
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AiProviderError("INVALID_OUTPUT", "The model returned an empty answer", false);
    }
    if (choice?.finish_reason === "length") {
      throw new AiProviderError("INVALID_OUTPUT", "The answer was cut off at the output token limit", false);
    }

    return {
      content,
      generationId: typeof body.id === "string" ? body.id : null,
      model: typeof body.model === "string" ? body.model : request.model,
      // Usage can be missing (some free endpoints omit it); the job still succeeds.
      promptTokens: numberOrNull(body.usage?.prompt_tokens),
      completionTokens: numberOrNull(body.usage?.completion_tokens),
      cost: numberOrNull(body.usage?.cost),
      latencyMs: now() - started,
      citations: extractCitations(choice?.message?.annotations),
      searchCount: numberOrNull(body.usage?.server_tool_use?.web_search_requests),
    };
  }

  return {
    async generate(request) {
      for (let attempt = 1; ; attempt++) {
        const started = now();
        try {
          const result = await attemptOnce(request);
          logger.info("ai.generate", {
            ...context,
            model: result.model,
            attempt,
            latencyMs: result.latencyMs,
            generationId: result.generationId,
            // Named without the word "token": the logger redacts any key that contains it.
            usagePrompt: result.promptTokens,
            usageCompletion: result.completionTokens,
            cost: result.cost,
            webSearch: !!request.webSearch,
            searches: result.searchCount,
            citations: result.citations.length,
          });
          return result;
        } catch (raw) {
          const err =
            raw instanceof AiProviderError
              ? raw
              : new AiProviderError("TRANSPORT", "Unexpected provider failure", false);
          logger.warn("ai.generate_failed", {
            ...context,
            model: request.model,
            attempt,
            kind: err.kind,
            retryable: err.retryable,
            latencyMs: now() - started,
            message: err.message,
          });
          if (!err.retryable || attempt >= maxAttempts) throw err;
          const wait = err.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1);
          if (wait > MAX_RETRY_WAIT_MS) throw err;
          await sleep(wait);
        }
      }
    },
  };
}
