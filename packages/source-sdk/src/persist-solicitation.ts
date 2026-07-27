import { and, eq } from "drizzle-orm";
import type { Db } from "@otn/db";
import { solicitations } from "@otn/db";
import { NormalizedSolicitationRecordSchema } from "@otn/domain";
import type { Logger } from "pino";
import { normalizedFingerprint } from "./fingerprint.js";
import type { ParsedSolicitationRecord } from "./types.js";

/**
 * The persist branch for the SECOND record class. One function, called from the
 * same loop that persists permits, writing `insights.solicitations` instead of
 * `source_records`.
 *
 * It returns the outcome rather than mutating counters, so the runner keeps
 * ownership of `RunMetrics`. That is the point: `parsed_count` and
 * `rejected_count` MUST move for solicitations exactly as they do for permits,
 * or health checks silently exempt the whole class. The 2026-07-27 fleet audit
 * found `rejected_count` sitting at 0 across all 36 sources and ~27,000
 * records; adding a second class that skips the counters would double a blind
 * spot that already exists.
 */
export type SolicitationOutcome = "rejected" | "duplicate" | "parsed";

export interface PersistSolicitationOptions {
  db: Db;
  /** `sources.id`, already resolved by the runner. */
  sourceId: string;
  /** The adapter key, for the sourceKey-mismatch guard. */
  sourceKey: string;
  rawArtifactId: string;
  /** Fetch time — becomes first/last seen and `observed_at`. */
  retrievedAt: Date;
  parsed: ParsedSolicitationRecord;
  logger: Logger;
}

export async function persistSolicitation(
  opts: PersistSolicitationOptions,
): Promise<SolicitationOutcome> {
  const { db, sourceId, sourceKey, rawArtifactId, retrievedAt, parsed, logger } = opts;

  const validation = NormalizedSolicitationRecordSchema.safeParse(parsed.record);
  if (!validation.success) {
    logger.warn(
      {
        externalId: (parsed.record as { externalId?: string } | null)?.externalId,
        issues: validation.error.issues,
      },
      "record rejected by NormalizedSolicitationRecord schema",
    );
    return "rejected";
  }
  const record = validation.data;

  // Same guard the permit path applies: an adapter that emits another source's
  // key would write rows attributed to a source that never fetched them.
  if (record.sourceKey !== sourceKey) {
    logger.warn(
      { externalId: record.externalId, recordSourceKey: record.sourceKey },
      "solicitation rejected: sourceKey mismatch",
    );
    return "rejected";
  }

  const fingerprint = normalizedFingerprint(record);

  const [existing] = await db
    .select({
      id: solicitations.id,
      normalizedFingerprint: solicitations.normalizedFingerprint,
    })
    .from(solicitations)
    .where(
      and(
        eq(solicitations.sourceId, sourceId),
        eq(solicitations.externalId, record.externalId),
      ),
    );

  // Unchanged content: touch last-seen and stop. Re-running a source must not
  // duplicate, and an unamended bid seen again is not new information.
  if (existing && existing.normalizedFingerprint === fingerprint) {
    await db
      .update(solicitations)
      .set({ lastSeenAt: retrievedAt })
      .where(eq(solicitations.id, existing.id));
    return "duplicate";
  }

  const columns = {
    rawArtifactId,
    solicitationNumber: record.solicitationNumber,
    title: record.title,
    description: record.description,
    procuringAgency: record.procuringAgency,
    primeContractor: record.primeContractor,
    documentType: record.documentType,
    bidDueAt: record.bidDueAt ? new Date(record.bidDueAt) : null,
    issuedAt: record.issuedAt ? new Date(record.issuedAt) : null,
    status: record.status,
    county: record.county,
    city: record.city,
    scopeRaw: record.scopeRaw,
    tradeTags: record.tradeTags,
    sourceUrl: record.sourceUrl,
    organizationsJson: record.organizations,
    evidenceJson: record.evidence,
    rawFieldsJson: parsed.rawFields,
    normalizedJson: record,
    normalizedFingerprint: fingerprint,
    lastSeenAt: retrievedAt,
    observedAt: retrievedAt,
  };

  if (existing) {
    // An AMENDMENT — the deadline moved, or the scope changed. Same
    // solicitation, updated in place. `project_id` is deliberately absent from
    // the update: it is resolution-time state and a re-parse must not clear a
    // link the resolver established.
    await db.update(solicitations).set(columns).where(eq(solicitations.id, existing.id));
  } else {
    await db
      .insert(solicitations)
      .values({ sourceId, externalId: record.externalId, firstSeenAt: retrievedAt, ...columns });
  }

  return "parsed";
}
