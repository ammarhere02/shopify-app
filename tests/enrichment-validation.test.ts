import { describe, expect, it } from "vitest";
import { validateEnrichment } from "../app/services/enrichment-validation";

const valid = { badgeText: "Staff Pick", badgeColor: "#1a7f37" };

describe("validateEnrichment", () => {
  it("accepts a valid badge, trims text and defaults active to true", () => {
    const result = validateEnrichment({ ...valid, badgeText: "  Staff Pick " });
    expect(result).toEqual({
      ok: true,
      value: {
        badgeText: "Staff Pick",
        badgeColor: "#1A7F37",
        internalNote: null,
        active: true,
      },
    });
  });

  it("rejects empty and too-long badge text", () => {
    expect(validateEnrichment({ ...valid, badgeText: " " }).ok).toBe(false);
    expect(validateEnrichment({ ...valid, badgeText: "x".repeat(41) }).ok).toBe(false);
    expect(validateEnrichment({ ...valid, badgeText: "x".repeat(40) }).ok).toBe(true);
  });

  it.each(["red", "#fff", "#12345G", "1A7F37", ""])("rejects color %s", (badgeColor) => {
    const result = validateEnrichment({ ...valid, badgeColor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.badgeColor).toBeDefined();
  });

  it("rejects a non-boolean active flag and non-object input", () => {
    expect(validateEnrichment({ ...valid, active: "yes" }).ok).toBe(false);
    expect(validateEnrichment(null).ok).toBe(false);
  });

  it("reports every invalid field at once", () => {
    const result = validateEnrichment({ badgeText: "", badgeColor: "nope" });
    if (result.ok) throw new Error("expected failure");
    expect(Object.keys(result.errors).sort()).toEqual(["badgeColor", "badgeText"]);
  });
});
