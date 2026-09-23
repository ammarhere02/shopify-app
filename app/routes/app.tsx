import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect } from "react";
import { Link, Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { NavMenu } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

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
