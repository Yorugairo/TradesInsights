import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { evidenceItems, sourceRecords, sourceRuns, sources } from "@otn/db";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { Logger } from "pino";
import type { ObjectStore } from "./object-store.js";
import { normalizedFingerprint } from "./runner.js";
import type { RawArtifact, RunContext, SourceAdapter } from "./types.js";

/**
 * D5 — reprocess a source's stored immutable artifacts through the current
 * adapter, WITHOUT re-fetching. The runner's content-hash skip means a parser
 * bug-fix does not heal already-stored records until their content changes;
 * replay re-derives `source_records.normalized_json` from the retained raw
 * bytes (spec §5: raw artifacts are immutable and never deleted, so they are a
 * correctness asset). Idempotent: replaying with an unchanged parser rewrites
 * nothing (the normalized fingerprint is identical).
 *
 * Immutability is preserved: raw_artifacts are only READ. Only the derived
 * `source_records` view is updated (the data dictionary states normalized_json
 * may be rewritten while the raw artifact remains forever). Evidence is
 * append-only — replay backfills evidence only for records that have none, so a
 * re-run never duplicates evidence rows.
 */
export interface ReplayResult {
  sourceRunId: string;
  artifactsReplayed: number;
  recordsReparsed: number;
  recordsChanged: number;
  recordsInserted: number;
  evidenceBackfilled: number;
  /** Records the current parser produced that fail schema validation (as the
   * runner does, these are rejected, not errors). */
  recordsRejected: number;
  /** Artifacts that threw during fetch/parse (a real replay failure). */
  errors: number;
}

export interface ReplayOptions {
  db: Db;
  adapter: SourceAdapter;
  objectStore: ObjectStore;
  logger: Logger;
  authorityGrade?: "A" | "B" | "C" | "D";
}

interface ArtifactRow {
  id: string;
  canonical_url: string;
  content_type: string;
  http_status: number | null;
  storage_key: string;
  retrieved_at: Date;
  source_published_at: Date | null;
  discovery_meta_json: Record<string, unknown> | null;
}

export async function replaySource(opts: ReplayOptions): Promise<ReplayResult> {
  const { db, adapter, objectStore, logger } = opts;
  const grade = opts.authorityGrade ?? "A";

  const [source] = await db.select().from(sources).where(eq(sources.key, adapter.key));
  if (!source) throw new Error(`source ${adapter.key} is not seeded`);

  const [run] = await db
    .insert(sourceRuns)
    .values({
      sourceId: source.id,
      status: "running",
      metricsJson: { replay: true, parserVersion: adapter.parserVersion },
    })
    .returning({ id: sourceRuns.id });
  if (!run) throw new Error("failed to create replay source_runs row");

  const log = logger.child({ sourceKey: adapter.key, sourceRunId: run.id, replay: true });
  const ctx: RunContext = {
    sourceKey: adapter.key,
    sourceRunId: run.id,
    traceId: run.id,
    logger: log,
    userAgent: "replay",
    fixturesDir: "",
    objectStore,
    checkpoint: null,
    setCheckpoint: () => {},
    backfill: null,
  };

  const result: ReplayResult = {
    sourceRunId: run.id,
    artifactsReplayed: 0,
    recordsReparsed: 0,
    recordsChanged: 0,
    recordsInserted: 0,
    evidenceBackfilled: 0,
    recordsRejected: 0,
    errors: 0,
  };

  const artifacts = (
    await db.execute(sql`
      SELECT id, canonical_url, content_type, http_status, storage_key,
        retrieved_at, source_published_at, discovery_meta_json
      FROM raw_artifacts WHERE source_id = ${source.id}
      ORDER BY retrieved_at ASC`)
  ).rows as unknown as ArtifactRow[];

  for (const art of artifacts) {
    try {
      const body = await objectStore.get(art.storage_key);
      const raw: RawArtifact = {
        discovered: {
          idempotencyKey: `${adapter.key}:replay:${art.id}`,
          canonicalUrl: art.canonical_url,
          parentUrl: null,
          expectedContentType: art.content_type,
          sourcePublishedAt: art.source_published_at
            ? new Date(art.source_published_at).toISOString()
            : null,
          ...(art.discovery_meta_json ? { meta: art.discovery_meta_json } : {}),
        },
        body,
        contentType: art.content_type,
        httpStatus: art.http_status,
        headers: {},
        retrievedAt: new Date(art.retrieved_at),
      };

      const parsed = await adapter.parse(raw, ctx);
      result.artifactsReplayed++;

      for (const p of parsed) {
        const validation = NormalizedSourceRecordSchema.safeParse(p.record);
        if (!validation.success || validation.data.sourceKey !== adapter.key) {
          result.recordsRejected++;
          continue;
        }
        const record = validation.data;
        result.recordsReparsed++;
        const fingerprint = normalizedFingerprint(record);

        const [existing] = await db
          .select({ id: sourceRecords.id, normalizedFingerprint: sourceRecords.normalizedFingerprint })
          .from(sourceRecords)
          .where(and(eq(sourceRecords.sourceId, source.id), eq(sourceRecords.externalId, record.externalId)));

        if (existing) {
          if (existing.normalizedFingerprint !== fingerprint) {
            // The parser fix changed the interpretation — rewrite the derived
            // view (raw artifact stays untouched).
            await db
              .update(sourceRecords)
              .set({
                rawFieldsJson: p.rawFields,
                normalizedJson: record,
                normalizedFingerprint: fingerprint,
              })
              .where(eq(sourceRecords.id, existing.id));
            result.recordsChanged++;
          }
          // Append-only evidence: backfill only when the record has none.
          if (record.evidence.length > 0) {
            const ev = await db.execute(
              sql`SELECT count(*) AS n FROM evidence_items WHERE source_record_id = ${existing.id}`,
            );
            if (Number((ev.rows[0] as { n: string | number }).n) === 0) {
              await db.insert(evidenceItems).values(
                record.evidence.map((e) => ({
                  sourceRecordId: existing.id,
                  rawArtifactId: art.id,
                  factPath: e.factPath,
                  evidenceText: e.text,
                  pageOrSection: e.pageOrSection,
                  sourceUrl: record.sourceUrl,
                  authorityGrade: grade,
                  parserVersion: adapter.parserVersion,
                })),
              );
              result.evidenceBackfilled += record.evidence.length;
            }
          }
        } else {
          // A record the old parser missed entirely.
          const [inserted] = await db
            .insert(sourceRecords)
            .values({
              sourceId: source.id,
              rawArtifactId: art.id,
              externalId: record.externalId,
              recordType: record.recordType,
              firstSeenAt: new Date(art.retrieved_at),
              lastSeenAt: new Date(art.retrieved_at),
              rawFieldsJson: p.rawFields,
              normalizedJson: record,
              normalizedFingerprint: fingerprint,
            })
            .returning({ id: sourceRecords.id });
          if (inserted && record.evidence.length > 0) {
            await db.insert(evidenceItems).values(
              record.evidence.map((e) => ({
                sourceRecordId: inserted.id,
                rawArtifactId: art.id,
                factPath: e.factPath,
                evidenceText: e.text,
                pageOrSection: e.pageOrSection,
                sourceUrl: record.sourceUrl,
                authorityGrade: grade,
                parserVersion: adapter.parserVersion,
              })),
            );
            result.evidenceBackfilled += record.evidence.length;
          }
          result.recordsInserted++;
        }
      }
    } catch (err) {
      result.errors++;
      log.error({ artifactId: art.id, err: err instanceof Error ? err.message : String(err) }, "replay artifact failed");
    }
  }

  await db
    .update(sourceRuns)
    .set({
      completedAt: new Date(),
      status: result.errors > 0 ? "completed_with_errors" : "succeeded",
      parsedCount: result.recordsReparsed,
      errorCount: result.errors,
      metricsJson: { replay: true, parserVersion: adapter.parserVersion, ...result },
    })
    .where(eq(sourceRuns.id, run.id));

  log.info({ ...result }, "replay complete");
  return result;
}
