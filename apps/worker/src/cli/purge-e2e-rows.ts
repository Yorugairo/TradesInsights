import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { sql } from "drizzle-orm";

/**
 * pnpm purge:e2e-rows [--apply]
 *
 * Removes rows the E2E SUITE WROTE INTO PRODUCTION.
 *
 * `apps/web/e2e/app.spec.ts` ran against the hosted database for months and
 * POSTed real records it never cleaned up:
 *
 *   :219  POST /api/app/outcomes      → opportunity_outcomes  (never deleted)
 *   :225  POST /api/admin/corrections → claim_corrections     (immutable by design)
 *   :86   POST …/feedback             → feedback              (3 per run)
 *         POST /api/app/pursuits      → pursuits + transitions
 *         .eml upload                 → bid_invitations + inbound_messages
 *
 * PHASE 1 (applied 2026-07-28 with owner approval): claim_corrections 30→0,
 * opportunity_outcomes 30→0. Those sections remain below as verification —
 * they should now report zero.
 *
 * PHASE 2 (this extension): feedback, pursuits and bid_invitations. The
 * feedback POSTs carry no distinguishing field, so the predicate is the
 * PROFILE, not a field: measured 2026-07-28, all 58 feedback rows sat on ONE
 * opportunity, from ONE user, inside the e2e window. The script derives that
 * cluster at runtime (never a hardcoded UUID) and REFUSES --apply if feedback
 * spans more than one opportunity or user — that would mean real customer
 * feedback has arrived since this was written, and a human must re-review.
 *
 * DRY RUN BY DEFAULT. Deleting production rows on import is how a cleanup
 * becomes an incident, so nothing is removed without `--apply`.
 *
 * WHY THIS PRINTS EVERY ROW RATHER THAN JUST DELETING. `opportunity_outcomes`
 * has NO `reason` column, and `created_by` is stamped from the session
 * (`solis_interiors`), not from the test — so a genuine customer row is
 * indistinguishable from the e2e row by any single field. What identifies the
 * e2e rows is their shape and clustering, and "almost certainly synthetic" is
 * not good enough to delete on, so this prints the candidates and waits for a
 * human.
 */

const APPLY = process.argv.includes("--apply");

type Db = ReturnType<typeof createDb>;
type Row = Record<string, unknown>;

/** The bare shape the e2e outcome POST produces — see app.spec.ts:219. */
const E2E_OUTCOME_PREDICATE = sql`
  outcome_type = 'won'
  AND influenced_by_otn = false
  AND pursuit_id IS NULL
  AND attributable_value IS NULL
  AND reason_code IS NULL
  AND notes IS NULL`;

/** The stable acme-gc .eml the invitation test uploads (dedupes on Message-ID). */
const E2E_INVITATION_PREDICATE = sql`estimator_email ILIKE '%acme-gc%'`;

interface PurgePlan {
  /** Single-cluster feedback target, derived from the profile at runtime. */
  feedbackOpportunityId: string | null;
  /** inbound_messages parents of the candidate invitations, captured BEFORE
   * the invitations are deleted (the join predicate dies with them). */
  inboundMessageIds: string[];
  /** Any refusal blocks the ENTIRE apply — the world changed, re-review. */
  refusals: string[];
}

// ── Phase 1 (verification — applied 2026-07-28, should report zero) ──────────

async function reportCorrections(db: Db): Promise<void> {
  const corr = await db.execute(sql`
    SELECT count(*) FILTER (WHERE reason = 'e2e')::int AS e2e,
           count(*)::int AS total
    FROM claim_corrections`);
  const c = corr.rows[0] as { e2e: number; total: number };
  console.log(`claim_corrections      ${c.e2e} of ${c.total} rows carry reason='e2e'`);
}

async function reportOutcomes(db: Db): Promise<void> {
  const profile = await db.execute(sql`
    SELECT outcome_type, influenced_by_otn,
           (pursuit_id IS NULL) AS no_pursuit,
           (attributable_value IS NULL) AS no_value,
           (notes IS NULL AND reason_code IS NULL) AS no_prose,
           count(*)::int AS n,
           min(created_at)::date AS first_seen,
           max(created_at)::date AS last_seen,
           count(DISTINCT opportunity_id)::int AS distinct_opps
    FROM opportunity_outcomes
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY n DESC`);
  console.log(`\nopportunity_outcomes   ${profile.rows.length === 0 ? "empty" : "distinct shapes:"}`);
  for (const r of profile.rows as Row[]) {
    const bare = r["no_pursuit"] && r["no_value"] && r["no_prose"];
    console.log(
      `  ${String(r["n"]).padStart(4)}  ${r["outcome_type"]}` +
        `  influenced=${r["influenced_by_otn"]}` +
        `  bare=${bare ? "YES (e2e shape)" : "no  (has detail — KEEP)"}` +
        `  opps=${r["distinct_opps"]}  ${r["first_seen"]}..${r["last_seen"]}`,
    );
  }
  const candidates = await db.execute(sql`
    SELECT id, opportunity_id, created_by, created_at
    FROM opportunity_outcomes
    WHERE ${E2E_OUTCOME_PREDICATE}
    ORDER BY created_at`);
  console.log(`  ${candidates.rows.length} candidate row(s) match the bare e2e shape`);
  for (const r of candidates.rows as Row[]) {
    console.log(`    ${r["id"]}  opp=${r["opportunity_id"]}  by=${r["created_by"]}  ${r["created_at"]}`);
  }
}

// ── Phase 2: feedback — the predicate is the cluster profile ─────────────────

async function profileFeedback(db: Db, plan: PurgePlan): Promise<void> {
  const clusters = await db.execute(sql`
    SELECT opportunity_id,
           count(*)::int AS n,
           count(DISTINCT user_id)::int AS users,
           min(user_id) AS any_user,
           min(created_at) AS first_seen,
           max(created_at) AS last_seen
    FROM feedback
    GROUP BY 1
    ORDER BY n DESC`);
  const rows = clusters.rows as Row[];
  console.log(`\nfeedback               ${rows.length} opportunity cluster(s):`);
  for (const r of rows) {
    console.log(
      `  ${String(r["n"]).padStart(4)} rows  opp=${r["opportunity_id"]}` +
        `  users=${r["users"]} (${r["any_user"]})  ${r["first_seen"]}..${r["last_seen"]}`,
    );
  }
  if (rows.length === 0) {
    console.log("  (empty — nothing to purge)");
    return;
  }
  if (rows.length > 1) {
    plan.refusals.push(
      `feedback spans ${rows.length} opportunities — the single-cluster profile this purge ` +
        "was approved against no longer holds. Real feedback may have arrived; re-review.",
    );
    return;
  }
  const only = rows[0]!;
  if ((only["users"] as number) > 1) {
    plan.refusals.push(
      `the feedback cluster has ${only["users"]} distinct users — the one-user profile ` +
        "this purge was approved against no longer holds; re-review.",
    );
    return;
  }
  plan.feedbackOpportunityId = only["opportunity_id"] as string;
  console.log(`  → single cluster, single user: ALL ${only["n"]} rows are purge candidates`);
}

// ── Phase 2: pursuits — anchored to the feedback cluster's opportunity ──────

async function profilePursuits(db: Db, plan: PurgePlan): Promise<void> {
  const pursuits = await db.execute(sql`
    SELECT p.id, p.opportunity_id, p.state, p.owner_user_id, p.opened_at::date AS opened,
           (SELECT count(*)::int FROM pursuit_transitions t WHERE t.pursuit_id = p.id) AS transitions,
           (SELECT count(*)::int FROM pursuit_tasks t WHERE t.pursuit_id = p.id) AS tasks,
           (SELECT count(*)::int FROM pursuit_notes t WHERE t.pursuit_id = p.id) AS notes,
           (SELECT count(*)::int FROM roi_events e WHERE e.pursuit_id = p.id) AS roi_events,
           (SELECT count(*)::int FROM opportunity_outcomes o WHERE o.pursuit_id = p.id) AS outcomes,
           (SELECT count(*)::int FROM relationship_interactions r WHERE r.pursuit_id = p.id) AS interactions
    FROM pursuits p
    ORDER BY p.opened_at`);
  const rows = pursuits.rows as Row[];
  console.log(`\npursuits               ${rows.length} row(s) total:`);
  for (const r of rows) {
    const isCandidate = r["opportunity_id"] === plan.feedbackOpportunityId;
    console.log(
      `  ${r["id"]}  opp=${r["opportunity_id"]}  state=${r["state"]}  owner=${r["owner_user_id"]}` +
        `  opened=${r["opened"]}  transitions=${r["transitions"]} tasks=${r["tasks"]} notes=${r["notes"]}` +
        ` roi=${r["roi_events"]}  ${isCandidate ? "← CANDIDATE (e2e opportunity)" : "(KEEP — different opportunity)"}`,
    );
    // Same-POST residue (transitions, tasks, notes, roi_events) deletes with
    // the pursuit. An outcome or relationship interaction is different: those
    // are human-recorded against the pursuit, which the e2e suite never does.
    if (isCandidate && ((r["outcomes"] as number) > 0 || (r["interactions"] as number) > 0)) {
      plan.refusals.push(
        `pursuit ${r["id"]} has ${r["outcomes"]} outcome(s) and ${r["interactions"]} ` +
          "relationship interaction(s) recorded against it — that is human usage the e2e " +
          "suite never produces; re-review.",
      );
    }
  }
  if (rows.length > 0 && plan.feedbackOpportunityId === null) {
    console.log(
      "  (no single feedback cluster to anchor on — pursuits reported only, nothing deleted)",
    );
  }
}

// ── Phase 2: bid_invitations — self-contained acme-gc predicate ─────────────

async function profileInvitations(db: Db, plan: PurgePlan): Promise<void> {
  const invitations = await db.execute(sql`
    SELECT b.id, b.estimator_email, b.invitation_status, b.source_message_id, b.created_at::date AS created,
           (SELECT count(*)::int FROM bid_invitation_events e WHERE e.bid_invitation_id = b.id) AS events,
           (SELECT count(*)::int FROM bid_documents d WHERE d.bid_invitation_id = b.id) AS documents,
           m.sender, m.subject
    FROM bid_invitations b
    LEFT JOIN inbound_messages m ON m.id = b.source_message_id
    WHERE b.${E2E_INVITATION_PREDICATE}
    ORDER BY b.created_at`);
  const rows = invitations.rows as Row[];
  const total = await db.execute(sql`SELECT count(*)::int AS n FROM bid_invitations`);
  console.log(
    `\nbid_invitations        ${rows.length} of ${(total.rows[0] as { n: number }).n} rows match acme-gc:`,
  );
  for (const r of rows) {
    console.log(
      `  ${r["id"]}  ${r["estimator_email"]}  status=${r["invitation_status"]}  created=${r["created"]}` +
        `  events=${r["events"]} docs=${r["documents"]}  msg="${r["subject"] ?? "—"}" from ${r["sender"] ?? "—"}`,
    );
    if (r["source_message_id"] !== null) {
      plan.inboundMessageIds.push(r["source_message_id"] as string);
    }
  }

  // Orphaned acme-gc messages: a prior --apply that failed AFTER the
  // invitation delete leaves the parent message with no invitation to find it
  // through, so the join above yields nothing. The sender predicate is the
  // fallback anchor; NOT EXISTS keeps it to true orphans.
  const orphans = await db.execute(sql`
    SELECT m.id, m.sender, m.subject
    FROM inbound_messages m
    WHERE m.sender ILIKE '%acme-gc%'
      AND NOT EXISTS (SELECT 1 FROM bid_invitations b WHERE b.source_message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM bid_invitation_events e WHERE e.source_message_id = m.id)`);
  for (const r of orphans.rows as Row[]) {
    console.log(`  orphaned message ${r["id"]}  "${r["subject"] ?? "—"}" from ${r["sender"]}  ← CANDIDATE`);
    plan.inboundMessageIds.push(r["id"] as string);
  }
}

// ── Apply — children before parents, nothing on any refusal ─────────────────

async function applyDeletes(db: Db, plan: PurgePlan): Promise<void> {
  const counts: string[] = [];
  const del = async (label: string, query: ReturnType<typeof sql>): Promise<void> => {
    const res = await db.execute(query);
    counts.push(`${label} ${res.rowCount ?? 0}`);
  };

  await del("claim_corrections", sql`DELETE FROM claim_corrections WHERE reason = 'e2e'`);
  await del("opportunity_outcomes", sql`DELETE FROM opportunity_outcomes WHERE ${E2E_OUTCOME_PREDICATE}`);

  if (plan.feedbackOpportunityId !== null) {
    const opp = plan.feedbackOpportunityId;
    await del("feedback", sql`DELETE FROM feedback WHERE opportunity_id = ${opp}`);
    // Pursuit residue, children first. The subquery repeats the anchor rather
    // than pinning ids, so the delete and the profile agree by construction.
    const candidatePursuits = sql`(SELECT id FROM pursuits WHERE opportunity_id = ${opp})`;
    await del("roi_events", sql`DELETE FROM roi_events WHERE pursuit_id IN ${candidatePursuits}`);
    await del("pursuit_transitions", sql`DELETE FROM pursuit_transitions WHERE pursuit_id IN ${candidatePursuits}`);
    await del("pursuit_tasks", sql`DELETE FROM pursuit_tasks WHERE pursuit_id IN ${candidatePursuits}`);
    await del("pursuit_notes", sql`DELETE FROM pursuit_notes WHERE pursuit_id IN ${candidatePursuits}`);
    await del("pursuits", sql`DELETE FROM pursuits WHERE opportunity_id = ${opp}`);
  }

  const candidateInvitations = sql`(SELECT id FROM bid_invitations WHERE ${E2E_INVITATION_PREDICATE})`;
  await del("bid_invitation_events", sql`DELETE FROM bid_invitation_events WHERE bid_invitation_id IN ${candidateInvitations}`);
  await del("bid_documents", sql`DELETE FROM bid_documents WHERE bid_invitation_id IN ${candidateInvitations}`);
  await del("bid_invitations", sql`DELETE FROM bid_invitations WHERE ${E2E_INVITATION_PREDICATE}`);
  if (plan.inboundMessageIds.length > 0) {
    // Parents of the invitations just deleted — captured before the delete
    // because the join predicate no longer exists. NOT EXISTS guards the case
    // where another (kept) invitation or event shares the message. One param
    // per id, NOT a JS-array param: drizzle hands an array to pg as a plain
    // string and Postgres's array_in rejects it (22P02) — measured, this
    // statement failed exactly that way on 2026-07-28.
    const idList = sql.join(
      plan.inboundMessageIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await del(
      "inbound_messages",
      sql`DELETE FROM inbound_messages m
          WHERE m.id IN (${idList})
            AND NOT EXISTS (SELECT 1 FROM bid_invitations b WHERE b.source_message_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM bid_invitation_events e WHERE e.source_message_id = m.id)`,
    );
  }

  console.log(`\nDeleted: ${counts.join(", ")}.\n`);
}

async function main(): Promise<void> {
  const pool = createPool();
  const db = createDb(pool);
  const plan: PurgePlan = { feedbackOpportunityId: null, inboundMessageIds: [], refusals: [] };

  const banner = APPLY ? "APPLY — rows WILL be deleted" : "DRY RUN — nothing will be deleted";
  console.log(`\n=== purge-e2e-rows (${banner}) ===\n`);

  await reportCorrections(db);
  await reportOutcomes(db);
  await profileFeedback(db, plan);
  await profilePursuits(db, plan);
  await profileInvitations(db, plan);

  if (plan.refusals.length > 0) {
    console.log(`\nREFUSED — the profile this purge was approved against no longer holds:`);
    for (const r of plan.refusals) console.log(`  • ${r}`);
    console.log(APPLY ? "\nNothing was deleted. Re-review before running --apply again.\n" : "");
    await pool.end();
    if (APPLY) process.exit(1);
    return;
  }

  if (!APPLY) {
    console.log(
      [
        "",
        "Nothing was deleted.",
        "",
        "Review the candidate rows above. When they are confirmed as test output,",
        "re-run with --apply. `feedback` is a scoring-calibration input, so this",
        "purge needs an explicit owner decision even though the cluster profile",
        "marks every row as synthetic.",
        "",
      ].join("\n"),
    );
    await pool.end();
    return;
  }

  await applyDeletes(db, plan);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
