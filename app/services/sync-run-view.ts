import type { SyncRun } from "@prisma/client";

/** Public view of a sync run. The Shopify page cursor is an internal checkpoint and is left out. */
export function serializeSyncRun(run: SyncRun) {
  return {
    id: run.id,
    type: run.type,
    status: run.status,
    counts: {
      fetched: run.fetched,
      inserted: run.inserted,
      updated: run.updated,
      markedStale: run.markedStale,
      failed: run.failed,
    },
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}
