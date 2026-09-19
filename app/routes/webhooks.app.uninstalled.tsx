import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordUninstall } from "../services/shop.server";
import { processWebhook } from "../services/webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook verifies the HMAC signature on the raw body; throws 401 if invalid.
  const webhook = await authenticate.webhook(request);
  // A repeat delivery arrives after the shop is already inactive, so an active shop is not required.
  return processWebhook(webhook, { requireActiveShop: false }, async () => {
    await recordUninstall(webhook.shop);
  });
};
