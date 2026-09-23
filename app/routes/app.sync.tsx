import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { requireActiveShop } from "../services/shop.server";
import { createShopifyClient } from "../shopify/graphql-client.server";
import {
  getLatestSyncRun,
  runProductSync,
  startSyncRun,
  SyncConflictError,
  SYNC_BUDGET_MS,
} from "../services/sync.server";
import db from "../db.server";

const RUN_TONE = { SUCCEEDED: "success", FAILED: "critical", RUNNING: "info" } as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verifies the embedded-app session token; re-authenticates if missing/invalid.
  const { session } = await authenticate.admin(request);
  // Tenant comes from the verified session, never from URL params.
  const shop = await requireActiveShop(session.shop);

  const [productCount, variantCount, lastRun] = await Promise.all([
    db.product.count({ where: { shopId: shop.id, deletedAt: null } }),
    db.variant.count({
      where: { product: { shopId: shop.id, deletedAt: null } },
    }),
    getLatestSyncRun(shop.id),
  ]);

  return {
    shopDomain: shop.shopDomain,
    shopName: shop.name,
    installedAt: shop.installedAt.toISOString(),
    scopes: shop.scopes ?? "",
    productCount,
    variantCount,
    lastRun: lastRun && {
      id: lastRun.id,
      type: lastRun.type,
      status: lastRun.status,
      fetched: lastRun.fetched,
      inserted: lastRun.inserted,
      updated: lastRun.updated,
      markedStale: lastRun.markedStale,
      failed: lastRun.failed,
      error: lastRun.error,
      startedAt: lastRun.startedAt.toISOString(),
      completedAt: lastRun.completedAt?.toISOString() ?? null,
    },
  };
};

/** POST from the Sync buttons. intent = "sync" (FULL) or "reconcile" (RECONCILE). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await requireActiveShop(session.shop);
  const form = await request.formData();
  const type = form.get("intent") === "reconcile" ? "RECONCILE" : "FULL";

  try {
    const run = await startSyncRun(shop.id, type);
    const client = createShopifyClient(admin.graphql, {
      deadlineMs: run.startedAt.getTime() + SYNC_BUDGET_MS,
      logContext: { shopId: shop.id, syncRunId: run.id },
    });
    const finished = await runProductSync(client, shop.id, run);
    return {
      ok: finished.status === "SUCCEEDED",
      message: finished.error ?? "Catalog sync completed.",
    };
  } catch (err) {
    if (err instanceof SyncConflictError) {
      return {
        ok: false,
        message: "A sync is already running. Please wait for it to finish.",
      };
    }
    throw err;
  }
};

export default function Sync() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const pending = fetcher.formData?.get("intent");
  const run = data.lastRun;

  const submit = (intent: "sync" | "reconcile") =>
    fetcher.submit({ intent }, { method: "post" });

  // Success is a short toast; a failure stays on screen as a banner.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) shopify.toast.show(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  return (
    <s-page heading="Sync">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={pending === "sync"}
        disabled={busy}
        onClick={() => submit("sync")}
      >
        Sync now
      </s-button>
      <s-button slot="secondary-actions" loading={pending === "reconcile"} disabled={busy} onClick={() => submit("reconcile")}>
        Reconcile
      </s-button>

      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical" heading="Sync failed">
          {fetcher.data.message}
        </s-banner>
      )}

      <s-section heading="Catalogue">
        <s-paragraph>
          A full sync updates every product and keeps your badges, notes and descriptions.
          Reconcile only marks products that no longer exist in Shopify.
        </s-paragraph>
        <s-text>
          <s-text type="strong">{data.productCount}</s-text> products · <s-text type="strong">{data.variantCount}</s-text> variants stored locally
        </s-text>
        <s-link href="/app/products">Open the product catalogue</s-link>
      </s-section>

      <s-section heading="Last run">
        {run ? (
          <s-stack gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">
                Run #{run.id} · {run.type === "RECONCILE" ? "Reconcile" : "Full sync"}
              </s-text>
              <s-badge tone={RUN_TONE[run.status as keyof typeof RUN_TONE] ?? "neutral"}>{run.status}</s-badge>
            </s-stack>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Fetched</s-table-header>
                <s-table-header listSlot="inline">Inserted</s-table-header>
                <s-table-header listSlot="inline">Updated</s-table-header>
                <s-table-header listSlot="inline">Marked stale</s-table-header>
                <s-table-header listSlot="inline">Failed</s-table-header>
              </s-table-header-row>
              <s-table-body>
                <s-table-row>
                  <s-table-cell>{run.fetched}</s-table-cell>
                  <s-table-cell>{run.inserted}</s-table-cell>
                  <s-table-cell>{run.updated}</s-table-cell>
                  <s-table-cell>{run.markedStale}</s-table-cell>
                  <s-table-cell>{run.failed}</s-table-cell>
                </s-table-row>
              </s-table-body>
            </s-table>
            <s-text color="subdued">
              Started {new Date(run.startedAt).toLocaleString()}
              {run.completedAt && ` · finished ${new Date(run.completedAt).toLocaleString()}`}
            </s-text>
            {run.error && <s-banner tone="critical">{run.error}</s-banner>}
          </s-stack>
        ) : (
          <s-paragraph>No sync has run yet. Use Sync now to load your catalogue.</s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Shop">
        <s-stack gap="small">
          <s-text type="strong">{data.shopName ?? "(sync to load the name)"}</s-text>
          <s-text color="subdued">{data.shopDomain}</s-text>
          <s-text color="subdued">Installed {new Date(data.installedAt).toLocaleDateString()}</s-text>
          <s-text color="subdued">Scopes: {data.scopes.split(",").filter(Boolean).join(", ")}</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
