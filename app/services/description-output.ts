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

/** Beyond limit × this, an over-long field is treated as a broken answer, not an overrun. */
const RUNAWAY_FACTOR = 5;

/** Cut at the last word boundary that fits, ending with an ellipsis. Never longer than `max`. */
export function shortenText(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?-]+$/, "")}…`;
}

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
      shortDescription: { type: "string", description: "One or two plain-text sentences. Hard limit 300 characters." },
      seoTitle: { type: "string", description: "Plain text. Aim for 40-60 characters. Hard limit 70 characters." },
      seoDescription: { type: "string", description: "Plain text, one sentence. Aim for 120-150 characters. Hard limit 160 characters." },
      highlights: { type: "array", items: { type: "string" }, description: "Up to 8 short plain-text selling points, each under 100 characters." },
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
    if (typeof obj[key] !== "string") return fail(`${key} must be a string`);
  }
  if (!isStringArray(obj.highlights)) return fail("highlights must be an array of strings");
  if (!isStringArray(obj.warnings)) return fail("warnings must be an array of strings");

  // The description is what gets written to Shopify, and cutting HTML is not safe: too long = invalid.
  if ((obj.descriptionHtml as string).length > OUTPUT_LIMITS.descriptionHtml) {
    return fail(`descriptionHtml is longer than ${OUTPUT_LIMITS.descriptionHtml} characters`);
  }
  // A model that ignores the limits by this much did not follow the contract at all.
  for (const key of ["shortDescription", "seoTitle", "seoDescription"] as const) {
    if ((obj[key] as string).length > OUTPUT_LIMITS[key] * RUNAWAY_FACTOR) return fail(`${key} is far longer than ${OUTPUT_LIMITS[key]} characters`);
  }
  if (obj.highlights.length > OUTPUT_LIMITS.highlights * RUNAWAY_FACTOR) return fail("Too many highlights");
  if (obj.warnings.length > OUTPUT_LIMITS.warnings * RUNAWAY_FACTOR) return fail("Too many warnings");

  const descriptionHtml = sanitizeHtml(obj.descriptionHtml as string);
  if (!htmlToText(descriptionHtml)) return fail("descriptionHtml is empty after sanitizing");

  // The remaining fields are plain-text suggestions that are shown, never written anywhere.
  // Models cannot count characters reliably, so a modest overrun is repaired (cut at a word
  // boundary) and reported as a warning instead of discarding an otherwise good description.
  const repairs: string[] = [];
  const fit = (label: string, text: string, max: number) => {
    const plain = htmlToText(text);
    if (plain.length <= max) return plain;
    repairs.push(`${label} was shortened from ${plain.length} to fit ${max} characters`);
    return shortenText(plain, max);
  };
  const highlights = obj.highlights.map((h) => htmlToText(h)).filter(Boolean);
  if (highlights.length > OUTPUT_LIMITS.highlights) repairs.push(`Only the first ${OUTPUT_LIMITS.highlights} highlights were kept`);
  const warnings = obj.warnings.map((w) => htmlToText(w)).filter(Boolean);

  return {
    ok: true,
    raw,
    value: {
      descriptionHtml,
      shortDescription: fit("shortDescription", obj.shortDescription as string, OUTPUT_LIMITS.shortDescription),
      seoTitle: fit("seoTitle", obj.seoTitle as string, OUTPUT_LIMITS.seoTitle),
      seoDescription: fit("seoDescription", obj.seoDescription as string, OUTPUT_LIMITS.seoDescription),
      highlights: highlights
        .slice(0, OUTPUT_LIMITS.highlights)
        .map((h, i) => fit(`Highlight ${i + 1}`, h, OUTPUT_LIMITS.highlightLength)),
      warnings: [
        ...warnings.slice(0, OUTPUT_LIMITS.warnings).map((w) => shortenText(w, OUTPUT_LIMITS.warningLength)),
        ...repairs,
      ],
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
