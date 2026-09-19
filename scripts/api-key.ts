/**
 * Operator tool for developer API keys (run on the server, needs DATABASE_URL):
 *   npm run api-key -- create <shop-domain> <label>
 *   npm run api-key -- list   <shop-domain>
 *   npm run api-key -- revoke <shop-domain> <key-prefix>
 * The plaintext key is printed once by `create` and cannot be recovered afterwards.
 */
import db from "../app/db.server";
import { listApiKeys, revokeApiKeys } from "../app/repositories/api-key.server";
import { createApiKey } from "../app/services/api-key.server";
import { normalizeShopDomain } from "../app/services/shop.server";

const [command, domain, arg] = process.argv.slice(2);

async function main() {
  if (!command || !domain) throw new Error("Usage: api-key <create|list|revoke> <shop-domain> [label|prefix]");
  const shop = await db.shop.findUnique({ where: { shopDomain: normalizeShopDomain(domain) } });
  if (!shop || shop.uninstalledAt) throw new Error(`No installed shop "${domain}"`);

  if (command === "create") {
    const key = await createApiKey(shop.id, arg ?? "");
    console.log(`Created key "${key.label}" (prefix ${key.keyPrefix}). Copy it now, it is not stored:\n\n${key.plaintext}\n`);
  } else if (command === "list") {
    console.table(await listApiKeys(shop.id));
  } else if (command === "revoke") {
    if (!arg) throw new Error("Give the key prefix shown by `list`");
    console.log(`Revoked ${await revokeApiKeys(shop.id, arg)} key(s).`);
  } else {
    throw new Error(`Unknown command "${command}"`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
