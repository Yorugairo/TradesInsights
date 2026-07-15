import { randomUUID, createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  evidenceItems,
  rawArtifacts,
  sourceRecords,
  sourceRuns,
  sources,
} from "@otn/db";
import { NormalizedSourceRecordSchema } from "@otn/domain";
import type { Logger } from "pino";
import type { ObjectStore } from "./object-store.js";
import type {
  BackfillWindow,
  RunContext,
  RunMetrics,
  SourceAdapter,
} from "./types.js";

export interface DeadLetterEntry {
  idempotencyKey: string;
  canonicalUrl: string;
  stage: "fetch" | "parse" | "persist";
  error: string;
}

export interface RunResult {
  sourceRunId: string;
  status: "succeeded" | "completed_with_errors" | "failed";
  metrics: RunMetrics;
  deadLetters: DeadLetterEntry[];
}

export interface RunSourceOptions {
  db: Db;
  adapter: SourceAdapter;
  objectStore: ObjectStore;
  logger: Logger;
  fixturesDir: string;
  userAgent: string;
  /** Default A: adapters only target official records; override for B-grade sources. */
  authorityGrade?: "A" | "B" | "C" | "D";
  /** Shadow mode runs a disabled source without enabling it. */
  allowDisabled?: boolean;
  backfill?: BackfillWindow;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

export function normalizedFingerprint(record: unknown): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

function schemaFingerprint(rawFields: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.keys(rawFields).sort()))
    .digest("hex");
}

/**
 * Orchestrates one source run: discover → fetch → store immutable artifact →
 * parse → upsert normalized records + evidence. Idempotent: rerunning against
 * unchanged content stores nothing new and creates no duplicate records.
 */
export async function runSource(opts: RunSourceOptions): Promise<RunResult> {
  const { db, adapter, objectStore, fixturesDir, userAgent } = opts;
  const grade = opts.authorityGrade ?? "A";

  const [source] = await db
    .select()
    .from(sources)
    .where(eq(sources.key, adapter.key));
  if (!source) throw new Error(`source ${adapter.key} is not seeded in the database`);
  if (!source.enabled && !opts.allowDisabled) {
    throw new Error(`source ${adapter.key} is disabled — pass allowDisabled for shadow mode`);
  }

  const traceId = randomUUID();
  const [run] = await db
    .insert(sourceRuns)
    .values({ sourceId: source.id, status: "running" })
    .returning({ id: sourceRuns.id });
  if (!run) throw new Error("failed to create source_runs row");

  const logger = opts.logger.child({
    sourceKey: adapter.key,
    sourceRunId: run.id,
    traceId,
  });

  const ctx: RunContext = {
    sourceKey: adapter.key,
    sourceRunId: run.id,
    traceId,
    logger,
    userAgent,
    fixturesDir,
    objectStore,
    checkpoint: null,
    backfill: opts.backfill ?? null,
  };

  const metrics: RunMetrics = {
    discovered: 0,
    fetched: 0,
    unchanged: 0,
    parsed: 0,
    rejected: 0,
    duplicate: 0,
    errors: 0,
  };
  const deadLetters: DeadLetterEntry[] = [];
  let runSchemaFingerprint: string | null = null;

  try {
    const items = await adapter.discover(ctx);
    metrics.discovered = items.length;
    logger.info({ discovered: items.length }, "discovery complete");

    for (const item of items) {
      let stage: DeadLetterEntry["stage"] = "fetch";
      try {
        const raw = await adapter.fetch(item, ctx);
        metrics.fetched++;

        // Immutable storage BEFORE parsing (spec §5).
        const put = await objectStore.putImmutable(
          adapter.key,
          raw.body,
          raw.contentType,
        );

        const [existingArtifact] = await db
          .select({ id: rawArtifacts.id })
          .from(rawArtifacts)
          .where(
            and(
              eq(rawArtifacts.sourceId, source.id),
              eq(rawArtifacts.canonicalUrl, item.canonicalUrl),
              eq(rawArtifacts.sha256, put.sha256),
            ),
          );

        if (existingArtifact) {
          // Same content seen before: nothing to parse, refresh last-seen.
          metrics.unchanged++;
          await db
            .update(sourceRecords)
            .set({ lastSeenAt: raw.retrievedAt })
            .where(eq(sourceRecords.rawArtifactId, existingArtifact.id));
          continue;
        }

        const [artifact] = await db
          .insert(rawArtifacts)
          .values({
            sourceId: source.id,
            sourceRunId: run.id,
            canonicalUrl: item.canonicalUrl,
            retrievedAt: raw.retrievedAt,
            sourcePublishedAt: item.sourcePublishedAt
              ? new Date(item.sourcePublishedAt)
              : null,
            contentType: raw.contentType,
            httpStatus: raw.httpStatus,
            storageKey: put.storageKey,
            sha256: put.sha256,
            byteSize: put.byteSize,
            headersJson: raw.headers,
            parserVersion: adapter.parserVersion,
          })
          .returning({ id: rawArtifacts.id });
        if (!artifact) throw new Error("failed to insert raw_artifacts row");

        stage = "parse";
        const parsed = await adapter.parse(raw, ctx);

        stage = "persist";
        for (const p of parsed) {
          const validation = NormalizedSourceRecordSchema.safeParse(p.record);
          if (!validation.success) {
            metrics.rejected++;
            logger.warn(
              { externalId: p.record?.externalId, issues: validation.error.issues },
              "record rejected by NormalizedSourceRecord schema",
            );
            continue;
          }
          const record = validation.data;
          if (record.sourceKey !== adapter.key) {
            metrics.rejected++;
            logger.warn(
              { externalId: record.externalId, recordSourceKey: record.sourceKey },
              "record rejected: sourceKey mismatch",
            );
            continue;
          }
          runSchemaFingerprint ??= schemaFingerprint(p.rawFields);
          const fingerprint = normalizedFingerprint(record);

          const [existing] = await db
            .select({
              id: sourceRecords.id,
              normalizedFingerprint: sourceRecords.normalizedFingerprint,
            })
            .from(sourceRecords)
            .where(
              and(
                eq(sourceRecords.sourceId, source.id),
                eq(sourceRecords.externalId, record.externalId),
              ),
            );

          if (existing && existing.normalizedFingerprint === fingerprint) {
            metrics.duplicate++;
            await db
              .update(sourceRecords)
              .set({ lastSeenAt: raw.retrievedAt })
              .where(eq(sourceRecords.id, existing.id));
            continue;
          }

          let recordId: string;
          if (existing) {
            await db
              .update(sourceRecords)
              .set({
                rawArtifactId: artifact.id,
                lastSeenAt: raw.retrievedAt,
                sourceUpdatedAt: record.sourceUpdatedAt
                  ? new Date(record.sourceUpdatedAt)
                  : null,
                rawFieldsJson: p.rawFields,
                normalizedJson: record,
                normalizedFingerprint: fingerprint,
              })
              .where(eq(sourceRecords.id, existing.id));
            recordId = existing.id;
          } else {
            const [inserted] = await db
              .insert(sourceRecords)
              .values({
                sourceId: source.id,
                rawArtifactId: artifact.id,
                externalId: record.externalId,
                recordType: record.recordType,
                firstSeenAt: raw.retrievedAt,
                lastSeenAt: raw.retrievedAt,
                sourceUpdatedAt: record.sourceUpdatedAt
                  ? new Date(record.sourceUpdatedAt)
                  : null,
                rawFieldsJson: p.rawFields,
                normalizedJson: record,
                normalizedFingerprint: fingerprint,
              })
              .returning({ id: sourceRecords.id });
            if (!inserted) throw new Error("failed to insert source_records row");
            recordId = inserted.id;
          }

          if (record.evidence.length > 0) {
            await db.insert(evidenceItems).values(
              record.evidence.map((e) => ({
                sourceRecordId: recordId,
                rawArtifactId: artifact.id,
                factPath: e.factPath,
                evidenceText: e.text,
                pageOrSection: e.pageOrSection,
                sourceUrl: record.sourceUrl,
                authorityGrade: grade,
                parserVersion: adapter.parserVersion,
              })),
            );
          }
          metrics.parsed++;
        }
      } catch (err) {
        metrics.errors++;
        const entry: DeadLetterEntry = {
          idempotencyKey: item.idempotencyKey,
          canonicalUrl: item.canonicalUrl,
          stage,
          error: err instanceof Error ? err.message : String(err),
        };
        deadLetters.push(entry);
        logger.error(entry, "item failed");
      }
    }

    const status = metrics.errors > 0 ? "completed_with_errors" : "succeeded";
    await db
      .update(sourceRuns)
      .set({
        completedAt: new Date(),
        status,
        discoveredCount: metrics.discovered,
        fetchedCount: metrics.fetched,
        unchangedCount: metrics.unchanged,
        parsedCount: metrics.parsed,
        rejectedCount: metrics.rejected,
        duplicateCount: metrics.duplicate,
        errorCount: metrics.errors,
        schemaFingerprint: runSchemaFingerprint,
        metricsJson: { ...metrics, deadLetters },
      })
      .where(eq(sourceRuns.id, run.id));

    logger.info({ ...metrics, status }, "source run complete");
    return { sourceRunId: run.id, status, metrics, deadLetters };
  } catch (err) {
    metrics.errors++;
    await db
      .update(sourceRuns)
      .set({
        completedAt: new Date(),
        status: "failed",
        discoveredCount: metrics.discovered,
        fetchedCount: metrics.fetched,
        errorCount: metrics.errors,
        metricsJson: {
          ...metrics,
          deadLetters,
          fatal: err instanceof Error ? err.message : String(err),
        },
      })
      .where(eq(sourceRuns.id, run.id));
    logger.error({ err }, "source run failed");
    return { sourceRunId: run.id, status: "failed", metrics, deadLetters };
  }
}
