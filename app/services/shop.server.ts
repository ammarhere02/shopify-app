import db from "../db.server";

/** Shopify domains are case-insensitive; store one canonical form so the unique index works. */
export function normalizeShopDomain(shop: string): string {
  return shop.trim().toLowerCase();
}

/**
 * Called after a successful OAuth install/re-auth.
 * Upsert = create on first install, or "reactivate" (clear uninstalledAt) on reinstall.
 */
export async function recordInstall(shop: string, scopes: string | undefined) {
  const shopDomain = normalizeShopDomain(shop);
  return db.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, scopes },
    update: { scopes, uninstalledAt: null, installedAt: new Date() },
  });
}

/** Called from the app/uninstalled webhook. Idempotent: running twice is harmless. */
export async function recordUninstall(shop: string) {
  const shopDomain = normalizeShopDomain(shop);
  await db.$transaction([
    db.shop.updateMany({
      where: { shopDomain, uninstalledAt: null },
      data: { uninstalledAt: new Date() },
    }),
    // Deleting sessions revokes our API access for this shop locally.
    db.session.deleteMany({ where: { shop: shopDomain } }),
  ]);
}

/**
 * Tenant resolver: turns a *verified* shop domain (from the Shopify session) into our Shop row.
 * Every data query in the app starts from the id returned here, never from request input.
 */
export async function requireActiveShop(shop: string) {
  const record = await db.shop.findUnique({
    where: { shopDomain: normalizeShopDomain(shop) },
  });
  if (!record || record.uninstalledAt) {
    throw new Response("Shop is not installed", { status: 403 });
  }
  return record;
}

/**
 * Whether the shop has granted a scope. `shops.scopes` is what the merchant approved
 * (kept fresh by afterAuth and the app/scopes_update webhook), not what the toml asks for:
 * a shop installed before a scope was added has not granted it until it re-approves.
 */
export function hasScope(scopes: string | null | undefined, scope: string) {
  return (scopes ?? "").split(",").map((s) => s.trim()).includes(scope);
}

/** Called from the app/scopes_update webhook when the merchant's granted scopes change. */
export async function recordScopesUpdate(shop: string, scopes: string[]) {
  await db.shop.updateMany({
    where: { shopDomain: normalizeShopDomain(shop) },
    data: { scopes: scopes.join(",") },
  });
}
