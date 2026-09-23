import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect } from "react";
import {
  Link,
  Outlet,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { NavMenu } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

const LOADING_CSS = `
.eh-loading{position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:rgba(255,255,255,.55);backdrop-filter:blur(1px);animation:eh-loading-in .2s ease-out .15s both}
.eh-loading span{width:40px;height:40px;border-radius:50%;border:3px solid rgba(0,128,96,.2);border-top-color:#008060;animation:eh-spin .8s linear infinite}
@keyframes eh-spin{to{transform:rotate(360deg)}}
@keyframes eh-loading-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.eh-loading{animation:none}.eh-loading span{animation-duration:1.6s}}
`;

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  // Shopify's own loading bar at the top of the admin while a page loader runs (opening a product, filtering).
  const navigation = useNavigation();
  useEffect(() => {
    if (typeof shopify === "undefined" || !shopify.loading) return;
    shopify.loading(navigation.state !== "idle");
  }, [navigation.state]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Products
        </Link>
        <Link to="/app/sync">Sync</Link>
      </NavMenu>
      {navigation.state === "loading" && (
        <div
          className="eh-loading"
          role="status"
          aria-live="polite"
          aria-label="Loading"
        >
          <style>{LOADING_CSS}</style>
          <span />
        </div>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
