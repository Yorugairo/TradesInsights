import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * S5 (strengthening addendum §9) — trust & delivery controls. Suppression is
 * applied BEFORE delivery assembly; corrections are append-only (history is
 * never mutated); urgent alerts are restricted to a whitelist of five
 * categories — everything else belongs in the weekly digest.
 */

/** The only categories permitted to fire an urgent (out-of-digest) alert (§9). */
export const URGENT_ALERT_CATEGORIES = [
  "confirmed_bid_deadline_or_change",
  "newly_named_gc_on_strong_fit",
  "material_stage_change_affecting_timing",
  "strong_fit_authorized_invitation",
  "exceptional_score_current_evidence",
] as const;
export type UrgentAlertCategory = (typeof URGENT_ALERT_CATEGORIES)[number];

export function isUrgentAllowed(category: string): category is UrgentAlertCategory {
  return (URGENT_ALERT_CATEGORIES as readonly string[]).includes(category);
}

export async function addSuppression(
  db: Db,
  input: {
    accountProfileId: string;
    targetType: "project" | "organization";
    targetId: string;
    reason?: string | null;
    expiresAt?: string | null;
    createdBy?: string | null;
  },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO account_suppressions (account_profile_id, target_type, target_id, reason, expires_at, created_by)
    VALUES (${input.accountProfileId}, ${input.targetType}, ${input.targetId}, ${input.reason ?? null},
      ${input.expiresAt ?? null}, ${input.createdBy ?? null})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

export async function removeSuppression(db: Db, accountProfileId: string, id: string): Promise<boolean> {
  const res = await db.execute(sql`
    DELETE FROM account_suppressions WHERE id = ${id} AND account_profile_id = ${accountProfileId} RETURNING id`);
  return res.rows.length > 0;
}

/**
 * All project IDs an account has suppressed — directly, or transitively through
 * a suppressed organization that holds a role on the project. Digest assembly
 * filters candidates against this set BEFORE building any item.
 */
export async function suppressedProjectIds(db: Db, accountProfileId: string): Promise<Set<string>> {
  const res = await db.execute(sql`
    SELECT target_id AS project_id FROM account_suppressions
      WHERE account_profile_id = ${accountProfileId} AND target_type = 'project'
        AND (expires_at IS NULL OR expires_at > now())
    UNION
    SELECT pr.project_id FROM account_suppressions s
      JOIN project_roles pr ON pr.organization_id = s.target_id
      WHERE s.account_profile_id = ${accountProfileId} AND s.target_type = 'organization'
        AND (s.expires_at IS NULL OR s.expires_at > now())`);
  return new Set((res.rows as { project_id: string }[]).map((r) => r.project_id));
}

/** Append a correction. History is immutable: a correction is a new row, never
 * an in-place edit of evidence or a prior correction. */
export async function addCorrection(
  db: Db,
  input: {
    evidenceItemId?: string | null;
    opportunityId?: string | null;
    correctionType: string;
    priorValue?: unknown;
    correctedValue?: unknown;
    reason?: string | null;
    sourceRecordId?: string | null;
    createdBy?: string | null;
  },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO claim_corrections
      (evidence_item_id, opportunity_id, correction_type, prior_value_json, corrected_value_json, reason, source_record_id, created_by)
    VALUES (${input.evidenceItemId ?? null}, ${input.opportunityId ?? null}, ${input.correctionType},
      ${input.priorValue === undefined ? null : JSON.stringify(input.priorValue)},
      ${input.correctedValue === undefined ? null : JSON.stringify(input.correctedValue)},
      ${input.reason ?? null}, ${input.sourceRecordId ?? null}, ${input.createdBy ?? null})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}
