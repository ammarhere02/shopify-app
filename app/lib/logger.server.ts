/**
 * Minimal structured (JSON) logger. One line per event, easy to search and parse.
 * Sensitive keys are redacted so tokens/secrets can never leak into logs.
 */
const SENSITIVE = /token|secret|authorization|password|api[_-]?key|cookie/i;

type Fields = Record<string, unknown>;

function redact(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SENSITIVE.test(key) ? "[REDACTED]" : value;
  }
  return out;
}

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
