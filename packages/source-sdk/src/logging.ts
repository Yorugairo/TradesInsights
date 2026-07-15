import { pino, type Logger } from "pino";

const REDACT_PATHS = [
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.password",
];

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: bindings,
  });
}

/** Strips known-sensitive query params before a URL enters logs or storage keys. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of ["token", "apikey", "api_key", "key", "auth", "signature", "sig"]) {
      if (u.searchParams.has(p)) u.searchParams.set(p, "[redacted]");
    }
    return u.toString();
  } catch {
    return url;
  }
}
