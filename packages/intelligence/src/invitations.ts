import { sql } from "drizzle-orm";
import { parseInvitationEmail } from "@otn/documents";
import type { Db } from "@otn/db";

/**
 * S3 (strengthening addendum §6) — ingest a customer-authorized bid invitation.
 * Deterministic and idempotent: a duplicate forwarded message (same account +
 * provider + provider_message_id) is ingested once. Matching links only to
 * projects the account already sees (read-only — a private invitation never
 * merges into the shared graph, preserving the M4.6 isolation boundary).
 * Deadline changes are recorded as append-only account-scoped invitation events,
 * never overwriting history and never writing to the shared project timeline.
 */

export interface IngestInvitationInput {
  accountProfileId: string;
  provider: string;
  providerMessageId: string;
  rawEml: string;
  rawArtifactId?: string | null;
  receivedAt?: Date;
}

export interface IngestInvitationResult {
  inboundMessageId: string;
  invitationId: string | null;
  deduped: boolean;
  matchStatus: "matched" | "review" | "unmatched";
  deadlineChanged: boolean;
  addendumRecorded: boolean;
}

interface MatchResult {
  projectId: string | null;
  status: "matched" | "review" | "unmatched";
}

/** Match to a project the account already sees (isolation-safe, read-only). */
async function matchProject(db: Db, accountProfileId: string, projectName: string | null): Promise<MatchResult> {
  if (!projectName?.trim()) return { projectId: null, status: "unmatched" };
  const res = await db.execute(sql`
    SELECT DISTINCT p.id
    FROM projects p JOIN opportunities o ON o.project_id = p.id
    WHERE o.account_profile_id = ${accountProfileId}
      AND lower(p.canonical_name) LIKE ${"%" + projectName.trim().toLowerCase() + "%"}
    LIMIT 5`);
  const ids = (res.rows as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return { projectId: null, status: "unmatched" };
  if (ids.length > 1) return { projectId: null, status: "review" }; // ambiguous → review
  return { projectId: ids[0]!, status: "matched" };
}

export async function ingestInvitation(db: Db, input: IngestInvitationInput): Promise<IngestInvitationResult> {
  const parsed = parseInvitationEmail(input.rawEml);
  const providerMessageId = parsed.messageId ?? input.providerMessageId;

  // Idempotency: a duplicate forwarded message is ingested once per account.
  const dup = await db.execute(sql`
    SELECT im.id, bi.id AS invitation_id
    FROM inbound_messages im
    LEFT JOIN bid_invitations bi ON bi.source_message_id = im.id
    WHERE im.account_profile_id = ${input.accountProfileId}
      AND im.provider = ${input.provider} AND im.provider_message_id = ${providerMessageId}`);
  if (dup.rows.length > 0) {
    const r = dup.rows[0] as { id: string; invitation_id: string | null };
    return {
      inboundMessageId: r.id,
      invitationId: r.invitation_id,
      deduped: true,
      matchStatus: "unmatched",
      deadlineChanged: false,
      addendumRecorded: false,
    };
  }

  const inserted = await db.execute(sql`
    INSERT INTO inbound_messages
      (account_profile_id, provider, provider_message_id, sender, recipients_json, subject, received_at, raw_artifact_id, processing_status)
    VALUES (${input.accountProfileId}, ${input.provider}, ${providerMessageId}, ${parsed.sender},
      ${JSON.stringify(parsed.recipients)}, ${parsed.subject},
      ${(input.receivedAt ?? parsed.sentAt)?.toISOString() ?? null}, ${input.rawArtifactId ?? null}, 'parsed')
    RETURNING id`);
  const inboundMessageId = (inserted.rows[0] as { id: string }).id;

  const match = await matchProject(db, input.accountProfileId, parsed.projectName);

  // Correlate to a prior invitation for the same account+project (re-forward /
  // addendum / deadline change) so we update rather than duplicate.
  let prior: { id: string; bid_due_at: string | null } | null = null;
  if (match.projectId) {
    const p = await db.execute(sql`
      SELECT id, bid_due_at FROM bid_invitations
      WHERE account_profile_id = ${input.accountProfileId} AND project_id = ${match.projectId}
      ORDER BY updated_at DESC LIMIT 1`);
    prior = (p.rows[0] as { id: string; bid_due_at: string | null } | undefined) ?? null;
  }

  let invitationId: string;
  let deadlineChanged = false;
  let addendumRecorded = false;

  if (prior) {
    invitationId = prior.id;
    const priorDue = prior.bid_due_at ? new Date(prior.bid_due_at).getTime() : null;
    const newDue = parsed.bidDueAt?.getTime() ?? null;
    if (newDue !== null && priorDue !== newDue) {
      deadlineChanged = true;
      // Append-only, account-scoped, both deadlines preserved. Requires human
      // verification before any deadline alert (metadata verified=false).
      await db.execute(sql`
        INSERT INTO bid_invitation_events (bid_invitation_id, event_type, event_at, source_message_id, metadata_json)
        VALUES (${invitationId}, 'deadline_changed', ${parsed.bidDueAt?.toISOString() ?? null}, ${inboundMessageId},
          ${JSON.stringify({ priorBidDueAt: prior.bid_due_at, revisedBidDueAt: parsed.bidDueAt?.toISOString() ?? null, verified: false })})`);
      await db.execute(sql`UPDATE bid_invitations SET bid_due_at = ${parsed.bidDueAt?.toISOString() ?? null}, updated_at = now() WHERE id = ${invitationId}`);
    }
  } else {
    const created = await db.execute(sql`
      INSERT INTO bid_invitations
        (account_profile_id, project_id, estimator_name, estimator_email, invitation_status,
         bid_due_at, job_walk_at, scope_summary, source_message_id, match_status, confidence)
      VALUES (${input.accountProfileId}, ${match.projectId}, ${parsed.estimatorName}, ${parsed.estimatorEmail},
        ${parsed.explicitInvitation ? "invited" : "unconfirmed"},
        ${parsed.bidDueAt?.toISOString() ?? null}, ${parsed.jobWalkAt?.toISOString() ?? null},
        ${parsed.scopeSummary}, ${inboundMessageId}, ${match.status}, ${parsed.explicitInvitation ? 0.9 : 0.4})
      RETURNING id`);
    invitationId = (created.rows[0] as { id: string }).id;
    await db.execute(sql`
      INSERT INTO bid_invitation_events (bid_invitation_id, event_type, event_at, source_message_id, metadata_json)
      VALUES (${invitationId}, 'invitation_received', ${(input.receivedAt ?? parsed.sentAt)?.toISOString() ?? null}, ${inboundMessageId},
        ${JSON.stringify({ explicitInvitation: parsed.explicitInvitation, matchStatus: match.status })})`);
  }

  if (parsed.addendumNumber !== null) {
    addendumRecorded = true;
    await db.execute(sql`
      INSERT INTO bid_invitation_events (bid_invitation_id, event_type, event_at, source_message_id, metadata_json)
      VALUES (${invitationId}, 'addendum', ${parsed.sentAt?.toISOString() ?? null}, ${inboundMessageId},
        ${JSON.stringify({ addendumNumber: parsed.addendumNumber, verified: false })})`);
  }

  return {
    inboundMessageId,
    invitationId,
    deduped: false,
    matchStatus: match.status,
    deadlineChanged,
    addendumRecorded,
  };
}

export interface InvitationSummary {
  id: string;
  projectId: string | null;
  projectName: string | null;
  invitationStatus: string;
  matchStatus: string;
  bidDueAt: string | null;
  jobWalkAt: string | null;
  scopeSummary: string | null;
  estimatorName: string | null;
}

/** Account-scoped invitation list (a private invitation is only visible to its account). */
export async function listInvitations(db: Db, accountProfileId: string): Promise<InvitationSummary[]> {
  const res = await db.execute(sql`
    SELECT bi.id, bi.project_id, p.canonical_name AS project_name, bi.invitation_status, bi.match_status,
      bi.bid_due_at, bi.job_walk_at, bi.scope_summary, bi.estimator_name
    FROM bid_invitations bi LEFT JOIN projects p ON p.id = bi.project_id
    WHERE bi.account_profile_id = ${accountProfileId}
    ORDER BY bi.bid_due_at ASC NULLS LAST, bi.created_at DESC`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    projectId: (r["project_id"] as string | null) ?? null,
    projectName: (r["project_name"] as string | null) ?? null,
    invitationStatus: r["invitation_status"] as string,
    matchStatus: r["match_status"] as string,
    bidDueAt: (r["bid_due_at"] as string | null) ?? null,
    jobWalkAt: (r["job_walk_at"] as string | null) ?? null,
    scopeSummary: (r["scope_summary"] as string | null) ?? null,
    estimatorName: (r["estimator_name"] as string | null) ?? null,
  }));
}

/** One invitation with its append-only event history (account-scoped). */
export async function getInvitation(
  db: Db,
  invitationId: string,
): Promise<{ accountProfileId: string; summary: InvitationSummary; events: { eventType: string; eventAt: string | null; metadata: unknown; createdAt: string }[] } | null> {
  const res = await db.execute(sql`
    SELECT bi.*, p.canonical_name AS project_name FROM bid_invitations bi
    LEFT JOIN projects p ON p.id = bi.project_id WHERE bi.id = ${invitationId}`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  const ev = await db.execute(sql`
    SELECT event_type, event_at, metadata_json, created_at FROM bid_invitation_events
    WHERE bid_invitation_id = ${invitationId} ORDER BY created_at ASC`);
  return {
    accountProfileId: r["account_profile_id"] as string,
    summary: {
      id: r["id"] as string,
      projectId: (r["project_id"] as string | null) ?? null,
      projectName: (r["project_name"] as string | null) ?? null,
      invitationStatus: r["invitation_status"] as string,
      matchStatus: r["match_status"] as string,
      bidDueAt: (r["bid_due_at"] as string | null) ?? null,
      jobWalkAt: (r["job_walk_at"] as string | null) ?? null,
      scopeSummary: (r["scope_summary"] as string | null) ?? null,
      estimatorName: (r["estimator_name"] as string | null) ?? null,
    },
    events: (ev.rows as Record<string, unknown>[]).map((x) => ({
      eventType: x["event_type"] as string,
      eventAt: (x["event_at"] as string | null) ?? null,
      metadata: x["metadata_json"],
      createdAt: x["created_at"] as string,
    })),
  };
}
