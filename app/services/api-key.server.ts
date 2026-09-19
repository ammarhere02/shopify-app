import { createHash, randomBytes } from "node:crypto";
import {
  findApiKeyByHash,
  insertApiKey,
  touchApiKeyLastUsed,
} from "../repositories/api-key.server";

export const API_KEY_PREFIX = "eh_live_";
const DISPLAY_PREFIX_LENGTH = 12; // "eh_live_" + 4 chars, lets a merchant recognise a key
const LAST_USED_THROTTLE_MS = 60_000;
const KEY_SHAPE = /^eh_live_[A-Za-z0-9_-]{43}$/;

/**
 * SHA-256 (not bcrypt): the key is 256 random bits, so it cannot be guessed offline the way a
 * password can, and an unsalted hash is what lets us find the row with one indexed lookup.
 */
export function hashApiKey(plaintext: string) {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function generateApiKey() {
  const plaintext = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    keyPrefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/** The plaintext is returned once here and exists nowhere else afterwards. */
export async function createApiKey(shopId: number, label: string) {
  const cleanLabel = label.trim().slice(0, 100);
  if (!cleanLabel) throw new Error("A label is required");
  const { plaintext, keyHash, keyPrefix } = generateApiKey();
  const row = await insertApiKey({ shopId, keyHash, keyPrefix, label: cleanLabel });
  return { plaintext, id: row.id, keyPrefix, label: cleanLabel };
}

export type ApiKeyFailure = "missing" | "malformed" | "unknown" | "revoked" | "shop_inactive";

/** Returns the key + its shop, or the reason for logs. Callers must NOT reveal the reason. */
export async function authenticateApiKey(authorization: string | null) {
  if (!authorization) return { ok: false as const, reason: "missing" as ApiKeyFailure };
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match || !KEY_SHAPE.test(match[1])) return { ok: false as const, reason: "malformed" as ApiKeyFailure };

  const key = await findApiKeyByHash(hashApiKey(match[1]));
  if (!key) return { ok: false as const, reason: "unknown" as ApiKeyFailure };
  if (key.revokedAt) return { ok: false as const, reason: "revoked" as ApiKeyFailure, keyId: key.id };
  if (key.shop.uninstalledAt) return { ok: false as const, reason: "shop_inactive" as ApiKeyFailure, keyId: key.id };

  await touchApiKeyLastUsed(key.id, new Date(Date.now() - LAST_USED_THROTTLE_MS));
  return { ok: true as const, key: { id: key.id, keyPrefix: key.keyPrefix }, shop: key.shop };
}
