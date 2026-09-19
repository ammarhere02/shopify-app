import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { recordScopesUpdate } from "../services/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // HMAC-verified by authenticate.webhook; throws 401 if the signature is invalid.
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current as string[];
  if (session) {
    // Library-owned table: keep the token's scope in sync.
    await db.session.update({
      where: { id: session.id },
      data: { scope: current.toString() },
    });
  }
  // App-owned table: keep our tenant record in sync too.
  await recordScopesUpdate(shop, current);
  return new Response();
};
