import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../app/lib/rate-limit.server";
import { generateApiKey, hashApiKey } from "../app/services/api-key.server";
import { ApiError, decodeCursor, encodeCursor, productGidFromParam } from "../app/services/api.server";

describe("API keys", () => {
  it("generates a prefixed high-entropy key and stores only its SHA-256", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).toMatch(/^eh_live_[A-Za-z0-9_-]{43}$/);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.keyHash).toBe(hashApiKey(a.plaintext));
    expect(a.keyPrefix).toBe(a.plaintext.slice(0, 12));
    expect(a.keyHash).not.toContain(a.plaintext.slice(8));
  });
});

describe("rate limiter", () => {
  it("allows `limit` hits per window, reports Retry-After, then resets", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    expect(limiter.hit("k").allowed).toBe(true);
    expect(limiter.hit("k").allowed).toBe(true);
    t = 15_000;
    expect(limiter.hit("k")).toEqual({ allowed: false, retryAfterSec: 45 });
    expect(limiter.hit("other").allowed).toBe(true); // keys are independent
    t = 60_000;
    expect(limiter.hit("k").allowed).toBe(true);
  });

  it("blocked() checks without counting, and memory stays bounded", () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t, maxEntries: 3 });
    expect(limiter.blocked("ip").blocked).toBe(false);
    limiter.hit("ip");
    expect(limiter.blocked("ip").blocked).toBe(true);
    t = 2000; // everything above expired
    for (const k of ["a", "b", "c", "d", "e"]) limiter.hit(k);
    expect(limiter.blocked("ip").blocked).toBe(false);
  });
});

describe("URL and cursor parsing", () => {
  it("rebuilds the GID from a numeric id only", () => {
    expect(productGidFromParam("123")).toBe("gid://shopify/Product/123");
    for (const bad of [undefined, "", "0", "-1", "1.5", "abc", "gid://shopify/Product/1", "1 OR 1=1"]) {
      expect(() => productGidFromParam(bad)).toThrow(ApiError);
    }
  });

  it("round-trips a cursor and rejects anything else with a 400", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    for (const bad of ["", "42", "not-base64!", Buffer.from('{"id":-1}').toString("base64url"), Buffer.from('{"id":"1"}').toString("base64url")]) {
      try {
        decodeCursor(bad);
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(400);
      }
    }
  });
});
