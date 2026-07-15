import type { NormalizedSourceRecord } from "@otn/domain";
import type { Logger } from "pino";
import type { ObjectStore } from "./object-store.js";

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
  record: NormalizedSourceRecord;
  rawFields: Record<string, unknown>;
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
  parse(raw: RawArtifact, ctx: RunContext): Promise<ParsedSourceRecord[]>;
}

export interface RunMetrics {
  discovered: number;
  fetched: number;
  unchanged: number;
  parsed: number;
  rejected: number;
  duplicate: number;
  errors: number;
}
