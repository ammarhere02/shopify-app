import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordScopesUpdate } from "../services/shop.server";
import { processWebhook } from "../services/webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC-verified by authenticate.webhook; throws 401 if the signature is invalid.
  const webhook = await authenticate.webhook(request);
  const { payload, session, shop } = webhook;

  return processWebhook(webhook, { requireActiveShop: false }, async () => {
    const current = payload.current;
    if (!Array.isArray(current) || !current.every((s) => typeof s === "string"))
      throw new Error("scopes_update payload has no scope list");
    if (session) {
      // Library-owned table: keep the token's scope in sync.
      await db.session.update({
        where: { id: session.id },
        data: { scope: current.toString() },
      });
    }
    // App-owned table: keep our tenant record in sync too.
    await recordScopesUpdate(shop, current);
  });
};
