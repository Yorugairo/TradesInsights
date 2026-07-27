import { createHash } from "node:crypto";

/**
 * Content fingerprinting for normalized records, extracted from `runner.ts` so
 * the solicitation persist path can share it without importing the runner back
 * (which would be circular: runner -> persist-solicitation -> runner).
 *
 * `runner.ts` re-exports `normalizedFingerprint` so existing importers are
 * unaffected.
 */

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

/** Stable across key order, so a reordered parse is not a false change. */
export function normalizedFingerprint(record: unknown): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

/** Hash of the raw field NAMES — the D3 schema-drift canary. */
export function schemaFingerprint(rawFields: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.keys(rawFields).sort()))
    .digest("hex");
}
