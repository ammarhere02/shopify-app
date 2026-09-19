import { beforeEach, expect, it, vi } from "vitest";
import type { SyncRun } from "@prisma/client";
import type { ShopifyClient } from "../app/shopify/graphql-client.server";
import { runProductSync } from "../app/services/sync.server";
import { product } from "./fixtures";

const { db } = vi.hoisted(() => ({
  db: {
    shop: { update: vi.fn() },
    syncRun: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../app/db.server", () => ({ default: db }));
vi.mock("../app/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.syncRun.findUniqueOrThrow.mockResolvedValue({ status: "FAILED" });
});
const run = () =>
  ({ id: 1, shopId: 1, type: "FULL", startedAt: new Date() }) as SyncRun;
const client = (page: unknown) =>
  ({
    query: vi.fn(async (operation: string) =>
      operation === "ShopIdentity"
        ? { shop: { id: "gid://shopify/Shop/1", name: "Demo" } }
        : page,
    ),
  }) as unknown as ShopifyClient;

it("does not write or clean up when a product fails mapping", async () => {
  const result = await runProductSync(
    client({
      products: {
        nodes: [{ ...product(), updatedAt: "invalid" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
    1,
    run(),
  );
  expect(result.status).toBe("FAILED");
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.syncRun.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ failed: 1, inserted: 0 }),
    }),
  );
});

it("rejects a missing pagination cursor without writing the page", async () => {
  await runProductSync(
    client({
      products: {
        nodes: [product()],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    }),
    1,
    run(),
  );
  expect(db.$transaction).not.toHaveBeenCalled();
  expect(db.syncRun.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        error: expect.stringContaining("Pagination"),
      }),
    }),
  );
});

it("records failure and preserves the original reauthentication response", async () => {
  const redirect = new Response(null, { status: 302 });
  const api = { query: vi.fn().mockRejectedValue(redirect) };
  await expect(runProductSync(api, 1, run())).rejects.toBe(redirect);
  expect(db.syncRun.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED" }),
    }),
  );
});

it("does not start fetching for an expired work budget", async () => {
  const api = client({});
  await runProductSync(api, 1, {
    ...run(),
    startedAt: new Date(Date.now() - 61_000),
  });
  expect(api.query).not.toHaveBeenCalled();
  expect(db.syncRun.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        error: expect.stringContaining("budget"),
      }),
    }),
  );
});
