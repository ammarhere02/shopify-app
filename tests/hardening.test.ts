import { describe, expect, it, vi } from "vitest";
// generation-api.server imports shopify.server, which reads env at import time.
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn() }, authenticate: { admin: vi.fn() } }));
import { MAX_STRING, redactForTests } from "../app/lib/logger.server";
import { ApiError } from "../app/services/api.server";
import { shopifyErrorMessage, toApiError } from "../app/services/generation-api.server";
import { ShopifyApiError } from "../app/shopify/graphql-client.server";

describe("logger redaction", () => {
  it("redacts by key name at every depth", () => {
    const out = redactForTests({ token: "abc", nested: { apiKey: "x", Authorization: "y", ok: 1 }, list: [{ cookie: "c" }] });
    expect(out).toEqual({ token: "[REDACTED]", nested: { apiKey: "[REDACTED]", Authorization: "[REDACTED]", ok: 1 }, list: [{ cookie: "[REDACTED]" }] });
  });

  it("redacts credential-shaped values under innocent keys", () => {
    const out = redactForTests({
      message: "fetch failed for Bearer sk-or-v1-abcdefghijklmnop0123 at https://x",
      reason: "key eh_live_AbCdEf123456789_-xyz rejected, also shpat_0123456789abcdef",
      header: "Bearer eyJhbGciOi.payload.sig",
    });
    expect(out.message).toBe("fetch failed for [REDACTED] at https://x");
    expect(out.reason).toBe("key [REDACTED] rejected, also [REDACTED]");
    expect(out.header).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toMatch(/sk-or|eh_live|shpat_|eyJ/);
  });

  it("strips inline base64 images and cuts long strings", () => {
    const image = `data:image/png;base64,${"A".repeat(2000)}`;
    const out = redactForTests({ prompt: `look at ${image} please`, html: "<p>x</p>".repeat(1000) });
    expect(out.prompt).toBe("look at [REDACTED] please");
    expect(String(out.html).length).toBeLessThan(MAX_STRING + 30);
    expect(String(out.html)).toMatch(/…\[\+\d+\]$/);
  });

  it("leaves ordinary values alone", () => {
    const now = new Date("2026-09-22T10:00:00Z");
    expect(redactForTests({ shopId: 3, ok: true, when: now, none: null, model: "vendor/vision:free", gid: "gid://shopify/Product/1" })).toEqual({
      shopId: 3, ok: true, when: now.toISOString(), none: null, model: "vendor/vision:free", gid: "gid://shopify/Product/1",
    });
  });

  it("does not recurse without bound", () => {
    const deep = { a: { b: { c: { d: { e: { f: "x" } } } } } };
    expect(JSON.stringify(redactForTests(deep))).toContain("[object]");
  });
});

describe("Shopify failures in the API envelope", () => {
  const cases: Array<[ShopifyApiError["kind"], number, string]> = [
    ["THROTTLED", 429, "shopify_throttled"],
    ["TRANSPORT", 502, "shopify_unavailable"],
    ["GRAPHQL", 502, "shopify_error"],
    ["AUTH", 409, "shop_session_unavailable"],
  ];
  it.each(cases)("%s → %d %s, without Shopify's message text", (kind, status, code) => {
    const err = toApiError(new ShopifyApiError(kind, "secret internals: Bearer sk-or-abcdefghijkl", false)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/internals|sk-or/);
    if (kind === "THROTTLED") expect(err.headers["Retry-After"]).toBe("5");
  });

  it("gives the admin page the same wording", () => {
    expect(shopifyErrorMessage(new ShopifyApiError("TRANSPORT", "x", true))).toMatch(/Retry shortly/);
  });

  it("passes unknown errors through unchanged", () => {
    const err = new Error("boom");
    expect(toApiError(err)).toBe(err);
  });
});
