import { htmlToText, sanitizeHtml } from "./html-sanitize";

/**
 * The output contract of a description generation.
 * The same rules exist twice on purpose: as a JSON Schema the provider is asked to enforce,
 * and as server-side validation. The provider's enforcement is a convenience; the model's
 * answer stays an untrusted string until `validateModelOutput` accepts it.
 */
export const OUTPUT_LIMITS = {
  descriptionHtml: 10_000,
  shortDescription: 300,
  seoTitle: 70,
  seoDescription: 160,
  highlights: 8,
  highlightLength: 120,
  warnings: 10,
  warningLength: 200,
} as const;

export type DescriptionOutput = {
  descriptionHtml: string;
  shortDescription: string;
  seoTitle: string;
  seoDescription: string;
  highlights: string[];
  warnings: string[];
};

const FIELDS = [
  "descriptionHtml",
  "shortDescription",
  "seoTitle",
  "seoDescription",
  "highlights",
  "warnings",
] as const;

export const DESCRIPTION_JSON_SCHEMA = {
  name: "product_description",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [...FIELDS],
    properties: {
      descriptionHtml: {
        type: "string",
        description: "Product description as simple HTML: p, h2-h4, ul, ol, li, strong, em, br only.",
      },
      shortDescription: { type: "string", description: "One or two plain-text sentences." },
      seoTitle: { type: "string", description: "Plain text, at most 70 characters." },
      seoDescription: { type: "string", description: "Plain text, at most 160 characters." },
      highlights: { type: "array", items: { type: "string" }, description: "Up to 8 short plain-text selling points." },
      warnings: {
        type: "array",
        items: { type: "string" },
        description: "Every claim you could not verify from the product data, e.g. 'Unverified material claim'.",
      },
    },
  } as Record<string, unknown>,
};

export type ValidationResult =
  | { ok: true; raw: unknown; value: DescriptionOutput }
  | { ok: false; raw: unknown | null; reason: string };

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

/** Free models often wrap JSON in a Markdown fence. Unwrapping is harmless: the result is still validated. */
function unwrapFence(content: string) {
  const match = content.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : content.trim();
}

export function validateModelOutput(content: string): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(unwrapFence(content));
  } catch {
    return { ok: false, raw: null, reason: "Model output is not valid JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, raw, reason: "Model output is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const fail = (reason: string): ValidationResult => ({ ok: false, raw, reason });

  const extra = Object.keys(obj).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length) return fail(`Unexpected field: ${extra.slice(0, 3).join(", ")}`);
  const missing = FIELDS.filter((k) => !(k in obj));
  if (missing.length) return fail(`Missing field: ${missing.join(", ")}`);

  for (const key of ["descriptionHtml", "shortDescription", "seoTitle", "seoDescription"] as const) {
    const value = obj[key];
    if (typeof value !== "string") return fail(`${key} must be a string`);
    if (value.length > OUTPUT_LIMITS[key]) return fail(`${key} is longer than ${OUTPUT_LIMITS[key]} characters`);
  }
  if (!isStringArray(obj.highlights)) return fail("highlights must be an array of strings");
  if (!isStringArray(obj.warnings)) return fail("warnings must be an array of strings");
  if (obj.highlights.length > OUTPUT_LIMITS.highlights) return fail("Too many highlights");
  if (obj.warnings.length > OUTPUT_LIMITS.warnings) return fail("Too many warnings");
  if (obj.highlights.some((h) => h.length > OUTPUT_LIMITS.highlightLength)) return fail("A highlight is too long");
  if (obj.warnings.some((w) => w.length > OUTPUT_LIMITS.warningLength)) return fail("A warning is too long");

  const descriptionHtml = sanitizeHtml(obj.descriptionHtml as string);
  if (!htmlToText(descriptionHtml)) return fail("descriptionHtml is empty after sanitizing");

  // Every other field is plain text: tags are removed, not rendered.
  const plain = (text: string) => htmlToText(text);
  return {
    ok: true,
    raw,
    value: {
      descriptionHtml,
      shortDescription: plain(obj.shortDescription as string),
      seoTitle: plain(obj.seoTitle as string),
      seoDescription: plain(obj.seoDescription as string),
      highlights: obj.highlights.map(plain).filter(Boolean),
      warnings: obj.warnings.map(plain).filter(Boolean),
    },
  };
}

/**
 * Claim categories the assignment names. A pattern that matches the GENERATED text but not the
 * TRUSTED text (Shopify fields + merchant-entered facts) is an unsupported claim.
 * Pattern-based on purpose: cheap, explainable, testable. It is a reviewing aid for the merchant,
 * not a guarantee; paraphrases will get through, which is why approval stays manual.
 */
const CLAIM_PATTERNS: Array<{ category: string; patterns: RegExp[] }> = [
  {
    category: "medical",
    patterns: [/\b(cures?|heals?|treats?|prevents?|therapeutic|clinically (?:proven|tested)|dermatologist|hypoallergenic|antibacterial|anti-?microbial|pain relief|fda)\b/i],
  },
  {
    category: "legal",
    patterns: [/\b(patented|patent[- ]pending|trademarked|legally|compliant|complies with|approved by)\b/i],
  },
  {
    category: "sustainability",
    patterns: [/\b(eco-?friendly|sustainab\w+|biodegradable|compostable|recycl\w+|carbon[- ]neutral|zero[- ]waste|organic|vegan|cruelty[- ]free|non-?toxic|bpa[- ]free)\b/i],
  },
  {
    category: "certification",
    patterns: [/\b(certified|certification|iso ?\d{3,5}|ce[- ]marked|ul[- ]listed|oeko-?tex|gots|fair ?trade|fsc|energy star)\b/i],
  },
  {
    category: "origin",
    patterns: [/\b(made in|handmade in|crafted in|sourced from|imported from|product of)\s+[A-Z]/, /\b(hand-?made|hand-?crafted|locally made)\b/i],
  },
  {
    category: "performance",
    patterns: [/\b(waterproof|water-?resistant|fireproof|flame[- ]retardant|shatterproof|unbreakable|scratch-?proof|uv[- ]resistant|\d+\s?(?:%|x)\s?(?:more|faster|stronger|lighter|better)|lasts? (?:up to )?\d+|best[- ]in[- ]class|#1|number one)\b/i],
  },
  {
    category: "warranty",
    patterns: [/\b(warranty|guaranteed?|money[- ]back|lifetime (?:guarantee|replacement)|free returns?)\b/i],
  },
  {
    category: "material",
    patterns: [/\b(100% \w+|genuine leather|full[- ]grain|solid (?:wood|oak|brass|gold|silver)|stainless steel|sterling silver|\d{1,2}k gold|merino|cashmere|pure (?:silk|cotton|wool|linen)|titanium|carbon fib(?:er|re)|bamboo)\b/i],
  },
];

/** Returns one warning per category whose wording appears in `generated` but nowhere in `trusted`. */
export function detectUnsupportedClaims(generated: string, trusted: string): string[] {
  const warnings: string[] = [];
  const trustedLower = trusted.toLowerCase();
  for (const { category, patterns } of CLAIM_PATTERNS) {
    for (const pattern of patterns) {
      const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      const unsupported = [...generated.matchAll(global)]
        .map((m) => m[0].trim())
        .find((phrase) => !trustedLower.includes(phrase.toLowerCase()));
      if (unsupported) {
        warnings.push(`Unverified ${category} claim: "${unsupported.slice(0, 60)}"`);
        break;
      }
    }
  }
  return warnings;
}

/** Model-reported warnings first, then ours, without duplicates, bounded. */
export function mergeWarnings(fromModel: string[], detected: string[]) {
  return [...new Set([...fromModel, ...detected])].slice(0, OUTPUT_LIMITS.warnings * 2);
}
