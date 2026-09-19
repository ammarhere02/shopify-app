import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { logger } from "../lib/logger.server";
import { ApiError, json, readJsonBody, withApiAuth } from "../services/api.server";
import { runProductSync, startSyncRun, SyncConflictError, SYNC_BUDGET_MS } from "../services/sync.server";
import { serializeSyncRun } from "../services/sync-run-view";
import { createShopifyClient } from "../shopify/graphql-client.server";
import { unauthenticated } from "../shopify.server";

// POST /api/v1/syncs   body (optional): { "type": "FULL" | "RECONCILE" }
export const action = ({ request }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"], bucket: "sync" }, async ({ shop, requestId }) => {
    const body = (await readJsonBody(request, { allowEmpty: true })) as { type?: unknown } | null;
    const type = body && typeof body === "object" && "type" in body ? body.type : "FULL";
    if (type !== "FULL" && type !== "RECONCILE")
      throw new ApiError(400, "invalid_sync_type", "type must be FULL or RECONCILE");

    // Session BEFORE the run: otherwise a shop without a token would be left with a RUNNING
    // row that blocks new syncs until the 15-minute abandon rule.
    const admin = await unauthenticated
      .admin(shop.shopDomain)
      .then((ctx) => ctx.admin)
      .catch(() => {
        throw new ApiError(409, "shop_session_unavailable", "No Shopify session for this shop. Open the app in Shopify admin, then retry.");
      });

    const run = await startSyncRun(shop.id, type).catch((err) => {
      if (err instanceof SyncConflictError)
        throw new ApiError(409, "sync_in_progress", "A sync is already running", { syncId: err.runningId });
      throw err;
    });

    const client = createShopifyClient(admin.graphql, {
      deadlineMs: run.startedAt.getTime() + SYNC_BUDGET_MS,
      logContext: { shopId: shop.id, syncRunId: run.id, requestId },
    });
    // Not awaited: the caller polls GET /syncs/{id}. No durable worker: a restart leaves the run
    // RUNNING until the abandon rule. runProductSync records its own failures; this catch is for
    // the re-auth Response it rethrows on purpose.
    void runProductSync(client, shop.id, run).catch((err) =>
      logger.error("api.sync_background_failed", {
        shopId: shop.id,
        syncRunId: run.id,
        requestId,
        message: err instanceof Error ? err.message : "Shopify session rejected",
      }),
    );

    return json({ data: serializeSyncRun(run) }, 202, { Location: `/api/v1/syncs/${run.id}` });
  });

export const loader = ({ request }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["POST"] }, async () => json({}));
