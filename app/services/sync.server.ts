import type { Prisma, SyncRun, SyncType } from "@prisma/client";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import type { ShopifyClient } from "../shopify/graphql-client.server";
import {
  PRODUCTS_PAGE_QUERY,
  PRODUCTS_PAGE_SIZE,
  PRODUCT_VARIANTS_QUERY,
  SHOP_QUERY,
  VARIANTS_PER_PRODUCT,
  VARIANTS_PAGE_SIZE,
} from "../shopify/queries";
import {
  mapProductNode,
  type MappedProduct,
  type ShopifyProductNode,
} from "./product-mapping";
import {
  markStaleProducts,
  upsertProductWithVariants,
} from "../repositories/product.server";

/** A RUNNING sync older than this is assumed dead (server crashed mid-run). */
const STALE_RUN_MS = 15 * 60 * 1000;
/** Rough cost estimate for one products page; used to wait for the bucket proactively. */
const PAGE_EXPECTED_COST = 2 + PRODUCTS_PAGE_SIZE * (3 + VARIANTS_PER_PRODUCT);
/** Safety bound so a bug can never loop forever (25 * 400 = 10,000 products). */
const MAX_PAGES = 400;
const MAX_VARIANT_PAGES = 100;
// Small development catalogs run in the request. Check between operations;
// an in-flight API call or DB transaction has its own shorter timeout.
export const SYNC_BUDGET_MS = 60_000;

export class SyncConflictError extends Error {
  constructor(public runningId: number) {
    super("A sync is already running for this shop");
    this.name = "SyncConflictError";
  }
}

type ProductsPage = {
  products: {
    nodes: ShopifyProductNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type ShopIdentity = {
  shop: { id: string; name: string; myshopifyDomain: string };
};

function nextCursor(
  current: string | null,
  info: { hasNextPage: boolean; endCursor: string | null },
) {
  if (info.hasNextPage && (!info.endCursor || info.endCursor === current)) {
    throw new Error("Pagination did not advance; run the sync again");
  }
  return info.endCursor;
}

/** Network requests stay outside MySQL transactions. Never save a partial variant list. */
export async function completeVariants(
  client: ShopifyClient,
  node: ShopifyProductNode,
  checkBudget: () => void,
) {
  let connection = node.variants;
  const variants = [...connection.nodes];
  const cursors = new Set<string>();
  for (let page = 0; connection.pageInfo.hasNextPage; page++) {
    checkBudget();
    if (page >= MAX_VARIANT_PAGES)
      throw new Error("Variant pagination safety limit reached");
    const after = nextCursor(null, connection.pageInfo)!;
    if (cursors.has(after))
      throw new Error("Variant pagination repeated a cursor");
    cursors.add(after);
    const data = await client.query<{
      product: Pick<ShopifyProductNode, "id" | "updatedAt" | "variants"> | null;
    }>(
      "ProductVariantsPage",
      PRODUCT_VARIANTS_QUERY,
      { id: node.id, first: VARIANTS_PAGE_SIZE, after },
      VARIANTS_PAGE_SIZE + 3,
    );
    if (
      !data.product ||
      data.product.id !== node.id ||
      data.product.updatedAt !== node.updatedAt
    ) {
      throw new Error(
        "A product changed or disappeared during variant pagination; run the sync again",
      );
    }
    connection = data.product.variants;
    nextCursor(after, connection.pageInfo);
    variants.push(...connection.nodes);
  }
  return {
    ...node,
    variants: { nodes: variants, pageInfo: connection.pageInfo },
  };
}

/** Fence an abandoned worker and serialize page commits with starting a replacement run. */
async function lockActiveRun(
  tx: Prisma.TransactionClient,
  shopId: number,
  runId: number,
) {
  await tx.$queryRaw`SELECT id FROM shops WHERE id = ${shopId} FOR UPDATE`;
  const shop = await tx.shop.findUnique({ where: { id: shopId } });
  const active = await tx.syncRun.findFirst({
    where: { id: runId, shopId, status: "RUNNING" },
  });
  if (!shop || shop.uninstalledAt || !active)
    throw new Error("Shop or sync is no longer active");
}

/**
 * Create the sync_runs row, refusing if another run is active.
 * SELECT ... FOR UPDATE on the shop row serializes two simultaneous clicks:
 * the second waits for the first's transaction, then sees its RUNNING row.
 */
export async function startSyncRun(
  shopId: number,
  type: SyncType,
): Promise<SyncRun> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM shops WHERE id = ${shopId} FOR UPDATE`;
    const shop = await tx.shop.findUnique({ where: { id: shopId } });
    if (!shop || shop.uninstalledAt)
      throw new Response("Shop is not installed", { status: 403 });

    const running = await tx.syncRun.findFirst({
      where: { shopId, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    if (running) {
      const age = Date.now() - running.startedAt.getTime();
      if (age < STALE_RUN_MS) throw new SyncConflictError(running.id);
      // Previous run died without finishing; close it so it doesn't block forever.
      await tx.syncRun.update({
        where: { id: running.id },
        data: {
          status: "FAILED",
          error: "Abandoned (timed out)",
          completedAt: new Date(),
        },
      });
    }

    return tx.syncRun.create({ data: { shopId, type, startedAt: new Date() } });
  });
}

/**
 * Full catalog sync: Shopify Admin GraphQL -> MySQL.
 * Runs synchronously (acceptable for small dev catalogs; see docs/DESIGN.md for the queue design).
 *
 * Failure strategy: each page is committed in its own transaction and the cursor is
 * checkpointed. If page N fails, pages 1..N-1 stay saved, the run is FAILED, and a re-run
 * is safe because every write is an idempotent upsert. Stale-marking only happens after a
 * COMPLETE run, so a partial run can never wrongly delete products.
 */
export async function runProductSync(
  client: ShopifyClient,
  shopId: number,
  run: SyncRun,
): Promise<SyncRun> {
  const counts = { fetched: 0, inserted: 0, updated: 0, failed: 0 };
  const checkBudget = () => {
    if (Date.now() - run.startedAt.getTime() >= SYNC_BUDGET_MS) {
      throw new Error(
        "Sync exceeded its 60-second work budget. Re-run safely; larger catalogs need a worker.",
      );
    }
  };
  const log = { shopId, syncRunId: run.id };
  logger.info("sync.started", { ...log, type: run.type });

  try {
    checkBudget();
    // 1. Shop identity (explicit fields). Keeps shops.shopifyShopGid / name current.
    const identity = await client.query<ShopIdentity>(
      "ShopIdentity",
      SHOP_QUERY,
    );
    await db.shop.update({
      where: { id: shopId },
      data: { shopifyShopGid: identity.shop.id, name: identity.shop.name },
    });

    // 2. Cursor pagination over products.
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      checkBudget();
      const data: ProductsPage = await client.query<ProductsPage>(
        "ProductsPage",
        PRODUCTS_PAGE_QUERY,
        {
          first: PRODUCTS_PAGE_SIZE,
          after: cursor,
          variantsFirst: VARIANTS_PER_PRODUCT,
        },
        PAGE_EXPECTED_COST,
      );
      const { nodes, pageInfo } = data.products;
      counts.fetched += nodes.length;

      const newCursor = nextCursor(cursor, pageInfo);
      if (pageInfo.hasNextPage && seenCursors.has(newCursor!)) {
        throw new Error("Product pagination repeated a cursor");
      }
      if (newCursor) seenCursors.add(newCursor);
      const mappedProducts: MappedProduct[] = [];
      for (const node of nodes) {
        checkBudget();
        // A rejected product aborts the page, so cleanup cannot confuse it with a deletion.
        mappedProducts.push(
          mapProductNode(await completeVariants(client, node, checkBudget)),
        );
      }

      // 3. One transaction per page: all products of the page commit together.
      checkBudget();
      const syncedAt = new Date();
      const committed = await db.$transaction(
        async (tx) => {
          await lockActiveRun(tx, shopId, run.id);
          let inserted = 0;
          let updated = 0;
          for (const mapped of mappedProducts) {
            const result = await upsertProductWithVariants(
              tx,
              shopId,
              mapped,
              syncedAt,
            );
            if (result.inserted) inserted++;
            else updated++;
          }
          const progress = {
            ...counts,
            inserted: counts.inserted + inserted,
            updated: counts.updated + updated,
          };
          // Data and checkpoint commit together. JS counters change only after commit.
          await tx.syncRun.update({
            where: { id: run.id },
            data: { ...progress, cursor: newCursor },
          });
          return progress;
        },
        { timeout: 30_000 },
      );

      // 4. Checkpoint progress so status/counters are observable while running.
      Object.assign(counts, committed);
      cursor = newCursor;
      if (!pageInfo.hasNextPage) break;
      if (page === MAX_PAGES)
        throw new Error(`Stopped after ${MAX_PAGES} pages (safety bound)`);
    }

    // 5. Complete run -> products we didn't see are gone from Shopify: soft delete.
    checkBudget();
    const done = await db.$transaction(
      async (tx) => {
        await lockActiveRun(tx, shopId, run.id);
        const markedStale = await markStaleProducts(tx, shopId, run.startedAt);
        return tx.syncRun.update({
          where: { id: run.id },
          data: {
            ...counts,
            markedStale,
            status: "SUCCEEDED",
            completedAt: new Date(),
          },
        });
      },
      { timeout: 30_000 },
    );
    logger.info("sync.succeeded", {
      ...log,
      ...counts,
      markedStale: done.markedStale,
      durationMs: Date.now() - run.startedAt.getTime(),
    });
    return done;
  } catch (err) {
    // Fetched products that did not commit (including a rolled-back page).
    counts.failed = counts.fetched - counts.inserted - counts.updated;
    const reauth = err instanceof Response;
    const message = reauth
      ? `Shopify session expired (HTTP ${err.status}); re-authenticating. Please run the sync again.`
      : err instanceof Error
        ? err.message
        : String(err);
    logger.error("sync.failed", { ...log, ...counts, message });
    await db.syncRun.updateMany({
      where: { id: run.id, shopId, status: "RUNNING" },
      data: {
        ...counts,
        status: "FAILED",
        error: message.slice(0, 1000),
        completedAt: new Date(),
      },
    });
    if (reauth) throw err; // let the framework perform the re-auth redirect
    return db.syncRun.findUniqueOrThrow({ where: { id: run.id } });
  }
}

export function getLatestSyncRun(shopId: number) {
  return db.syncRun.findFirst({
    where: { shopId },
    orderBy: { startedAt: "desc" },
  });
}
