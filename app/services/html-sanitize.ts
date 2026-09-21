/**
 * Allowlist HTML sanitizer for product descriptions.
 *
 * Safe by construction rather than by blocklist: the output is rebuilt from scratch and can
 * only ever contain (a) the allowed tag names with NO attributes and (b) escaped text.
 * Whatever the input does (event handlers, javascript: URLs, malformed or nested tags),
 * nothing else has a way into the result. Links and images are excluded on purpose.
 */
export const ALLOWED_TAGS = ["p", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "br"] as const;

const ALLOWED = new Set<string>(ALLOWED_TAGS);
const VOID = new Set(["br"]);
/** Elements whose CONTENT must go too, not just the tag. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "noscript", "template", "textarea", "title",
  "head", "svg", "math", "object", "embed", "select", "button", "form",
]);
/** Common equivalents, so harmless markup is kept instead of flattened. */
const RENAME: Record<string, string> = { b: "strong", i: "em", h1: "h2", h5: "h4", h6: "h4" };

const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|<|[^<]+/g;
const ENTITY = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/;

function escapeText(text: string) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === "&") out += ENTITY.test(text.slice(i, i + 40)) ? "&" : "&amp;";
    else out += ch;
  }
  return out;
}

export function sanitizeHtml(input: string): string {
  const open: string[] = [];
  let out = "";
  let dropUntil: string | null = null;

  for (const match of input.matchAll(TOKEN)) {
    const token = match[0];
    const name = match[1]?.toLowerCase();
    const closing = token.startsWith("</");

    if (dropUntil) {
      if (name === dropUntil && closing) dropUntil = null;
      continue;
    }
    if (!name) {
      // Comment / doctype are dropped; a bare "<" and plain text are escaped.
      if (!token.startsWith("<!")) out += escapeText(token);
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !token.endsWith("/>")) dropUntil = name;
      continue;
    }
    const tag = RENAME[name] ?? name;
    if (!ALLOWED.has(tag)) continue; // unknown tag: removed, its text content is kept

    if (VOID.has(tag)) {
      if (!closing) out += `<${tag}>`;
    } else if (!closing) {
      open.push(tag);
      out += `<${tag}>`;
    } else {
      // Close only what is open, closing anything left open inside it first.
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      while (open.length > at) out += `</${open.pop()}>`;
    }
  }
  while (open.length) out += `</${open.pop()}>`;
  return out.trim();
}

/** Visible text only: used for claim detection, hashing context and length checks. */
export function htmlToText(html: string) {
  return sanitizeHtml(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
