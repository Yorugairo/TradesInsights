import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";

/**
 * S4 (strengthening addendum §7) — GC relationship intelligence. Account-scoped
 * relationship state, contacts, and interactions, kept strictly distinct from
 * the shared graph's public project roles (a public role is what the record
 * says; relationship_state is what the customer tells us). Blocked /
 * do_not_pursue / incumbent_blocked organizations suppress that account's alerts.
 */

export const RELATIONSHIP_STATES = [
  "unknown", "research_needed", "target", "contacted",
  "active_relationship", "preferred", "incumbent_blocked", "do_not_pursue",
] as const;
export type RelationshipState = (typeof RELATIONSHIP_STATES)[number];

export async function setRelationship(
  db: Db,
  input: {
    accountProfileId: string;
    organizationId: string;
    relationshipState: RelationshipState;
    ownerUserId?: string | null;
    preferred?: boolean;
    blocked?: boolean;
    notes?: string | null;
  },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO account_organization_relationships
      (account_profile_id, organization_id, relationship_state, relationship_owner_user_id, preferred, blocked, notes)
    VALUES (${input.accountProfileId}, ${input.organizationId}, ${input.relationshipState},
      ${input.ownerUserId ?? null}, ${input.preferred ?? false}, ${input.blocked ?? false}, ${input.notes ?? null})
    ON CONFLICT (account_profile_id, organization_id) DO UPDATE SET
      relationship_state = EXCLUDED.relationship_state,
      relationship_owner_user_id = COALESCE(EXCLUDED.relationship_owner_user_id, account_organization_relationships.relationship_owner_user_id),
      preferred = EXCLUDED.preferred,
      blocked = EXCLUDED.blocked,
      notes = COALESCE(EXCLUDED.notes, account_organization_relationships.notes),
      updated_at = now()
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

export async function addContact(
  db: Db,
  input: {
    organizationId: string;
    /** NULL = a GLOBAL public-business contact (registry/Google adoption),
     * visible to every account; only legal with sourceType 'public_business'
     * (DB CHECK, migration 0020). Customer-supplied stays account-scoped. */
    accountProfileId: string | null;
    name: string;
    role?: string | null;
    email?: string | null;
    phone?: string | null;
    sourceType: "public_business" | "customer_supplied";
    customerVerified?: boolean;
  },
): Promise<{ id: string }> {
  if (input.accountProfileId === null && input.sourceType !== "public_business") {
    throw new Error("a global (account-less) contact must have sourceType 'public_business'");
  }
  const res = await db.execute(sql`
    INSERT INTO organization_contacts
      (organization_id, account_profile_id, name, role, email, phone, source_type, customer_verified, last_verified_at)
    VALUES (${input.organizationId}, ${input.accountProfileId}, ${input.name}, ${input.role ?? null},
      ${input.email ?? null}, ${input.phone ?? null}, ${input.sourceType}, ${input.customerVerified ?? false},
      ${input.customerVerified ? new Date().toISOString() : null})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

export async function addInteraction(
  db: Db,
  relationshipId: string,
  input: { interactionType: string; occurredAt?: string; projectId?: string | null; pursuitId?: string | null; summary?: string; createdBy?: string },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO relationship_interactions
      (relationship_id, interaction_type, occurred_at, project_id, pursuit_id, summary, created_by)
    VALUES (${relationshipId}, ${input.interactionType}, ${input.occurredAt ?? null}, ${input.projectId ?? null},
      ${input.pursuitId ?? null}, ${input.summary ?? null}, ${input.createdBy ?? null})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

/** True when this account's alerts for this org must be suppressed (spec §7/§9). */
export async function isAlertSuppressed(db: Db, accountProfileId: string, organizationId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT relationship_state, blocked FROM account_organization_relationships
    WHERE account_profile_id = ${accountProfileId} AND organization_id = ${organizationId}`);
  const r = res.rows[0] as { relationship_state: string; blocked: boolean } | undefined;
  if (!r) return false;
  return r.blocked || r.relationship_state === "do_not_pursue" || r.relationship_state === "incumbent_blocked";
}

export interface OrganizationView {
  organization: {
    id: string;
    name: string;
    ubi: string | null;
    status: string | null;
    verifiedAt: string | null;
    /** One Trade Network canonical entity id when bound (registry seam). */
    registryRef: string | null;
    /** Cached PUBLIC registry identity snapshot (name/licenses/phone/locality),
     * stamped at bind time — the CRM's verified-identity panel. */
    registryIdentity: Record<string, unknown> | null;
  };
  /** From the shared graph — public, not account-specific. */
  publicRoles: { projectId: string; projectName: string; role: string | null; confirmed: boolean }[];
  /** Account-specific relationship state (what the customer told us). */
  relationship: {
    relationshipState: string;
    preferred: boolean;
    blocked: boolean;
    ownerUserId: string | null;
    alertSuppressed: boolean;
  } | null;
  contacts: { name: string; role: string | null; email: string | null; sourceType: string; customerVerified: boolean }[];
  invitations: { id: string; projectName: string | null; invitationStatus: string; bidDueAt: string | null }[];
  /** GC Radar (flywheel Phase 2): permit velocity from the shared record graph. */
  activity: { projectsTotal: number; projects12m: number; projects90d: number };
  /** Wave 2 E2 (GC copilot) — THIS ACCOUNT's working history with the org:
   * its opportunities on projects where the org holds a role, with pursuit
   * state/outcome when one exists. Account-scoped by construction; newest
   * first, bounded. */
  workingHistory: {
    opportunityId: string;
    projectName: string;
    county: string;
    stage: string;
    opportunityState: string;
    score: number | null;
    pursuitState: string | null;
    outcomeValue: number | null;
    /** The score-neutral warm-relationship signal on this opportunity. */
    warmGcActive: boolean;
    lastActivityAt: string | null;
  }[];
}

export interface AccountOrgSummary {
  id: string;
  name: string;
  relationshipState: string | null;
  preferred: boolean;
  blocked: boolean;
  projectCount: number;
}

/** Organizations relevant to an account: with a relationship set, or holding a
 * role on a project the account has an opportunity for. */
export async function listAccountOrganizations(db: Db, accountProfileId: string): Promise<AccountOrgSummary[]> {
  const res = await db.execute(sql`
    WITH rel AS (
      SELECT organization_id, relationship_state, preferred, blocked
      FROM account_organization_relationships WHERE account_profile_id = ${accountProfileId}
    ), roled AS (
      SELECT DISTINCT pr.organization_id
      FROM project_roles pr
      JOIN opportunities o ON o.project_id = pr.project_id AND o.account_profile_id = ${accountProfileId}
    )
    SELECT org.id, org.canonical_name AS name, rel.relationship_state, rel.preferred, rel.blocked,
      (SELECT count(DISTINCT pr.project_id) FROM project_roles pr
        JOIN opportunities o ON o.project_id = pr.project_id AND o.account_profile_id = ${accountProfileId}
        WHERE pr.organization_id = org.id) AS project_count
    FROM organizations org
    LEFT JOIN rel ON rel.organization_id = org.id
    WHERE org.id IN (SELECT organization_id FROM rel) OR org.id IN (SELECT organization_id FROM roled)
    ORDER BY rel.preferred DESC NULLS LAST, org.canonical_name ASC
    LIMIT 500`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    name: r["name"] as string,
    relationshipState: (r["relationship_state"] as string | null) ?? null,
    preferred: Boolean(r["preferred"]),
    blocked: Boolean(r["blocked"]),
    projectCount: Number(r["project_count"] ?? 0),
  }));
}

/** Assemble the account-scoped GC view (public roles vs relationship kept distinct). */
export async function getOrganizationView(db: Db, organizationId: string, accountProfileId: string): Promise<OrganizationView | null> {
  const orgRes = await db.execute(sql`
    SELECT id, canonical_name, ubi, status, verified_at, registry_ref, registry_identity_json
    FROM organizations WHERE id = ${organizationId}`);
  const org = orgRes.rows[0] as
    | {
        id: string; canonical_name: string; ubi: string | null; status: string | null;
        verified_at: string | null; registry_ref: string | null;
        registry_identity_json: Record<string, unknown> | null;
      }
    | undefined;
  if (!org) return null;

  const [roles, rel, contacts, invitations, activity] = await Promise.all([
    db.execute(sql`
      SELECT pr.project_id, p.canonical_name AS project_name, pr.role, pr.confirmed
      FROM project_roles pr JOIN projects p ON p.id = pr.project_id
      WHERE pr.organization_id = ${organizationId} LIMIT 100`),
    db.execute(sql`
      SELECT relationship_state, preferred, blocked, relationship_owner_user_id
      FROM account_organization_relationships
      WHERE account_profile_id = ${accountProfileId} AND organization_id = ${organizationId}`),
    // The account's own contacts PLUS global public-business rows (NULL
    // account — e.g. registry/Google adoptions): the login-locked CRM
    // surfaces everything available for the client. Cross-ACCOUNT rows stay
    // invisible; only the explicitly-global public rows are shared.
    db.execute(sql`
      SELECT name, role, email, source_type, customer_verified FROM organization_contacts
      WHERE (account_profile_id = ${accountProfileId}
             OR (account_profile_id IS NULL AND source_type = 'public_business'))
        AND organization_id = ${organizationId} ORDER BY created_at ASC`),
    db.execute(sql`
      SELECT bi.id, p.canonical_name AS project_name, bi.invitation_status, bi.bid_due_at
      FROM bid_invitations bi LEFT JOIN projects p ON p.id = bi.project_id
      WHERE bi.account_profile_id = ${accountProfileId} AND bi.gc_organization_id = ${organizationId}`),
    // Permit velocity from the shared graph (GC Radar): recent-window counts.
    db.execute(sql`
      SELECT count(DISTINCT pr.project_id)::int AS total,
        count(DISTINCT pr.project_id) FILTER (WHERE pr.last_seen_at >= now() - interval '12 months')::int AS m12,
        count(DISTINCT pr.project_id) FILTER (WHERE pr.last_seen_at >= now() - interval '90 days')::int AS d90
      FROM project_roles pr WHERE pr.organization_id = ${organizationId}`),
  ]);

  // Wave 2 E2 — working history: the account's opportunities on this org's
  // projects (EXISTS avoids multi-role fanout), joined to the account's
  // pursuit when one exists. At most one pursuit per (account, opportunity).
  const history = await db.execute(sql`
    SELECT o.id, p.canonical_name AS project_name, p.county, p.current_stage,
      o.state, o.current_score,
      COALESCE(o.rationale_json -> 'signals' ? 'warm_gc_active', false) AS warm_gc,
      pu.state AS pursuit_state, pu.outcome_value,
      o.last_material_change_at
    FROM opportunities o
    JOIN projects p ON p.id = o.project_id
    LEFT JOIN pursuits pu
      ON pu.opportunity_id = o.id AND pu.account_profile_id = o.account_profile_id
    WHERE o.account_profile_id = ${accountProfileId}
      AND EXISTS (
        SELECT 1 FROM project_roles pr
        WHERE pr.project_id = o.project_id AND pr.organization_id = ${organizationId})
    ORDER BY o.last_material_change_at DESC NULLS LAST, o.id
    LIMIT 20`);

  const relRow = rel.rows[0] as
    | { relationship_state: string; preferred: boolean; blocked: boolean; relationship_owner_user_id: string | null }
    | undefined;

  return {
    organization: {
      id: org.id, name: org.canonical_name, ubi: org.ubi, status: org.status, verifiedAt: org.verified_at,
      registryRef: org.registry_ref, registryIdentity: org.registry_identity_json,
    },
    publicRoles: (roles.rows as Record<string, unknown>[]).map((r) => ({
      projectId: r["project_id"] as string,
      projectName: r["project_name"] as string,
      role: (r["role"] as string | null) ?? null,
      confirmed: Boolean(r["confirmed"]),
    })),
    relationship: relRow
      ? {
          relationshipState: relRow.relationship_state,
          preferred: relRow.preferred,
          blocked: relRow.blocked,
          ownerUserId: relRow.relationship_owner_user_id,
          alertSuppressed:
            relRow.blocked || relRow.relationship_state === "do_not_pursue" || relRow.relationship_state === "incumbent_blocked",
        }
      : null,
    contacts: (contacts.rows as Record<string, unknown>[]).map((c) => ({
      name: c["name"] as string,
      role: (c["role"] as string | null) ?? null,
      email: (c["email"] as string | null) ?? null,
      sourceType: c["source_type"] as string,
      customerVerified: Boolean(c["customer_verified"]),
    })),
    invitations: (invitations.rows as Record<string, unknown>[]).map((i) => ({
      id: i["id"] as string,
      projectName: (i["project_name"] as string | null) ?? null,
      invitationStatus: i["invitation_status"] as string,
      bidDueAt: (i["bid_due_at"] as string | null) ?? null,
    })),
    activity: (() => {
      const a = activity.rows[0] as { total?: number; m12?: number; d90?: number } | undefined;
      return {
        projectsTotal: Number(a?.total ?? 0),
        projects12m: Number(a?.m12 ?? 0),
        projects90d: Number(a?.d90 ?? 0),
      };
    })(),
    workingHistory: (history.rows as Record<string, unknown>[]).map((h) => ({
      opportunityId: h["id"] as string,
      projectName: h["project_name"] as string,
      county: h["county"] as string,
      stage: h["current_stage"] as string,
      opportunityState: h["state"] as string,
      score: h["current_score"] === null ? null : Number(h["current_score"]),
      pursuitState: (h["pursuit_state"] as string | null) ?? null,
      outcomeValue: h["outcome_value"] === null || h["outcome_value"] === undefined ? null : Number(h["outcome_value"]),
      warmGcActive: Boolean(h["warm_gc"]),
      lastActivityAt: (h["last_material_change_at"] as string | null) ?? null,
    })),
  };
}
