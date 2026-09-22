import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleProductUpdate } from "../services/webhook.server";

// A created product is handled exactly like an updated one: the payload only supplies the id,
// the product is re-fetched from Shopify, and an unknown local row is created. The receipt keeps
// the real topic (PRODUCTS_CREATE), so the audit trail still tells the two apart.
export const action = async ({ request }: ActionFunctionArgs) => {
  const webhook = await authenticate.webhook(request);
  return handleProductUpdate(webhook);
};
