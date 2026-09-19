import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { ApiError, json, withApiAuth } from "../services/api.server";
import { serializeSyncRun } from "../services/sync-run-view";

// GET /api/v1/syncs/{id}
export const loader = ({ request, params }: LoaderFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async ({ shop }) => {
    if (!params.id || !/^[1-9]\d{0,9}$/.test(params.id))
      throw new ApiError(400, "invalid_sync_id", "Sync id must be a positive integer");
    // shopId in the WHERE: another shop's run id is a 404, not a leak.
    const run = await db.syncRun.findFirst({ where: { id: Number(params.id), shopId: shop.id } });
    if (!run) throw new ApiError(404, "sync_not_found", "Sync not found");
    return json({ data: serializeSyncRun(run) });
  });

export const action = ({ request }: ActionFunctionArgs) =>
  withApiAuth(request, { methods: ["GET"] }, async () => json({}));
