import { createHash } from "node:crypto";

/** Everything that defines one generation. Same values → same hash, whatever the key order. */
export type GenerationInputForHash = {
  productSnapshot: unknown;
  merchantContext: string | null;
  selectedMediaIds: string[];
  model: string;
  promptVersion: string;
};

/** JSON with object keys sorted at every level, so the hash does not depend on key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256Hex(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Audit evidence that this exact input produced that output. NOT the idempotency key:
 * generating twice on purpose with the same input is allowed, the same click twice is not.
 * Media ids are sorted (selection order is not meaning) and context is trimmed.
 */
export function hashGenerationInput(input: GenerationInputForHash) {
  return sha256Hex(
    stableStringify({
      productSnapshot: input.productSnapshot,
      merchantContext: input.merchantContext?.trim() || null,
      selectedMediaIds: [...input.selectedMediaIds].sort(),
      model: input.model,
      promptVersion: input.promptVersion,
    }),
  );
}
