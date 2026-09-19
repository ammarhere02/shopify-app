import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
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

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const run = data.lastRun;

  const submit = (intent: "sync" | "reconcile") =>
    fetcher.submit({ intent }, { method: "post" });

  return (
    <s-page heading="Product Enrichment Hub">
      <s-section heading="Shop">
        <s-paragraph>Name: {data.shopName ?? "(sync to load)"}</s-paragraph>
        <s-paragraph>Domain: {data.shopDomain}</s-paragraph>
        <s-paragraph>
          Installed: {new Date(data.installedAt).toLocaleString()}
        </s-paragraph>
        <s-paragraph>Granted scopes: {data.scopes}</s-paragraph>
      </s-section>

      <s-section heading="Synchronization">
        <s-paragraph>
          Copy product details from Shopify into this app. Sync updates existing
          copies and keeps your badges and notes.
        </s-paragraph>
        <s-paragraph>
          Local products: {data.productCount} · variants: {data.variantCount}
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <s-button
            variant="primary"
            onClick={() => submit("sync")}
            loading={busy}
            disabled={busy}
          >
            Sync now
          </s-button>
          <s-button onClick={() => submit("reconcile")} disabled={busy}>
            Reconcile
          </s-button>
        </s-stack>

        {fetcher.data && (
          <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
            {fetcher.data.message ?? "Sync failed"}
          </s-banner>
        )}

        {run ? (
          <s-box padding="base">
            <s-paragraph>
              Last run #{run.id} ({run.type}): <strong>{run.status}</strong>
            </s-paragraph>
            <s-paragraph>
              Fetched {run.fetched} · inserted {run.inserted} · updated{" "}
              {run.updated} · marked stale {run.markedStale} · failed{" "}
              {run.failed}
            </s-paragraph>
            <s-paragraph>
              Started {new Date(run.startedAt).toLocaleString()}
              {run.completedAt &&
                ` · finished ${new Date(run.completedAt).toLocaleString()}`}
            </s-paragraph>
            {run.error && <s-paragraph>Error: {run.error}</s-paragraph>}
          </s-box>
        ) : (
          <s-paragraph>No sync has run yet.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
