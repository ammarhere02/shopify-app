/**
 * Purpose: Reads and validates the OpenRouter settings and limits for the AI feature.
 * Called by: createGenerationDeps, the worker, and pages that need the allowed model names.
 * Input: Environment variables (key, model allowlist, timeouts, limits, research switches).
 * Output: A typed AiConfig, or AiConfigError naming the missing or invalid variable.
 * Uses: process.env only.
 * Does not: Make network calls or expose the key value anywhere, including error messages.
 */

/**
 * Server-side OpenRouter configuration, read from the environment.
 * Parsed lazily (not at import) so the app still boots without a key; only the
 * generation feature reports "not configured".
 */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

export type AiConfig = {
  apiKey: string;
  baseUrl: string;
  /** Vision models that support structured outputs. The first one is the default. */
  models: string[];
  defaultModel: string;
  /** "deny" = only providers that do not retain or train on prompts. Free endpoints usually need "allow". */
  dataCollection: "deny" | "allow";
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
  maxImages: number;
  dailyLimitPerShop: number;
  maxConcurrentPerShop: number;
  /** Product research (web search before the description). Off = one call per generation, as before. */
  research: boolean;
  /** Searches one research call may run; each is billed on top of the tokens. */
  researchMaxSearches: number;
  /** Results per search. */
  researchMaxResults: number;
};

type Env = Record<string, string | undefined>;

function intInRange(env: Env, name: string, fallback: number, min: number, max: number) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AiConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadAiConfig(env: Env = process.env): AiConfig {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new AiConfigError("OPENROUTER_API_KEY is not set");

  const models = (env.OPENROUTER_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) throw new AiConfigError("OPENROUTER_MODELS must list at least one model");

  const dataCollection = env.OPENROUTER_DATA_COLLECTION?.trim().toLowerCase() || "deny";
  if (dataCollection !== "deny" && dataCollection !== "allow") {
    throw new AiConfigError('OPENROUTER_DATA_COLLECTION must be "deny" or "allow"');
  }
  const research = env.AI_RESEARCH?.trim().toLowerCase() || "on";
  if (research !== "on" && research !== "off") throw new AiConfigError('AI_RESEARCH must be "on" or "off"');

  return {
    apiKey,
    baseUrl: env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
    models,
    defaultModel: models[0],
    dataCollection,
    timeoutMs: intInRange(env, "OPENROUTER_TIMEOUT_MS", 60_000, 1_000, 300_000),
    maxRetries: intInRange(env, "OPENROUTER_MAX_RETRIES", 2, 0, 5),
    maxOutputTokens: intInRange(env, "AI_MAX_OUTPUT_TOKENS", 4_000, 100, 8_000),
    maxImages: intInRange(env, "AI_MAX_IMAGES", 4, 1, 4),
    dailyLimitPerShop: intInRange(env, "AI_DAILY_LIMIT_PER_SHOP", 50, 1, 10_000),
    maxConcurrentPerShop: intInRange(env, "AI_MAX_CONCURRENT_PER_SHOP", 1, 1, 10),
    research: research === "on",
    researchMaxSearches: intInRange(env, "AI_RESEARCH_MAX_SEARCHES", 3, 1, 5),
    researchMaxResults: intInRange(env, "AI_RESEARCH_MAX_RESULTS", 5, 1, 10),
  };
}

/** Allowlist check. Undefined means "use the default". Anything else must be listed. */
export function resolveModel(config: AiConfig, requested?: string | null) {
  if (!requested) return config.defaultModel;
  if (!config.models.includes(requested)) {
    throw new AiConfigError("Model is not in the allowlist");
  }
  return requested;
}
