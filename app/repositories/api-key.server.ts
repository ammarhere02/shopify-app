import db from "../db.server";

export function insertApiKey(data: { shopId: number; keyHash: string; keyPrefix: string; label: string }) {
  return db.developerApiKey.create({ data });
}

/** Lookup by the unique hash. The shop comes WITH the key: this is how the API finds its tenant. */
export function findApiKeyByHash(keyHash: string) {
  return db.developerApiKey.findUnique({ where: { keyHash }, include: { shop: true } });
}

export function listApiKeys(shopId: number) {
  return db.developerApiKey.findMany({
    where: { shopId },
    orderBy: { id: "asc" },
    select: { id: true, keyPrefix: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
}

/** Shop-scoped and idempotent. Returns how many active keys were revoked. */
export async function revokeApiKeys(shopId: number, keyPrefix: string) {
  const result = await db.developerApiKey.updateMany({
    where: { shopId, keyPrefix, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Audit trail without a write per request: only touches rows whose value is older than the cutoff. */
export function touchApiKeyLastUsed(id: number, olderThan: Date) {
  return db.developerApiKey.updateMany({
    where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: olderThan } }] },
    data: { lastUsedAt: new Date() },
  });
}
