import "../load-env.js";
import { sql } from "drizzle-orm";
import { createDb, createPool, createRegistryPool } from "@otn/db";
import { createLogger } from "@otn/source-sdk";
import { crossNameKey, fetchRegistryIdentityRows } from "@otn/resolution";

// pnpm --filter @otn/worker brand:backfill          (read-only preview)
// pnpm --filter @otn/worker brand:backfill:apply    (writes)
//
// Repair orgs bound BEFORE brand-scoped identity shipped.
//
// The old accept-side backfeed stamped the entity's ENTIRE `contractor_numbers`
// array onto the org and set `contractor_registration` to an arbitrary first
// element. For a multi-brand entity that is simply wrong: SOUND ELECTRONICS came
// out holding MADSEE*140P8 — the licence of *Madsen Electric*, a sibling brand —
// so a permit naming Madsen would have collapsed onto the Sound Electronics org
// and fused two businesses.
//
// This pass gives every bound org the brand it actually is:
//   1. pin `registry_brand_ref` to that brand's licence;
//   2. correct `contractor_registration` when it points at a SIBLING brand;
//   3. remove stamped licences that are the known licence of a DIFFERENT brand.
//
// SAFETY RULES
//   * Only `provenance = 'registry_accept'` identifier rows are ever removed.
//     `source_evidence` rows came from a real published permit and are never
//     touched — this repairs what the backfeed invented, nothing observed.
//   * A licence not attributable to ANY brand is LEFT ALONE. One brand can hold
//     several licences (a general plus a specialty) while the contract surfaces
//     only its primary; deleting the rest would destroy real matching power.
//   * Single-brand entities keep every licence: with no sibling brand there is
//     nothing to fuse with.
//   * An org whose name matches no brand (e.g. bound by `ubi_exact`) is pinned
//     only when the entity has exactly ONE brand — otherwise the brand is
//     genuinely unknown and stays null rather than guessed.
//
// Idempotent: a second run reports 0 changes.

/** Same normalization the identifier store uses, so keys line up. */
function alnumUpper(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return v.length ? v : null;
}

interface BoundOrgRow {
  id: string;
  canonical_name: string;
  registry_ref: string;
  contractor_registration: string | null;
  registry_brand_ref: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const logger = createLogger({ app: apply ? "brand-backfill-apply" : "brand-backfill-preview" });
  const pool = createPool();
  const db = createDb(pool);
  const registryPool = createRegistryPool();
  try {
    if (!registryPool) {
      logger.info({ skipped: true }, "no REGISTRY_DATABASE_URL — brand backfill cannot run");
      return;
    }
    const registryRows = await fetchRegistryIdentityRows(registryPool);
    const byEntity = new Map(registryRows.map((r) => [r.entityId, r]));

    const orgRes = await db.execute(sql`
      SELECT id, canonical_name, registry_ref, contractor_registration, registry_brand_ref
      FROM organizations WHERE registry_ref IS NOT NULL`);
    const orgs = orgRes.rows as unknown as BoundOrgRow[];

    let pinned = 0;
    let registrationFixed = 0;
    let licencesRemoved = 0;
    let unresolved = 0;

    for (const org of orgs) {
      const entity = byEntity.get(org.registry_ref);
      const brands = entity?.brands ?? [];
      if (brands.length === 0) {
        unresolved += 1;
        continue;
      }
      // Which brand IS this org? Name match first; a single-brand entity is
      // unambiguous even when the name drifted.
      const orgKey = crossNameKey(org.canonical_name);
      const named = brands.filter((b) => crossNameKey(b.name) === orgKey);
      const brand = named.length === 1 ? named[0]! : brands.length === 1 ? brands[0]! : null;
      if (!brand) {
        unresolved += 1;
        logger.info(
          { org: org.canonical_name, entityBrands: brands.length },
          "brand unresolved — left untouched",
        );
        continue;
      }
      const brandLicence = alnumUpper(brand.licence);
      if (!brandLicence) {
        unresolved += 1;
        continue;
      }

      // Licences that definitely belong to a DIFFERENT brand of this entity.
      const siblingLicences = new Set(
        brands
          .filter((b) => b !== brand)
          .map((b) => alnumUpper(b.licence))
          .filter((v): v is string => v !== null && v !== brandLicence),
      );

      const needsPin = org.registry_brand_ref !== brandLicence;
      const registrationIsSibling =
        org.contractor_registration !== null && siblingLicences.has(org.contractor_registration);

      const stamped = (await db.execute(sql`
        SELECT value_normalized FROM organization_identifiers
        WHERE organization_id = ${org.id} AND identifier_type = 'contractor_number'
          AND provenance = 'registry_accept'`)).rows as { value_normalized: string }[];
      const toRemove = stamped.map((r) => r.value_normalized).filter((v) => siblingLicences.has(v));

      if (!needsPin && !registrationIsSibling && toRemove.length === 0) continue;

      if (!apply) {
        logger.info(
          {
            org: org.canonical_name,
            brand: brand.name,
            pinTo: needsPin ? brandLicence : undefined,
            registrationWas: registrationIsSibling ? org.contractor_registration : undefined,
            wouldRemove: toRemove.length > 0 ? toRemove : undefined,
          },
          "would repair",
        );
        if (needsPin) pinned += 1;
        if (registrationIsSibling) registrationFixed += 1;
        licencesRemoved += toRemove.length;
        continue;
      }

      if (needsPin) {
        await db.execute(sql`
          UPDATE organizations SET registry_brand_ref = ${brandLicence} WHERE id = ${org.id}`);
        pinned += 1;
      }
      if (registrationIsSibling) {
        await db.execute(sql`
          UPDATE organizations SET contractor_registration = ${brandLicence} WHERE id = ${org.id}`);
        registrationFixed += 1;
      }
      for (const licence of toRemove) {
        await db.execute(sql`
          DELETE FROM organization_identifiers
          WHERE organization_id = ${org.id} AND identifier_type = 'contractor_number'
            AND value_normalized = ${licence} AND provenance = 'registry_accept'`);
        licencesRemoved += 1;
      }
    }

    logger.info(
      {
        mode: apply ? "apply" : "preview (dry run — no writes)",
        boundOrgs: orgs.length,
        pinned,
        registrationFixed,
        licencesRemoved,
        unresolved,
      },
      "brand backfill complete",
    );
  } finally {
    await registryPool?.end();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
