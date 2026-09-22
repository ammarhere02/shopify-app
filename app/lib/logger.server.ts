/**
 * Minimal structured (JSON) logger. One line per event, easy to search and parse.
 * Two layers of redaction, because a secret can arrive under an innocent key (an error
 * message quoting a URL, a "reason" field echoing a response):
 *  1. by key name: token/secret/authorization/password/api key/cookie → "[REDACTED]"
 *  2. by value shape: strings are scanned for credential patterns and data: URIs, and are
 *     cut at a fixed length so a whole prompt, HTML body or base64 image cannot be logged.
 * Nested objects and arrays are walked with the same rules.
 */
const SENSITIVE_KEY = /token|secret|authorization|password|api[_-]?key|cookie/i;
// Bearer headers; OpenRouter (sk-or-…), OpenAI-style (sk-…), Shopify (shpat_/shpca_/shpss_/shpua_)
// and this app's own (eh_live_) keys; and any inline data: URI (base64 images).
const SENSITIVE_VALUE = /Bearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{8,}|\bshp(?:at|ca|ss|ua)_[A-Za-z0-9]+|\beh_live_[A-Za-z0-9_-]+|data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
/** Long enough for an error message or a URL, too short for a prompt, HTML or an image. */
export const MAX_STRING = 500;
const MAX_DEPTH = 4;

type Fields = Record<string, unknown>;

function redactString(value: string) {
  const clean = value.replace(SENSITIVE_VALUE, "[REDACTED]");
  return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…[+${clean.length - MAX_STRING}]` : clean;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[object]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  return redact(value as Fields, depth + 1);
}

function redact(fields: Fields, depth = 0): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(value, depth);
  }
  return out;
}

/** Exposed for tests: exactly what a log line carries after redaction. */
export const redactForTests = (fields: Fields) => redact(fields);

function write(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
