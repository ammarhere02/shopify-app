import { describe, expect, it } from "vitest";
import {
  APPLY_ABANDON_MS,
  JOB_ABANDON_MS,
  canApply,
  canEditDraft,
  canHaveReview,
  canMoveJob,
  canMoveReview,
  isAbandoned,
  isApplyAbandoned,
} from "../app/services/generation-state";
import { ShopifyUserErrors, requireNoUserErrors } from "../app/shopify/mutations";
import { hashGenerationInput, stableStringify } from "../app/services/input-hash.server";
import { AiConfigError, loadAiConfig, resolveModel } from "../app/ai/config.server";

describe("job status transitions", () => {
  it("allows only the drawn path", () => {
    expect(canMoveJob("QUEUED", "RUNNING")).toBe(true);
    expect(canMoveJob("QUEUED", "FAILED")).toBe(true);
    expect(canMoveJob("RUNNING", "SUCCEEDED")).toBe(true);
    expect(canMoveJob("RUNNING", "FAILED")).toBe(true);
  });

  it("refuses skipping, going back, and leaving a final state", () => {
    expect(canMoveJob("QUEUED", "SUCCEEDED")).toBe(false);
    expect(canMoveJob("RUNNING", "QUEUED")).toBe(false);
    expect(canMoveJob("SUCCEEDED", "RUNNING")).toBe(false);
    expect(canMoveJob("FAILED", "RUNNING")).toBe(false);
    expect(canMoveJob("FAILED", "SUCCEEDED")).toBe(false);
  });
});

describe("review status transitions", () => {
  it("needs approval before apply, and passes through APPLYING", () => {
    expect(canMoveReview("DRAFT", "APPROVED")).toBe(true);
    expect(canMoveReview("APPROVED", "APPLYING")).toBe(true);
    expect(canMoveReview("APPLYING", "APPLIED")).toBe(true);
    expect(canMoveReview("APPROVED", "APPLIED")).toBe(false); // never without the in-flight state
    expect(canMoveReview("DRAFT", "APPLIED")).toBe(false);
    expect(canMoveReview("DRAFT", "APPLYING")).toBe(false);
  });

  it("returns to DRAFT only from APPROVED (edit again), to APPROVED only from APPLYING (refused write)", () => {
    expect(canMoveReview("APPROVED", "DRAFT")).toBe(true);
    expect(canMoveReview("APPLYING", "APPROVED")).toBe(true);
    expect(canMoveReview("APPLYING", "DRAFT")).toBe(false);
    expect(canMoveReview("REJECTED", "DRAFT")).toBe(false);
    expect(canMoveReview("APPLIED", "DRAFT")).toBe(false);
  });

  it("treats REJECTED and APPLIED as final", () => {
    for (const to of ["DRAFT", "APPROVED", "REJECTED", "APPLYING", "APPLIED"] as const) {
      expect(canMoveReview("REJECTED", to)).toBe(false);
      expect(canMoveReview("APPLIED", to)).toBe(false);
    }
  });

  it("canApply: only a finished job whose draft is approved", () => {
    expect(canApply("SUCCEEDED", "APPROVED")).toBe(true);
    expect(canApply("SUCCEEDED", "DRAFT")).toBe(false);
    expect(canApply("SUCCEEDED", "APPLIED")).toBe(false);
    expect(canApply("RUNNING", "APPROVED")).toBe(false);
    expect(canApply("FAILED", null)).toBe(false);
  });

  it("isApplyAbandoned: only APPLYING, only after the window", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    const old = new Date(now.getTime() - APPLY_ABANDON_MS - 1);
    expect(isApplyAbandoned({ reviewStatus: "APPLYING", reviewedAt: old }, now)).toBe(true);
    expect(isApplyAbandoned({ reviewStatus: "APPLYING", reviewedAt: now }, now)).toBe(false);
    expect(isApplyAbandoned({ reviewStatus: "APPROVED", reviewedAt: old }, now)).toBe(false);
    expect(isApplyAbandoned({ reviewStatus: "APPLYING", reviewedAt: null }, now)).toBe(false);
  });

  it("gives a review only to a SUCCEEDED job, edits only to a DRAFT", () => {
    expect(canHaveReview("SUCCEEDED")).toBe(true);
    expect(canHaveReview("FAILED")).toBe(false);
    expect(canHaveReview("RUNNING")).toBe(false);
    expect(canEditDraft("SUCCEEDED", "DRAFT")).toBe(true);
    expect(canEditDraft("SUCCEEDED", "APPROVED")).toBe(false);
    expect(canEditDraft("FAILED", null)).toBe(false);
  });
});

describe("isAbandoned", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const old = new Date(now.getTime() - JOB_ABANDON_MS);
  const recent = new Date(now.getTime() - JOB_ABANDON_MS + 1);

  it("uses startedAt for RUNNING and createdAt for QUEUED", () => {
    expect(isAbandoned({ status: "RUNNING", createdAt: old, startedAt: recent }, now)).toBe(false);
    expect(isAbandoned({ status: "RUNNING", createdAt: old, startedAt: old }, now)).toBe(true);
    expect(isAbandoned({ status: "QUEUED", createdAt: old, startedAt: null }, now)).toBe(true);
    expect(isAbandoned({ status: "QUEUED", createdAt: recent, startedAt: null }, now)).toBe(false);
  });

  it("never abandons a finished job", () => {
    expect(isAbandoned({ status: "SUCCEEDED", createdAt: old, startedAt: old }, now)).toBe(false);
    expect(isAbandoned({ status: "FAILED", createdAt: old, startedAt: old }, now)).toBe(false);
  });
});

describe("input hash", () => {
  const base = {
    productSnapshot: { title: "Board", vendor: "Acme", nested: { b: 2, a: 1 } },
    merchantContext: "For beginners",
    selectedMediaIds: ["gid://shopify/MediaImage/2", "gid://shopify/MediaImage/1"],
    model: "vendor/model",
    promptVersion: "v1",
  };

  it("is 64 hex characters and stable across key and media order", () => {
    const hash = hashGenerationInput(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      hashGenerationInput({
        promptVersion: "v1",
        model: "vendor/model",
        selectedMediaIds: [...base.selectedMediaIds].reverse(),
        merchantContext: "  For beginners  ",
        productSnapshot: { nested: { a: 1, b: 2 }, vendor: "Acme", title: "Board" },
      }),
    ).toBe(hash);
  });

  it("changes when any part of the input changes", () => {
    const hash = hashGenerationInput(base);
    expect(hashGenerationInput({ ...base, merchantContext: "For experts" })).not.toBe(hash);
    expect(hashGenerationInput({ ...base, model: "vendor/other" })).not.toBe(hash);
    expect(hashGenerationInput({ ...base, promptVersion: "v2" })).not.toBe(hash);
    expect(hashGenerationInput({ ...base, selectedMediaIds: [base.selectedMediaIds[0]] })).not.toBe(hash);
    expect(
      hashGenerationInput({ ...base, productSnapshot: { ...base.productSnapshot, title: "Board 2" } }),
    ).not.toBe(hash);
  });

  it("treats empty context as none, keeps array order, drops undefined", () => {
    expect(hashGenerationInput({ ...base, merchantContext: "   " })).toBe(
      hashGenerationInput({ ...base, merchantContext: null }),
    );
    expect(stableStringify([2, 1])).toBe("[2,1]");
    expect(stableStringify({ b: undefined, a: null })).toBe('{"a":null}');
  });
});

describe("AI configuration", () => {
  const env = { OPENROUTER_API_KEY: "sk-test", OPENROUTER_MODELS: " vendor/a , vendor/b ," };

  it("applies defaults and takes the first model as default", () => {
    const config = loadAiConfig(env);
    expect(config.models).toEqual(["vendor/a", "vendor/b"]);
    expect(config.defaultModel).toBe("vendor/a");
    expect(config).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 60_000,
      maxRetries: 2,
      maxOutputTokens: 1_500,
      maxImages: 4,
      dailyLimitPerShop: 50,
      maxConcurrentPerShop: 1,
      research: true,
      researchMaxSearches: 3,
      researchMaxResults: 5,
    });
    expect(loadAiConfig({ ...env, AI_RESEARCH: "off", AI_RESEARCH_MAX_SEARCHES: "1" })).toMatchObject({ research: false, researchMaxSearches: 1 });
    expect(() => loadAiConfig({ ...env, AI_RESEARCH: "maybe" })).toThrow(/AI_RESEARCH/);
    expect(() => loadAiConfig({ ...env, AI_RESEARCH_MAX_SEARCHES: "6" })).toThrow(/AI_RESEARCH_MAX_SEARCHES/);
  });

  it("fails clearly without a key or a model, and never echoes the key", () => {
    expect(() => loadAiConfig({ OPENROUTER_MODELS: "vendor/a" })).toThrow(AiConfigError);
    expect(() => loadAiConfig({ OPENROUTER_API_KEY: "sk-test", OPENROUTER_MODELS: " , " })).toThrow(
      /OPENROUTER_MODELS/,
    );
    try {
      loadAiConfig({ ...env, OPENROUTER_TIMEOUT_MS: "abc" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/OPENROUTER_TIMEOUT_MS/);
      expect((err as Error).message).not.toContain("sk-test");
    }
  });

  it("rejects numbers outside their range", () => {
    expect(() => loadAiConfig({ ...env, AI_MAX_IMAGES: "5" })).toThrow(/AI_MAX_IMAGES/);
    expect(() => loadAiConfig({ ...env, OPENROUTER_MAX_RETRIES: "-1" })).toThrow(AiConfigError);
    expect(() => loadAiConfig({ ...env, AI_DAILY_LIMIT_PER_SHOP: "1.5" })).toThrow(AiConfigError);
  });

  it("resolves only allowlisted models", () => {
    const config = loadAiConfig(env);
    expect(resolveModel(config)).toBe("vendor/a");
    expect(resolveModel(config, "vendor/b")).toBe("vendor/b");
    expect(() => resolveModel(config, "vendor/expensive")).toThrow(AiConfigError);
  });
});

describe("mutation payloads", () => {
  it("returns the payload when userErrors is empty", () => {
    const payload = { product: { id: "gid://shopify/Product/1" }, userErrors: [] };
    expect(requireNoUserErrors("productUpdate", payload)).toBe(payload);
  });

  it("throws ShopifyUserErrors with every message, and for a missing payload", () => {
    const errors = [{ field: ["descriptionHtml"], message: "is too long" }, { field: null, message: "Access denied" }];
    let caught: unknown;
    try {
      requireNoUserErrors("productUpdate", { userErrors: errors });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShopifyUserErrors);
    expect((caught as ShopifyUserErrors).userErrors).toEqual(errors);
    expect((caught as Error).message).toBe("productUpdate: is too long; Access denied");
    expect(() => requireNoUserErrors("productUpdate", null)).toThrow(ShopifyUserErrors);
  });
});
