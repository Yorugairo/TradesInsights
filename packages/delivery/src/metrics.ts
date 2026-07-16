import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * M4.2 — delivery quality metrics (spec §19/§21 gates: duplicates <3%,
 * expired <2%). Both failure modes are prevented by construction — "new" is
 * a delivery-history fact, and the §15 gate blocks stale items — but the
 * gates are MEASURED over what was actually stored, never just asserted.
 */

export const DUPLICATE_RATE_MAX = 0.03;
export const EXPIRED_RATE_MAX = 0.02;
const STALE_DAYS = 180;

export interface DeliveryQualityMetrics {
  deliveries: number;
  items: number;
  /** Items labeled new in more than one delivery for the same account. */
  duplicateNewItems: number;
  duplicateRate: number | null;
  /** Items whose project had no activity in the 180d before delivery period end. */
  expiredItems: number;
  expiredRate: number | null;
  gates: { duplicatePass: boolean; expiredPass: boolean };
}

interface StoredItem {
  opportunityId: string;
  projectId: string;
  isNew: boolean;
}

export async function deliveryQualityMetrics(
  db: Db,
  opts: { accountProfileId?: string } = {},
): Promise<DeliveryQualityMetrics> {
  const filter = opts.accountProfileId
    ? sql`AND d.account_profile_id = ${opts.accountProfileId}`
    : sql``;
  const res = await db.execute(sql`
    SELECT d.id, d.account_profile_id, d.period_end, d.metadata_json
    FROM deliveries d
    WHERE d.delivery_type = 'weekly_digest' ${filter}
    ORDER BY d.period_end`);

  const rows = res.rows as {
    id: string;
    account_profile_id: string;
    period_end: string;
    metadata_json: { items?: StoredItem[] } | null;
  }[];

  let items = 0;
  let duplicateNewItems = 0;
  let expiredItems = 0;
  const seenNew = new Set<string>();
  const staleChecks: { projectId: string; periodEnd: string }[] = [];

  for (const d of rows) {
    for (const item of d.metadata_json?.items ?? []) {
      items++;
      if (item.isNew) {
        const key = `${d.account_profile_id}:${item.opportunityId}`;
        if (seenNew.has(key)) duplicateNewItems++;
        seenNew.add(key);
      }
      staleChecks.push({ projectId: item.projectId, periodEnd: d.period_end });
    }
  }

  // Expired = last dated project event more than STALE_DAYS before the
  // delivery period end (i.e. the item was already stale when delivered).
  for (const check of staleChecks) {
    const ev = await db.execute(sql`
      SELECT max(COALESCE(pe.event_date, pe.observed_at)) AS last_at
      FROM project_events pe WHERE pe.project_id = ${check.projectId}`);
    const lastAt = (ev.rows[0] as { last_at: string | null }).last_at;
    if (!lastAt) {
      expiredItems++;
      continue;
    }
    const ageDays =
      (new Date(check.periodEnd).getTime() - new Date(lastAt).getTime()) / 86_400_000;
    if (ageDays > STALE_DAYS) expiredItems++;
  }

  const duplicateRate = items === 0 ? null : duplicateNewItems / items;
  const expiredRate = items === 0 ? null : expiredItems / items;
  return {
    deliveries: rows.length,
    items,
    duplicateNewItems,
    duplicateRate,
    expiredItems,
    expiredRate,
    gates: {
      duplicatePass: duplicateRate === null || duplicateRate < DUPLICATE_RATE_MAX,
      expiredPass: expiredRate === null || expiredRate < EXPIRED_RATE_MAX,
    },
  };
}
