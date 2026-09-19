import { describe, expect, it } from "vitest";
import {
  canReclaim,
  RECEIPT_IN_FLIGHT_MS,
} from "../app/repositories/webhook-receipt.server";
import {
  isStaleEvent,
  productGidFromPayload,
} from "../app/services/webhook.server";

const now = new Date("2026-09-19T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("canReclaim (which repeat deliveries may run again)", () => {
  it("never re-runs a PROCESSED delivery", () => {
    expect(canReclaim({ status: "PROCESSED", receivedAt: ago(10 * 60_000) }, now)).toBe(false);
  });
  it("re-runs a FAILED delivery so Shopify's retry can succeed", () => {
    expect(canReclaim({ status: "FAILED", receivedAt: ago(1000) }, now)).toBe(true);
  });
  it("leaves a fresh RECEIVED alone (first request still running)", () => {
    expect(canReclaim({ status: "RECEIVED", receivedAt: ago(RECEIPT_IN_FLIGHT_MS - 1) }, now)).toBe(false);
  });
  it("takes over an abandoned RECEIVED", () => {
    expect(canReclaim({ status: "RECEIVED", receivedAt: ago(RECEIPT_IN_FLIGHT_MS) }, now)).toBe(true);
  });
});

describe("productGidFromPayload", () => {
  it("prefers a valid admin_graphql_api_id", () => {
    expect(productGidFromPayload({ id: 1, admin_graphql_api_id: "gid://shopify/Product/42" })).toBe(
      "gid://shopify/Product/42",
    );
  });
  it("builds the GID from the numeric id (delete payload)", () => {
    expect(productGidFromPayload({ id: 788032119674292900 % 1e15 })).toMatch(/^gid:\/\/shopify\/Product\/\d+$/);
    expect(productGidFromPayload({ id: "123" })).toBe("gid://shopify/Product/123");
  });
  it.each([{}, { id: -1 }, { id: "12; DROP" }, { id: 1.5 }, { admin_graphql_api_id: "gid://shopify/Order/1" }])(
    "rejects %j",
    (payload) => expect(() => productGidFromPayload(payload)).toThrow(),
  );
});

describe("isStaleEvent", () => {
  const stored = new Date("2026-09-19T10:00:00Z");
  it("is stale only when strictly older than the stored copy", () => {
    expect(isStaleEvent("2026-09-19T09:59:59Z", stored)).toBe(true);
    expect(isStaleEvent("2026-09-19T10:00:00Z", stored)).toBe(false);
    expect(isStaleEvent("2026-09-19T10:00:01Z", stored)).toBe(false);
  });
  it("is not stale when we have no local copy or no usable timestamp", () => {
    expect(isStaleEvent("2026-09-19T09:00:00Z", null)).toBe(false);
    expect(isStaleEvent("garbage", stored)).toBe(false);
    expect(isStaleEvent(undefined, stored)).toBe(false);
  });
});
