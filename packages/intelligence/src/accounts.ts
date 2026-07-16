import { and, desc, eq } from "drizzle-orm";
import { accountProfiles, accountRules, type Db } from "@otn/db";

/**
 * M3.1 — account profiles and versioned rules (spec §12). Rules are
 * append-only: editing a rule inserts version max+1; prior versions stay
 * untouched so every past routing/scoring decision remains explainable.
 */

export interface AccountProfile {
  id: string;
  key: string;
  name: string;
  active: boolean;
  capabilities: string[];
  territory: {
    counties_included?: string[];
    counties_excluded?: string[];
    notes?: string;
  };
  exclusions: Record<string, unknown>;
  delivery: { priority_review_min?: number; weekly_digest_min?: number };
}

export interface AccountRule {
  ruleType: string;
  version: number;
  effectiveAt: Date;
  rule: Record<string, unknown>;
}

export async function getActiveAccounts(db: Db): Promise<AccountProfile[]> {
  const rows = await db
    .select()
    .from(accountProfiles)
    .where(eq(accountProfiles.active, true));
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    active: r.active,
    capabilities: (r.capabilitiesJson as string[]) ?? [],
    territory: (r.territoryJson as AccountProfile["territory"]) ?? {},
    exclusions: (r.exclusionsJson as Record<string, unknown>) ?? {},
    delivery: (r.deliveryConfigJson as AccountProfile["delivery"]) ?? {},
  }));
}

export async function getAccountByKey(db: Db, key: string): Promise<AccountProfile | null> {
  const all = await getActiveAccounts(db);
  return all.find((a) => a.key === key) ?? null;
}

/** Latest version of one rule type for an account. */
export async function latestRule(
  db: Db,
  accountProfileId: string,
  ruleType: string,
): Promise<AccountRule | null> {
  const [row] = await db
    .select()
    .from(accountRules)
    .where(
      and(
        eq(accountRules.accountProfileId, accountProfileId),
        eq(accountRules.ruleType, ruleType),
      ),
    )
    .orderBy(desc(accountRules.version))
    .limit(1);
  if (!row) return null;
  return {
    ruleType: row.ruleType,
    version: row.version,
    effectiveAt: row.effectiveAt,
    rule: row.ruleJson as Record<string, unknown>,
  };
}

/** All latest rules for an account, keyed by rule type. */
export async function latestRules(
  db: Db,
  accountProfileId: string,
): Promise<Map<string, AccountRule>> {
  const rows = await db
    .select()
    .from(accountRules)
    .where(eq(accountRules.accountProfileId, accountProfileId))
    .orderBy(desc(accountRules.version));
  const out = new Map<string, AccountRule>();
  for (const row of rows) {
    if (!out.has(row.ruleType)) {
      out.set(row.ruleType, {
        ruleType: row.ruleType,
        version: row.version,
        effectiveAt: row.effectiveAt,
        rule: row.ruleJson as Record<string, unknown>,
      });
    }
  }
  return out;
}

/**
 * Append a new rule version (spec §12: versioned and editable — never
 * overwritten). Returns the new version number.
 */
export async function appendRuleVersion(
  db: Db,
  accountProfileId: string,
  ruleType: string,
  rule: Record<string, unknown>,
  effectiveAt: Date = new Date(),
): Promise<number> {
  const current = await latestRule(db, accountProfileId, ruleType);
  const version = (current?.version ?? 0) + 1;
  await db.insert(accountRules).values({
    accountProfileId,
    ruleType,
    ruleJson: rule,
    version,
    effectiveAt,
  });
  return version;
}
