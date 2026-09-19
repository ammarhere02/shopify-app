import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleProductUpdate } from "../services/webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC is verified on the raw body here; an invalid signature throws 401 before any DB work.
  const webhook = await authenticate.webhook(request);
  return handleProductUpdate(webhook);
};
