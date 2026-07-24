/**
 * Link the evidence that already exists to the opportunities it supports.
 *
 * `evidence_items` holds 88,407 rows and `opportunity_evidence` has never held
 * one, so the table the publication gate reads to answer "what sources this
 * claim?" is empty. Nothing here extracts or infers anything: it is a
 * deterministic walk of
 * `opportunities.project_id` -> `record_resolutions (status='active')` ->
 * `evidence_items`, with `classifyClaim` deciding what each row supports.
 *
 * Measured live 2026-07-24: every one of the 9,128 opportunities has reachable
 * evidence (75,708 distinct pairs, median 5 per opportunity, p95 20). 44,353 of
 * the 88,407 evidence rows are reachable at all — the rest belong to projects no
 * account is chasing, which is expected, not a defect.
 *
 * THE CAP NEEDS A TOTAL ORDER, OR IT IS NOT A CAP. One opportunity reaches 1,047
 * evidence rows. Capping to the "first 50" only works if reruns choose the SAME
 * 50 — otherwise each run contributes a different subset, `ON CONFLICT DO
 * NOTHING` accepts every one of them, and the table converges on the full 1,047
 * with the cap silently defeated. The sort below is therefore total and stable,
 * ending in the evidence id.
 *
 * PREVIEW MEANS WHAT APPLY MEANS. The dry run subtracts rows that are already
 * linked, exactly as the apply path does, so "would link N" and "linked N" are
 * the same number and a second run of either reports zero.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import {
  classifyClaim,
  isKnownFactPath,
  type ClaimRefusal,
  type ClaimType,
} from "./opportunity-evidence.js";

/**
 * Default ceiling on rows per opportunity. Measured: p95 is 20 and only 86 of
 * 9,128 opportunities (0.9%) exceed 50, so this bounds the one noisy project
 * without touching the shape of the other 99%.
 */
export const DEFAULT_MAX_PER_OPPORTUNITY = 50;

/** Opportunities per read/write batch. Keeps one pool connection busy briefly. */
const OPPORTUNITY_BATCH = 250;

/** Rows per INSERT. */
const INSERT_BATCH = 1_000;

/**
 * Which claims to keep when the cap bites, most gate-critical first.
 *
 * The publication gate requires project identity, geography, stage, and event
 * date before anything may be delivered, so those outrank role and value, and
 * everything outranks `other`. Without this the cap would drop gate-critical
 * evidence in favour of whichever row sorted first by accident.
 */
const CLAIM_PRIORITY: Readonly<Record<ClaimType, number>> = {
  identity: 0,
  stage: 1,
  event_date: 2,
  geography: 3,
  organization_role: 4,
  value: 5,
  other: 6,
};

/** Stable key for a linked pair. */
export function evidenceKey(r: { opportunityId: string; evidenceItemId: string }): string {
  return `${r.opportunityId}|${r.evidenceItemId}`;
}

/**
 * Decide what to write for ONE opportunity.
 *
 * ORDER OF OPERATIONS IS THE WHOLE POINT. The cap ranks the FULL candidate set
 * and only then are already-linked rows subtracted. Doing it the other way round
 * — filtering first, capping the remainder — makes every rerun cap a shrinking
 * leftover and insert a fresh `maxPerOpportunity` rows, so an over-cap
 * opportunity creeps towards its uncapped total one run at a time. That is not
 * hypothetical: it shipped, and the second apply added 2,792 rows before this
 * function existed to make the ordering explicit and testable.
 */
export function planOpportunityWrites(
  candidates: readonly CandidateRow[],
  alreadyLinkedKeys: ReadonlySet<string>,
  maxPerOpportunity: number,
): { toWrite: CandidateRow[]; dropped: number; alreadyLinked: number } {
  const { kept, dropped } = selectCappedEvidence(candidates, maxPerOpportunity);
  const toWrite: CandidateRow[] = [];
  let alreadyLinked = 0;
  for (const c of kept) {
    if (alreadyLinkedKeys.has(evidenceKey(c))) alreadyLinked += 1;
    else toWrite.push(c);
  }
  return { toWrite, dropped, alreadyLinked };
}

export interface LinkEvidenceOptions {
  /** Compute everything, write nothing. */
  dryRun?: boolean | undefined;
  /** Cap opportunities processed (for a fast smoke run). */
  limit?: number | undefined;
  /** Scope to one account profile. */
  accountProfileId?: string | undefined;
  maxPerOpportunity?: number | undefined;
  logger?:
    | { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void }
    | undefined;
}

export interface LinkEvidenceSummary {
  dryRun: boolean;
  opportunitiesScanned: number;
  opportunitiesWithEvidence: number;
  pairsConsidered: number;
  alreadyLinked: number;
  linked: number;
  cappedDropped: number;
  opportunitiesOverCap: number;
  refusedByReason: Record<ClaimRefusal, number>;
  byClaimType: Record<ClaimType, number>;
  /**
   * Fact paths absent from the claim vocabulary. A source schema change shows up
   * here first; it must never hide inside the `other` bucket.
   */
  unknownFactPaths: string[];
}

interface EvidenceRow {
  opportunityId: string;
  evidenceItemId: string;
  factPath: string;
  authorityGrade: string;
}

export interface CandidateRow {
  opportunityId: string;
  evidenceItemId: string;
  claimType: ClaimType;
  confirmed: boolean;
  confidence: number;
}

function emptyClaimCounts(): Record<ClaimType, number> {
  return {
    identity: 0,
    stage: 0,
    event_date: 0,
    geography: 0,
    value: 0,
    organization_role: 0,
    other: 0,
  };
}

/**
 * Total, stable order for the cap: strongest authority first, then the claims
 * the publication gate needs, then the evidence id so the choice is identical on
 * every run.
 */
export function compareCandidates(a: CandidateRow, b: CandidateRow): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const pa = CLAIM_PRIORITY[a.claimType];
  const pb = CLAIM_PRIORITY[b.claimType];
  if (pa !== pb) return pa - pb;
  return a.evidenceItemId.localeCompare(b.evidenceItemId);
}

/**
 * Apply the cap to one opportunity's candidates.
 *
 * Pure and exported so the property that actually matters — that the SAME rows
 * survive regardless of the order the database returned them in — can be tested
 * without a connection. If this were order-sensitive, reruns would each add a
 * different subset and the cap would leak.
 */
export function selectCappedEvidence(
  candidates: readonly CandidateRow[],
  maxPerOpportunity: number,
): { kept: CandidateRow[]; dropped: number } {
  const sorted = [...candidates].sort(compareCandidates);
  return {
    kept: sorted.slice(0, maxPerOpportunity),
    dropped: Math.max(0, sorted.length - maxPerOpportunity),
  };
}

async function fetchOpportunityIds(
  db: Db,
  opts: { accountProfileId?: string | undefined; limit?: number | undefined },
): Promise<string[]> {
  const where = opts.accountProfileId
    ? sql`WHERE account_profile_id = ${opts.accountProfileId}`
    : sql``;
  const lim = opts.limit ? sql`LIMIT ${opts.limit}` : sql``;
  // Ordered by id so a --limit run is reproducible rather than sampling
  // whatever the planner happened to return.
  const res = await db.execute(sql`
    SELECT id FROM opportunities ${where} ORDER BY id ${lim}`);
  return (res.rows as Record<string, unknown>[]).map((r) => String(r["id"]));
}

/**
 * Bind ids as query parameters, never as interpolated text. These uuids come
 * from our own database, but a query built by string concatenation is one
 * refactor away from taking a value that did not.
 */
function uuidList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

async function fetchEvidenceFor(db: Db, opportunityIds: string[]): Promise<EvidenceRow[]> {
  // DISTINCT because two active resolutions of the same source record onto the
  // same project would otherwise yield the identical pair twice. Measured zero
  // today; cheap insurance against a resolver change making it non-zero.
  const res = await db.execute(sql`
    SELECT DISTINCT o.id AS opportunity_id, e.id AS evidence_item_id,
           e.fact_path, e.authority_grade
      FROM opportunities o
      JOIN record_resolutions rr
        ON rr.project_id = o.project_id AND rr.status = 'active'
      JOIN evidence_items e
        ON e.source_record_id = rr.source_record_id
     WHERE o.id IN (${uuidList(opportunityIds)})`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    opportunityId: String(r["opportunity_id"]),
    evidenceItemId: String(r["evidence_item_id"]),
    factPath: String(r["fact_path"]),
    authorityGrade: String(r["authority_grade"]),
  }));
}

async function fetchExistingPairs(db: Db, opportunityIds: string[]): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT opportunity_id, evidence_item_id
      FROM opportunity_evidence
     WHERE opportunity_id IN (${uuidList(opportunityIds)})`);
  return new Set(
    (res.rows as Record<string, unknown>[]).map(
      (r) => `${String(r["opportunity_id"])}|${String(r["evidence_item_id"])}`,
    ),
  );
}

async function insertRows(db: Db, rows: CandidateRow[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    const values = sql.join(
      chunk.map(
        (r) =>
          sql`(${r.opportunityId}::uuid, ${r.evidenceItemId}::uuid, ${r.claimType}, ${r.confirmed}, ${r.confidence})`,
      ),
      sql`, `,
    );
    const res = await db.execute(sql`
      INSERT INTO opportunity_evidence
        (opportunity_id, evidence_item_id, claim_type, confirmed, confidence)
      VALUES ${values}
      ON CONFLICT (opportunity_id, evidence_item_id) DO NOTHING`);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Walk every opportunity's evidence and link it.
 *
 * Idempotent: a second run links nothing, because already-linked pairs are
 * subtracted before the write and the unique index backstops the insert.
 */
export async function linkOpportunityEvidence(
  db: Db,
  opts: LinkEvidenceOptions = {},
): Promise<LinkEvidenceSummary> {
  const dryRun = opts.dryRun ?? true;
  const maxPer = opts.maxPerOpportunity ?? DEFAULT_MAX_PER_OPPORTUNITY;
  const summary: LinkEvidenceSummary = {
    dryRun,
    opportunitiesScanned: 0,
    opportunitiesWithEvidence: 0,
    pairsConsidered: 0,
    alreadyLinked: 0,
    linked: 0,
    cappedDropped: 0,
    opportunitiesOverCap: 0,
    refusedByReason: { discovery_only_grade: 0, unknown_grade: 0 },
    byClaimType: emptyClaimCounts(),
    unknownFactPaths: [],
  };
  const unknownPaths = new Set<string>();

  const opportunityIds = await fetchOpportunityIds(db, {
    accountProfileId: opts.accountProfileId,
    limit: opts.limit,
  });
  summary.opportunitiesScanned = opportunityIds.length;
  if (opportunityIds.length === 0) return summary;

  for (let i = 0; i < opportunityIds.length; i += OPPORTUNITY_BATCH) {
    const batch = opportunityIds.slice(i, i + OPPORTUNITY_BATCH);
    const [evidence, existing] = await Promise.all([
      fetchEvidenceFor(db, batch),
      fetchExistingPairs(db, batch),
    ]);

    const byOpportunity = new Map<string, CandidateRow[]>();
    for (const row of evidence) {
      summary.pairsConsidered += 1;
      if (!isKnownFactPath(row.factPath)) unknownPaths.add(row.factPath.trim());

      const verdict = classifyClaim({
        factPath: row.factPath,
        authorityGrade: row.authorityGrade,
      });
      if (!verdict.linkable) {
        summary.refusedByReason[verdict.reason] += 1;
        continue;
      }
      // NOT filtered against `existing` here. The cap must rank the FULL
      // candidate set; subtracting already-linked rows first would make each
      // rerun cap a shrinking remainder and insert a fresh 50 every time.
      const list = byOpportunity.get(row.opportunityId);
      const candidate: CandidateRow = {
        opportunityId: row.opportunityId,
        evidenceItemId: row.evidenceItemId,
        claimType: verdict.claimType,
        confirmed: verdict.confirmed,
        confidence: verdict.confidence,
      };
      if (list) list.push(candidate);
      else byOpportunity.set(row.opportunityId, [candidate]);
    }

    const toWrite: CandidateRow[] = [];
    for (const [, candidates] of byOpportunity) {
      summary.opportunitiesWithEvidence += 1;
      const plan = planOpportunityWrites(candidates, existing, maxPer);
      if (plan.dropped > 0) {
        summary.opportunitiesOverCap += 1;
        summary.cappedDropped += plan.dropped;
      }
      summary.alreadyLinked += plan.alreadyLinked;
      for (const c of plan.toWrite) {
        summary.byClaimType[c.claimType] += 1;
        toWrite.push(c);
      }
    }

    if (dryRun) {
      summary.linked += toWrite.length;
    } else {
      summary.linked += await insertRows(db, toWrite);
    }
  }

  summary.unknownFactPaths = [...unknownPaths].sort();
  if (summary.unknownFactPaths.length > 0) {
    opts.logger?.warn(
      { unknownFactPaths: summary.unknownFactPaths },
      "fact paths outside the claim vocabulary — a source schema may have changed",
    );
  }
  return summary;
}
