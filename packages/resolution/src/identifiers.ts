/**
 * Organization identifiers (migration 0023) — the supply side of
 * identifier-based registry matching. Parsers emit optional
 * phone/ubi/contractorLicense on `organizations[]` entries when a source
 * actually publishes them; this module persists them as evidence-carrying
 * rows and backfeeds strong keys (ubi / contractor number) onto the
 * organization so the existing strong-key registry link binds on its next
 * pass. Nothing here is guessed: absent fields stay absent.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/** Normalize a US phone to bare 10 digits (strip punctuation and a leading 1).
 * Returns null when the result is not a plausible 10-digit US number. */
export function normalizePhoneUS(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function alnumUpper(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return v.length ? v : null;
}

export interface OrgIdentifierInput {
  phone?: string | undefined;
  ubi?: string | undefined;
  contractorLicense?: string | undefined;
}

/**
 * Upsert the identifiers a record's organization entry carries, then backfeed
 * strong keys onto the organization row when it has none (never overwrite an
 * existing value — conflicts are the review queue's job, not a blind write).
 */
export async function persistOrganizationIdentifiers(
  db: Db,
  organizationId: string,
  sourceRecordId: string,
  input: OrgIdentifierInput,
): Promise<{ upserted: number }> {
  const rows: { type: string; raw: string; normalized: string }[] = [];
  const phone = normalizePhoneUS(input.phone);
  if (phone && input.phone) rows.push({ type: "phone", raw: input.phone, normalized: phone });
  const ubi = alnumUpper(input.ubi);
  if (ubi && ubi.length >= 7 && input.ubi) rows.push({ type: "ubi", raw: input.ubi, normalized: ubi });
  const license = alnumUpper(input.contractorLicense);
  if (license && input.contractorLicense) {
    rows.push({ type: "contractor_number", raw: input.contractorLicense, normalized: license });
  }

  let upserted = 0;
  for (const row of rows) {
    await db.execute(sql`
      INSERT INTO organization_identifiers
        (organization_id, identifier_type, value_raw, value_normalized, source_record_id)
      VALUES (${organizationId}, ${row.type}, ${row.raw}, ${row.normalized}, ${sourceRecordId})
      ON CONFLICT (organization_id, identifier_type, value_normalized)
      DO UPDATE SET last_seen_at = now()`);
    upserted += 1;
  }

  // Strong-key backfeed: fill organizations.ubi / contractor_registration only
  // when currently NULL — the strong-key registry link picks them up nightly.
  if (ubi && ubi.length >= 7) {
    await db.execute(sql`
      UPDATE organizations SET ubi = ${ubi} WHERE id = ${organizationId} AND ubi IS NULL`);
  }
  if (license) {
    await db.execute(sql`
      UPDATE organizations SET contractor_registration = ${license}
      WHERE id = ${organizationId} AND contractor_registration IS NULL`);
  }
  return { upserted };
}

/** Evidence-backed phones per organization (input to the phone-match rules). */
export async function loadOrganizationPhones(db: Db): Promise<Map<string, Set<string>>> {
  const res = await db.execute(sql`
    SELECT organization_id, value_normalized FROM organization_identifiers
    WHERE identifier_type = 'phone'`);
  const map = new Map<string, Set<string>>();
  for (const r of res.rows as { organization_id: string; value_normalized: string }[]) {
    const set = map.get(r.organization_id) ?? new Set<string>();
    set.add(r.value_normalized);
    map.set(r.organization_id, set);
  }
  return map;
}
