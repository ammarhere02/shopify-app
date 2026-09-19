/**
 * Boundary validation for app-owned enrichment data.
 * Shared by the admin UI and the developer API so both apply identical rules.
 */

export const BADGE_TEXT_MAX = 40;
export const INTERNAL_NOTE_MAX = 2000;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type EnrichmentInput = {
  badgeText: string;
  badgeColor: string;
  internalNote: string | null;
  active: boolean;
};

export type ValidationResult =
  | { ok: true; value: EnrichmentInput }
  | { ok: false; errors: Record<string, string> };

export function validateEnrichment(input: unknown): ValidationResult {
  const errors: Record<string, string> = {};
  const raw = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;

  const badgeText = typeof raw.badgeText === "string" ? raw.badgeText.trim() : "";
  if (!badgeText) errors.badgeText = "Badge text is required";
  else if (badgeText.length > BADGE_TEXT_MAX)
    errors.badgeText = `Badge text must be ${BADGE_TEXT_MAX} characters or fewer`;

  const badgeColor = typeof raw.badgeColor === "string" ? raw.badgeColor.trim() : "";
  if (!HEX_COLOR.test(badgeColor))
    errors.badgeColor = "Badge color must look like #RRGGBB";

  let internalNote: string | null = null;
  if (raw.internalNote != null && raw.internalNote !== "") {
    if (typeof raw.internalNote !== "string")
      errors.internalNote = "Internal note must be text";
    else if (raw.internalNote.length > INTERNAL_NOTE_MAX)
      errors.internalNote = `Internal note must be ${INTERNAL_NOTE_MAX} characters or fewer`;
    else internalNote = raw.internalNote.trim() || null;
  }

  // Absent = true (sensible default); anything else must be a real boolean.
  let active = true;
  if (raw.active !== undefined) {
    if (typeof raw.active !== "boolean") errors.active = "Active must be true or false";
    else active = raw.active;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { badgeText, badgeColor: badgeColor.toUpperCase(), internalNote, active },
  };
}
