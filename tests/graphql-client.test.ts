import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyError,
  createShopifyClient,
  msUntilAvailable,
} from "../app/shopify/graphql-client.server";

vi.mock("../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
afterEach(() => vi.useRealTimers());
const response = (body: unknown) => new Response(JSON.stringify(body));

describe("Shopify GraphQL client", () => {
  it("retries transient HTTP failures with bounded exponential backoff", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(response({ data: { shop: { name: "Demo" } } }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await createShopifyClient(graphql, { sleep }).query(
      "Shop",
      "query {}",
    );
    expect(result).toEqual({ shop: { name: "Demo" } });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    expect(graphql.mock.calls[0][1].tries).toBe(1);
    expect(graphql.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("stops after three retryable failures", async () => {
    const graphql = vi
      .fn()
      .mockRejectedValue({ name: "HttpRequestError", message: "Network down" });
    await expect(
      createShopifyClient(graphql, { sleep: async () => {} }).query(
        "Shop",
        "query {}",
      ),
    ).rejects.toMatchObject({ kind: "TRANSPORT" });
    expect(graphql).toHaveBeenCalledTimes(3);
  });
  it("rejects top-level GraphQL errors even when partial data exists", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        response({
          data: { products: [] },
          errors: [{ message: "Access denied" }],
        }),
      );
    await expect(
      createShopifyClient(graphql).query("Products", "query {}"),
    ).rejects.toMatchObject({ kind: "GRAPHQL", retryable: false });
    expect(graphql).toHaveBeenCalledTimes(1);
  });
  it("retries GraphQL throttling", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        }),
      )
      .mockResolvedValueOnce(response({ data: { ok: true } }));
    await expect(
      createShopifyClient(graphql, { sleep: async () => {} }).query(
        "Shop",
        "query {}",
      ),
    ).resolves.toEqual({ ok: true });
  });
  it("classifies SDK GraphQL errors", () => {
    expect(
      classifyError({
        body: { errors: { graphQLErrors: [{ message: "Bad field" }] } },
      }).kind,
    ).toBe("GRAPHQL");
  });
  it("does not retry authentication failures", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      createShopifyClient(graphql).query("Shop", "query {}"),
    ).rejects.toMatchObject({ kind: "AUTH" });
    expect(graphql).toHaveBeenCalledTimes(1);
  });
  it("preserves framework redirects for reauthentication", async () => {
    const redirect = new Response(null, { status: 302 });
    const graphql = vi.fn().mockRejectedValue(redirect);
    await expect(
      createShopifyClient(graphql).query("Shop", "query {}"),
    ).rejects.toBe(redirect);
    expect(graphql).toHaveBeenCalledTimes(1);
  });
  it("rejects responses without data", async () => {
    await expect(
      createShopifyClient(async () => response({})).query("Shop", "query {}"),
    ).rejects.toThrow("no data");
  });
  it("accounts for elapsed refill time before the next query", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const graphql = vi.fn().mockImplementation(async () =>
      response({
        data: { ok: true },
        extensions: {
          cost: {
            throttleStatus: {
              maximumAvailable: 1000,
              currentlyAvailable: 100,
              restoreRate: 50,
            },
          },
        },
      }),
    );
    const client = createShopifyClient(graphql, { sleep, now: () => now });
    await client.query("Products", "query {}", {}, 300);
    now = 2000;
    await client.query("Products", "query {}", {}, 300);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
  });
  it("stops before a retry would exceed the total sync budget", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      createShopifyClient(graphql, { now: () => 0, deadlineMs: 500 }).query(
        "Shop",
        "query {}",
      ),
    ).rejects.toThrow("time budget");
    expect(graphql).toHaveBeenCalledTimes(1);
  });
  it("provides an abort signal for a stalled request", async () => {
    const graphql = vi.fn(
      (_query: string, options?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal!.reason),
            { once: true },
          );
        }),
    );
    await expect(
      createShopifyClient(graphql, {
        requestTimeoutMs: 10,
        maxAttempts: 1,
      }).query("Shop", "query {}"),
    ).rejects.toMatchObject({ kind: "TRANSPORT", retryable: true });
  });
  it("rejects a throttle bucket that cannot refill", () => {
    expect(() =>
      msUntilAvailable(
        { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 0 },
        100,
      ),
    ).toThrow("capacity");
  });
});
