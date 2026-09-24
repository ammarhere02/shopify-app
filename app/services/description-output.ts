import type { Citation } from "../ai/openrouter-client.server";
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

// ---------------------------------------------------------------------------
// Product research (the web search call that runs before the description)
// ---------------------------------------------------------------------------

export const RESEARCH_LIMITS = {
  facts: 12,
  factLength: 200,
  matchedProduct: 200,
  notes: 300,
  sourceUrl: 500,
} as const;

/** A specification the research call found, with the page it came from. */
export type ResearchFact = { fact: string; sourceUrl: string };

export type ResearchStatus =
  | "USED" // the product was identified and at least one fact had a confirmed source
  | "UNCERTAIN" // identity or sources not good enough: nothing from the web went into the description
  | "SKIPPED" // not attempted (switched off, or too little to identify the product)
  | "FAILED"; // the research call failed; the description used product data only

/**
 * What a generation records about its research, stored inside `validatedJson.research` and shown
 * to the merchant. Older generations have no such record (`research: null` in the view).
 */
export type ResearchRecord = {
  status: ResearchStatus;
  /** One plain sentence for the merchant explaining the status. */
  reason: string;
  /** The model's name for the product it believes it found (null when not identified). */
  matchedProduct: string | null;
  confidence: "high" | "medium" | "low" | null;
  /** Facts that passed every check and were given to the description prompt. */
  facts: ResearchFact[];
  /** Facts the model offered that were NOT used, each with the reason. Bounded. */
  rejected: Array<ResearchFact & { reason: string }>;
  /** Pages the search tool returned (from the provider's citations), for the merchant to open. */
  sources: Citation[];
  searches: number | null;
};

const RESEARCH_FIELDS = ["identified", "matchedProduct", "confidence", "facts", "notes"] as const;

/**
 * The research answer contract. The model is asked to say whether it identified the EXACT product
 * and to attach a source URL to every fact. The URL is only trusted when the search tool really
 * returned that page (see `validateResearchOutput`); the model saying so is not enough.
 */
export const RESEARCH_JSON_SCHEMA = {
  name: "product_research",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [...RESEARCH_FIELDS],
    properties: {
      identified: {
        type: "boolean",
        description: "true only when the search results name this exact product or model, not merely a similar one.",
      },
      matchedProduct: { type: "string", description: "Full product or model name as the sources give it; empty when not identified." },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are that the sources describe this exact product." },
      facts: {
        type: "array",
        description: "Concise specifications (dimensions, weight, materials, capacity, compatibility, ingredients, contents). At most 12.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fact", "sourceUrl"],
          properties: {
            fact: { type: "string", description: "One specification in plain text, under 200 characters." },
            sourceUrl: { type: "string", description: "The exact URL of the search result that states this fact." },
          },
        },
      },
      notes: {
        type: "string",
        description:
          "Always required, shown to the store owner. Not identified: what the search found (brand, closest products or codes) and what identifier is missing. Identified: which result matched and how.",
      },
    },
  } as Record<string, unknown>,
};

export type ResearchValidation = { record: ResearchRecord; ok: boolean; reason?: string };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

const plainLine = (value: unknown, max: number) =>
  typeof value === "string" ? htmlToText(value).replace(/\s+/g, " ").trim().slice(0, max) : "";

export const skippedResearch = (reason: string): ResearchRecord => ({
  status: "SKIPPED",
  reason,
  matchedProduct: null,
  confidence: null,
  facts: [],
  rejected: [],
  sources: [],
  searches: null,
});

export const failedResearch = (kind: string): ResearchRecord => ({
  ...skippedResearch(`Web research failed (${kind}); the draft uses the Shopify product data and your facts only.`),
  status: "FAILED",
});

/**
 * The merchant-facing sentence for a product the research could not confirm. It says why (not
 * found, or found with low confidence), what the model found, and what would let it confirm, so the
 * merchant is never left with a bare "not confirmed". Falls back to the searched sites when the
 * model gave no notes.
 */
function notIdentifiedReason(input: {
  identified: boolean;
  matchedProduct: string | null;
  confidence: "high" | "medium" | "low" | null;
  notes: string;
  citations: Citation[];
}): string {
  const { identified, matchedProduct, confidence, notes, citations } = input;
  const hosts = [...new Set(citations.map((c) => hostOf(c.url)).filter((h): h is string => !!h))].slice(0, 3);
  const lead =
    identified && matchedProduct
      ? `Closest match "${matchedProduct}" was found, but with ${confidence ?? "unknown"} confidence it is not confirmed as this exact product.`
      : "The exact product was not confirmed online.";
  const detail = notes
    ? ` ${/[.!?]$/.test(notes) ? notes : `${notes}.`}`
    : hosts.length
      ? ` The search returned pages from ${hosts.join(", ")}, but none named this exact item.`
      : " The search returned no pages.";
  return `${lead}${detail} Researched specifications were not used; adding the brand's SKU or style code to the product helps confirm it.`;
}

/**
 * Turn the research answer into a record the description call and the merchant can rely on.
 * Never throws and never fails the generation: anything doubtful ends as UNCERTAIN with the reason.
 * A fact is kept only when ALL of these hold:
 *  - the model says it identified the exact product with medium or high confidence;
 *  - the fact is a non-empty plain line within the length limit;
 *  - its source is an http(s) URL on a host the search tool actually returned (citations).
 *    Identity and sources come from the provider's own record of the searches, not from the model's claim.
 */
export function validateResearchOutput(content: string, citations: Citation[], searches: number | null): ResearchValidation {
  const base = { ...skippedResearch(""), sources: citations.slice(0, RESEARCH_LIMITS.facts * 2), searches };
  const uncertain = (reason: string, extra: Partial<ResearchRecord> = {}): ResearchValidation => ({
    ok: false,
    reason,
    record: { ...base, ...extra, status: "UNCERTAIN", reason },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(unwrapFence(content));
  } catch {
    return uncertain("The research answer could not be read, so no web facts were used.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return uncertain("The research answer could not be read, so no web facts were used.");
  }
  const obj = raw as Record<string, unknown>;
  const matchedProduct = plainLine(obj.matchedProduct, RESEARCH_LIMITS.matchedProduct) || null;
  const confidence = obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low" ? obj.confidence : null;
  const offered: unknown[] = Array.isArray(obj.facts) ? obj.facts.slice(0, RESEARCH_LIMITS.facts * 2) : [];
  const notes = plainLine(obj.notes, RESEARCH_LIMITS.notes);

  if (obj.identified !== true || confidence === null || confidence === "low") {
    return uncertain(notIdentifiedReason({ identified: obj.identified === true, matchedProduct, confidence, notes, citations }), {
      matchedProduct,
      confidence,
      rejected: [],
    });
  }

  const citedHosts = new Set(citations.map((c) => hostOf(c.url)).filter((h): h is string => !!h));
  const facts: ResearchFact[] = [];
  const rejected: ResearchRecord["rejected"] = [];
  const seen = new Set<string>();
  for (const item of offered) {
    const entry = item as { fact?: unknown; sourceUrl?: unknown } | null;
    const fact = plainLine(entry?.fact, RESEARCH_LIMITS.factLength + 1);
    const sourceUrl = typeof entry?.sourceUrl === "string" ? entry.sourceUrl.trim().slice(0, RESEARCH_LIMITS.sourceUrl) : "";
    if (!fact) continue;
    const reject = (reason: string) => rejected.length < RESEARCH_LIMITS.facts && rejected.push({ fact: fact.slice(0, RESEARCH_LIMITS.factLength), sourceUrl, reason });
    if (fact.length > RESEARCH_LIMITS.factLength) {
      reject("Too long to be one specification");
      continue;
    }
    const host = hostOf(sourceUrl);
    if (!host || !/^https?:/i.test(sourceUrl)) {
      reject("No usable source URL");
      continue;
    }
    if (!citedHosts.has(host)) {
      reject("Source was not among the pages the search returned");
      continue;
    }
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (facts.length < RESEARCH_LIMITS.facts) facts.push({ fact, sourceUrl });
  }

  if (facts.length === 0) {
    const why = citations.length === 0 ? "the search returned no pages to confirm the sources" : "no specification had a confirmed source";
    return uncertain(`Product identified as "${matchedProduct ?? "unknown"}" but ${why}; researched specifications were not used.`, {
      matchedProduct,
      confidence,
      rejected,
    });
  }
  return {
    ok: true,
    record: {
      ...base,
      status: "USED",
      reason: `${facts.length} specification${facts.length === 1 ? "" : "s"} for "${matchedProduct ?? "the product"}" came from web sources (${confidence} confidence). Check them against the linked pages before approving.`,
      matchedProduct,
      confidence,
      facts,
      rejected,
    },
  };
}
