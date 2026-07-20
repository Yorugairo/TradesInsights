import "./env.js";
import { loadAccountProfiles, loadSourcesConfig } from "@otn/config";
import { createDb, createPool } from "./client.js";
import { accountProfiles, accountRules, coverageEntries, sources } from "./schema.js";
import { sql } from "drizzle-orm";

/**
 * Seeds sources and account profiles from config/*.yaml. Idempotent: upserts
 * by natural key so reruns converge to the config state without duplicating.
 */
async function main() {
  const pool = createPool();
  const db = createDb(pool);
  const sourcesFile = loadSourcesConfig();
  const accountsFile = loadAccountProfiles();

  for (const s of sourcesFile.sources) {
    const [row] = await db
      .insert(sources)
      .values({
        key: s.key,
        name: s.name,
        authority: s.authority,
        priority: s.priority,
        landingUrl: s.landing_url,
        accessUrl: s.access_url,
        format: s.format,
        accessClass: s.access_class,
        cadence: s.cadence,
        county: s.county,
        permittingJurisdiction: s.permitting_jurisdiction,
        enabled: s.enabled,
        termsReviewedAt: s.terms_reviewed_at ? new Date(s.terms_reviewed_at) : null,
        robotsReviewedAt: s.robots_reviewed_at ? new Date(s.robots_reviewed_at) : null,
      })
      .onConflictDoUpdate({
        target: sources.key,
        set: {
          name: sql`excluded.name`,
          authority: sql`excluded.authority`,
          priority: sql`excluded.priority`,
          landingUrl: sql`excluded.landing_url`,
          accessUrl: sql`excluded.access_url`,
          format: sql`excluded.format`,
          accessClass: sql`excluded.access_class`,
          cadence: sql`excluded.cadence`,
          county: sql`excluded.county`,
          permittingJurisdiction: sql`excluded.permitting_jurisdiction`,
          enabled: sql`excluded.enabled`,
          termsReviewedAt: sql`excluded.terms_reviewed_at`,
          robotsReviewedAt: sql`excluded.robots_reviewed_at`,
        },
      })
      .returning({ id: sources.id });

    if (row) {
      await db
        .insert(coverageEntries)
        .values({
          sourceId: row.id,
          county: s.county,
          permittingJurisdiction: s.permitting_jurisdiction,
          status: s.enabled ? "enabled" : "planned",
        })
        .onConflictDoUpdate({
          target: coverageEntries.sourceId,
          set: {
            county: sql`excluded.county`,
            permittingJurisdiction: sql`excluded.permitting_jurisdiction`,
            status: sql`excluded.status`,
          },
        });
    }
  }

  for (const a of accountsFile.accounts) {
    const [profile] = await db
      .insert(accountProfiles)
      .values({
        key: a.key,
        name: a.name,
        active: a.active,
        capabilitiesJson: a.capabilities,
        territoryJson: a.territory,
        exclusionsJson: { excluded_ubis: a.organization.excluded_ubis },
        deliveryConfigJson: a.delivery,
      })
      .onConflictDoUpdate({
        target: accountProfiles.key,
        set: {
          name: sql`excluded.name`,
          active: sql`excluded.active`,
          capabilitiesJson: sql`excluded.capabilities_json`,
          territoryJson: sql`excluded.territory_json`,
          exclusionsJson: sql`excluded.exclusions_json`,
          deliveryConfigJson: sql`excluded.delivery_config_json`,
        },
      })
      .returning({ id: accountProfiles.id });

    if (!profile) continue;

    for (const r of a.rules) {
      await db
        .insert(accountRules)
        .values({
          accountProfileId: profile.id,
          ruleType: r.rule_type,
          ruleJson: { ...r.rule, provisional: r.provisional },
          version: r.version,
          effectiveAt: new Date(r.effective_at),
        })
        .onConflictDoNothing();
    }

    // Scoring weights are stored as a versioned scoring rule.
    await db
      .insert(accountRules)
      .values({
        accountProfileId: profile.id,
        ruleType: "scoring",
        ruleJson: { components: a.score_components },
        version: 1,
        effectiveAt: new Date("2026-07-15"),
      })
      .onConflictDoNothing();

    // E.1 — make the account's OWN L&I identity bind-ready: attach its strong
    // keys (UBI / contractor registration) to an organizations row so the nightly
    // registry-link binds it to its canonical registry entity BY STRONG KEY — the
    // governed path; we never hardcode registry_ref here (that stays in the
    // resolver). Only accounts that publish a strong key (e.g. Solis) get one.
    // The excluded/closed UBIs are configured separately and never seeded here.
    const orgUbi = a.organization.ubi ?? null;
    const orgReg = a.organization.contractor_registration ?? null;
    if (orgUbi || orgReg) {
      const orgName = a.name.toUpperCase();
      // Attach the strong keys to an existing same-name org (from permit data)
      // without overwriting anything already set — COALESCE keeps existing values.
      await db.execute(sql`
        UPDATE organizations
        SET ubi = COALESCE(ubi, ${orgUbi}),
            contractor_registration = COALESCE(contractor_registration, ${orgReg})
        WHERE canonical_name = ${orgName}`);
      // Otherwise seed a fresh identity org, keyed so re-runs and any existing
      // strong key never duplicate it (dedup of name variants is WS-B.4).
      await db.execute(sql`
        INSERT INTO organizations (canonical_name, ubi, contractor_registration)
        SELECT ${orgName}, ${orgUbi}, ${orgReg}
        WHERE NOT EXISTS (
          SELECT 1 FROM organizations
          WHERE canonical_name = ${orgName}
             OR (${orgUbi}::text IS NOT NULL AND ubi = ${orgUbi})
             OR (${orgReg}::text IS NOT NULL AND contractor_registration = ${orgReg}))`);
    }
  }

  // Link account-scoped private sources to their owning account (accounts are
  // seeded after sources, so this runs last). A configured account_key that
  // matches no account is an error — private data must never be unscoped.
  for (const s of sourcesFile.sources) {
    if (!s.account_key) continue;
    const res = await db.execute(
      sql`UPDATE sources SET account_profile_id =
            (SELECT id FROM account_profiles WHERE key = ${s.account_key})
          WHERE key = ${s.key}
          RETURNING account_profile_id`,
    );
    const linked = (res.rows[0] as { account_profile_id: string | null } | undefined)
      ?.account_profile_id;
    if (!linked) throw new Error(`source ${s.key}: unknown account_key ${s.account_key}`);
  }

  // S0 (§5) — seed a PROVISIONAL Solis capacity snapshot so capacity-aware
  // qualification has an effective snapshot to read. Values are placeholders
  // flagged provisional (spec §12.3 forbids finalizing before calibration);
  // real numbers land when Solis approves S0. Idempotent: skip if any snapshot
  // already exists for the account.
  await db.execute(sql`
    INSERT INTO account_capacity_snapshots
      (account_profile_id, effective_from, minimum_contract_value, ideal_contract_value,
       maximum_contract_value, accepts_public_work, trade_capacity_json, provisional,
       notes, created_by)
    SELECT ap.id, timestamptz '2026-07-15', 50000, 400000, 2000000, false,
      ${JSON.stringify({ drywall: "provisional", painting: "provisional" })}::jsonb, true,
      'Provisional placeholder pending Solis S0 calibration — not customer-confirmed.',
      'system_provisional'
    FROM account_profiles ap
    WHERE ap.key = 'solis_interiors'
      AND NOT EXISTS (
        SELECT 1 FROM account_capacity_snapshots s WHERE s.account_profile_id = ap.id)`);

  await pool.end();

  console.log(
    JSON.stringify({
      msg: "seed complete",
      sources: sourcesFile.sources.length,
      accounts: accountsFile.accounts.length,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
