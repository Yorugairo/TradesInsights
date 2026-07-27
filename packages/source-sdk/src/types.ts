import type { NormalizedSolicitationRecord, NormalizedSourceRecord } from "@otn/domain";
import type { Logger } from "pino";
import type { ObjectStore } from "./object-store.js";
import type { InvariantViolation } from "./invariants.js";

/** An artifact the adapter found during discovery, not yet fetched. */
export interface DiscoveredArtifact {
  /** Deterministic idempotency key — stable across reruns for the same artifact. */
  idempotencyKey: string;
  canonicalUrl: string;
  /** Landing page the artifact was discovered from. */
  parentUrl: string | null;
  expectedContentType: string | null;
  sourcePublishedAt: string | null;
  /** Discovery-time context the parser needs (e.g. list-API modified time). */
  meta?: Record<string, unknown>;
}

/** A fetched artifact: raw bytes plus retrieval metadata. Stored before parsing. */
export interface RawArtifact {
  discovered: DiscoveredArtifact;
  body: Buffer;
  contentType: string;
  httpStatus: number | null;
  headers: Record<string, string>;
  retrievedAt: Date;
}

/** Parser output: the normalized record plus the raw fields it came from. */
export interface ParsedSourceRecord {
  /**
   * Optional and defaulted so all 36 pre-existing adapters, which construct
   * `{ record, rawFields }` and nothing else, keep compiling untouched.
   */
  kind?: "permit";
  record: NormalizedSourceRecord;
  rawFields: Record<string, unknown>;
}

/** Parser output for the second record class (bids). See NormalizedSolicitationRecord. */
export interface ParsedSolicitationRecord {
  kind: "solicitation";
  record: NormalizedSolicitationRecord;
  rawFields: Record<string, unknown>;
}

/**
 * What an adapter may emit. The union lives HERE, at the adapter boundary,
 * rather than inside `ParsedSourceRecord` itself — and that is deliberate.
 *
 * Rewriting `ParsedSourceRecord` into the union directly was tried first and
 * fails the plan's own falsification test: existing adapters read
 * permit-specific fields off `p.record` inside their `checkInvariants`
 * (`valuationUsd` in centralia, `units`/`applicationDate` in king,
 * `organizations` in pierce_pals), and every one of those becomes a type error
 * the moment `p.record` can also be a solicitation. Ten-plus adapter edits to
 * land a type change is the signal the shape is wrong.
 *
 * Keeping `ParsedSourceRecord` as the permit shape and widening only the
 * SourceAdapter method signatures costs nothing: a `parse()` declared as
 * returning `ParsedSourceRecord[]` is assignable to one returning
 * `ParsedRecord[]` (covariant return), and a `checkInvariants` declared with
 * the narrower parameter still satisfies the interface (TypeScript method
 * parameters are bivariant — `strictFunctionTypes` exempts method syntax).
 * So existing adapters keep their NARROW types internally and need no edits.
 */
export type ParsedRecord = ParsedSourceRecord | ParsedSolicitationRecord;

/** Narrowing helper — the one place the discriminant is interpreted. */
export function isSolicitation(p: ParsedRecord): p is ParsedSolicitationRecord {
  return p.kind === "solicitation";
}

export interface BackfillWindow {
  from: string;
  to: string;
}

export interface RunContext {
  sourceKey: string;
  sourceRunId: string;
  traceId: string;
  logger: Logger;
  userAgent: string;
  fixturesDir: string;
  objectStore: ObjectStore;
  /** Checkpoint from the previous completed run (pagination high-water mark etc.). */
  checkpoint: Record<string, unknown> | null;
  /**
   * Persist a checkpoint for the next run. Written to source_runs.checkpoint_json
   * when the run completes (succeeded or completed_with_errors) — never on failure,
   * so a failed run re-covers the same window.
   */
  setCheckpoint(checkpoint: Record<string, unknown>): void;
  backfill: BackfillWindow | null;
}

/** Spec §5 — every source implements exactly this contract. */
export interface SourceAdapter {
  readonly key: string;
  readonly parserVersion: string;
  discover(ctx: RunContext): Promise<DiscoveredArtifact[]>;
  fetch(item: DiscoveredArtifact, ctx: RunContext): Promise<RawArtifact>;
  parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedRecord[]>;
  /**
   * D1 — optional per-artifact self-reconciliation. Given the fetched artifact
   * and the records the parser produced from it, return any invariant
   * violations (printed-total mismatch, out-of-range value, column-shape
   * break). The runner records violations into the run and
   * `evaluateSourceHealth` turns the source red when the latest run has any —
   * so a silent positional mis-parse cannot look healthy. Return [] when the
   * parse reconciles.
   */
  checkInvariants?(
    raw: RawArtifact,
    parsed: ParsedRecord[],
    ctx: RunContext,
  ): InvariantViolation[] | Promise<InvariantViolation[]>;
}

export interface RunMetrics {
  discovered: number;
  fetched: number;
  unchanged: number;
  parsed: number;
  rejected: number;
  duplicate: number;
  errors: number;
  /** D1 — count of parser self-reconciliation failures across all artifacts. */
  invariantViolations: number;
}
