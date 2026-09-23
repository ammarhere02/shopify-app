import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";

// The catalogue is the app's home. Authenticating first keeps the embedded session flow
// (re-auth redirects) identical to every other admin page; the sync tools live at /app/sync.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  return redirect(`/app/products${url.search}`);
};
