import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordUninstall } from "../services/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook verifies the HMAC signature on the raw body; throws 401 if invalid.
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  await recordUninstall(shop);
  return new Response();
};
