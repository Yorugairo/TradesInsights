import { sql } from "drizzle-orm";
import type { Db } from "@otn/db";
import { evaluateGate } from "./gate/gate.js";

/**
 * S2 (strengthening addendum §4) — the pursuit pipeline state machine. Every
 * transition is validated and audited server-side; states that represent a
 * human commitment (estimating, submitted, won, lost, no_bid) can NEVER be
 * entered by an AI job. Outcomes require a reason and date. Nothing here is a
 * model call — it is deterministic operational control.
 */

export const PURSUIT_STATES = [
  "discovered", "qualified", "relationship_target", "bid_confirmed",
  "bid_decision_pending", "estimating", "submitted", "won", "lost",
  "no_bid", "follow_up", "archived",
] as const;
export type PursuitState = (typeof PURSUIT_STATES)[number];

export type ActorType = "human" | "ai" | "system";

/** Allowed forward transitions (spec §4). Every active pre-submission state can
 * also go to no_bid or archived; archived is terminal. */
const TRANSITIONS: Record<PursuitState, PursuitState[]> = {
  discovered: ["qualified", "no_bid", "archived"],
  qualified: ["relationship_target", "bid_confirmed", "no_bid", "archived"],
  relationship_target: ["bid_confirmed", "no_bid", "archived"],
  bid_confirmed: ["bid_decision_pending", "no_bid", "archived"],
  bid_decision_pending: ["estimating", "no_bid", "archived"],
  estimating: ["submitted", "no_bid", "archived"],
  submitted: ["won", "lost", "archived"],
  won: ["follow_up", "archived"],
  lost: ["follow_up", "archived"],
  no_bid: ["follow_up", "archived"],
  follow_up: ["archived"],
  archived: [],
};

/** States a human must move into — an AI/system job may never trigger these. */
const HUMAN_ONLY: ReadonlySet<PursuitState> = new Set<PursuitState>([
  "estimating", "submitted", "won", "lost", "no_bid",
]);

/** Required task types (spec §4). */
export const PURSUIT_TASK_TYPES = [
  "verify_gc", "verify_bid_status", "identify_estimator_contact",
  "check_account_relationship", "review_capacity", "review_public_work_eligibility",
  "attend_job_walk", "bid_no_bid_decision", "follow_up_after_submission",
] as const;
export type PursuitTaskType = (typeof PURSUIT_TASK_TYPES)[number];

export class PursuitError extends Error {
  constructor(
    public code:
      | "not_found"
      | "invalid_transition"
      | "human_required"
      | "missing_reason"
      | "missing_outcome_date"
      | "missing_submission"
      | "missing_follow_up"
      | "not_qualifiable"
      | "invalid_task_type",
    message: string,
  ) {
    super(message);
    this.name = "PursuitError";
  }
}

export interface TransitionInput {
  actorType: ActorType;
  actorId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

interface PursuitRow {
  id: string;
  account_profile_id: string;
  opportunity_id: string;
  state: PursuitState;
  owner_user_id: string;
}

async function loadPursuit(db: Db, pursuitId: string): Promise<PursuitRow | null> {
  const res = await db.execute(sql`SELECT * FROM pursuits WHERE id = ${pursuitId}`);
  return (res.rows[0] as PursuitRow | undefined) ?? null;
}

/** Start a pursuit at `discovered` for an opportunity (records the opening transition). */
export async function createPursuit(
  db: Db,
  input: { accountProfileId: string; opportunityId: string; ownerUserId: string; priority?: number | null },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO pursuits (account_profile_id, opportunity_id, state, owner_user_id, priority)
    VALUES (${input.accountProfileId}, ${input.opportunityId}, 'discovered', ${input.ownerUserId},
      ${input.priority ?? null})
    RETURNING id`);
  const id = (res.rows[0] as { id: string }).id;
  await db.execute(sql`
    INSERT INTO pursuit_transitions (pursuit_id, from_state, to_state, actor_type, actor_id, reason)
    VALUES (${id}, NULL, 'discovered', 'human', ${input.ownerUserId}, 'pursuit opened')`);
  return { id };
}

/**
 * Validate + apply a state transition, recording an audit row. Throws
 * PursuitError on any invalid move, an AI attempt at a human-only state, or
 * missing required data (reason / outcome date / submission / follow-up).
 */
export async function transitionPursuit(
  db: Db,
  pursuitId: string,
  to: PursuitState,
  input: TransitionInput,
): Promise<void> {
  const p = await loadPursuit(db, pursuitId);
  if (!p) throw new PursuitError("not_found", `pursuit ${pursuitId} not found`);
  const from = p.state;

  if (!TRANSITIONS[from]?.includes(to)) {
    throw new PursuitError("invalid_transition", `cannot move a pursuit from ${from} to ${to}`);
  }
  if (HUMAN_ONLY.has(to) && input.actorType !== "human") {
    throw new PursuitError("human_required", `${to} requires a human decision, not an ${input.actorType} actor`);
  }

  const meta = input.metadata ?? {};
  if (to === "qualified") {
    const gate = await evaluateGate(db, p.opportunity_id);
    // "Passed evidence gate and account threshold": the deterministic gate
    // checks (identity, A-grade event, score threshold, health, timing) must
    // not fail. A verifier block (no model keys) does not bar qualification —
    // that gates publication, not pursuit.
    if (!gate || gate.status === "fail") {
      throw new PursuitError("not_qualifiable", "opportunity has not passed the evidence gate / account threshold");
    }
  }
  if ((to === "no_bid" || to === "won" || to === "lost") && !input.reason?.trim()) {
    throw new PursuitError("missing_reason", `${to} requires a reason`);
  }
  if ((to === "won" || to === "lost") && !meta["outcomeDate"]) {
    throw new PursuitError("missing_outcome_date", `${to} requires an outcome date`);
  }
  if (to === "submitted" && !meta["submittedAt"]) {
    throw new PursuitError("missing_submission", "submitted requires a submission timestamp");
  }
  if (to === "follow_up" && (!meta["followUpOwner"] || !meta["followUpDate"])) {
    throw new PursuitError("missing_follow_up", "follow_up requires an owner and a date");
  }

  // Value side-effects (deterministic mapping from the transition metadata).
  const valueCol =
    to === "estimating" ? "estimated_contract_value"
    : to === "submitted" ? "submitted_value"
    : to === "won" || to === "lost" ? "outcome_value"
    : null;
  const value = typeof meta["value"] === "number" ? (meta["value"] as number) : null;
  const nextActionAt = typeof meta["nextActionAt"] === "string" ? (meta["nextActionAt"] as string) : null;

  await db.execute(sql`
    INSERT INTO pursuit_transitions (pursuit_id, from_state, to_state, actor_type, actor_id, reason, metadata_json)
    VALUES (${pursuitId}, ${from}, ${to}, ${input.actorType}, ${input.actorId ?? null},
      ${input.reason ?? null}, ${JSON.stringify(meta)})`);

  await db.execute(sql`
    UPDATE pursuits SET
      state = ${to},
      updated_at = now(),
      closed_at = CASE WHEN ${to} = 'archived' THEN now() ELSE closed_at END,
      next_action_at = COALESCE(${nextActionAt}, next_action_at)
    WHERE id = ${pursuitId}`);
  // Value side-effects are a separate assignment (Postgres forbids assigning a
  // column twice in one UPDATE).
  if (valueCol && value !== null) {
    await db.execute(sql`UPDATE pursuits SET ${sql.raw(valueCol)} = ${value} WHERE id = ${pursuitId}`);
  }
}

export async function addPursuitTask(
  db: Db,
  pursuitId: string,
  input: { title: string; taskType: string; ownerUserId?: string | null; dueAt?: string | null },
): Promise<{ id: string }> {
  if (!(PURSUIT_TASK_TYPES as readonly string[]).includes(input.taskType)) {
    throw new PursuitError("invalid_task_type", `unknown task type ${input.taskType}`);
  }
  const res = await db.execute(sql`
    INSERT INTO pursuit_tasks (pursuit_id, title, task_type, owner_user_id, due_at)
    VALUES (${pursuitId}, ${input.title}, ${input.taskType}, ${input.ownerUserId ?? null}, ${input.dueAt ?? null})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

export async function addPursuitNote(
  db: Db,
  pursuitId: string,
  input: { authorUserId: string; body: string; visibility?: string },
): Promise<{ id: string }> {
  const res = await db.execute(sql`
    INSERT INTO pursuit_notes (pursuit_id, author_user_id, body, visibility)
    VALUES (${pursuitId}, ${input.authorUserId}, ${input.body}, ${input.visibility ?? "account"})
    RETURNING id`);
  return { id: (res.rows[0] as { id: string }).id };
}

export interface PursuitSummary {
  id: string;
  opportunityId: string;
  projectName: string;
  state: PursuitState;
  ownerUserId: string;
  priority: number | null;
  nextActionAt: string | null;
  openTasks: number;
  overdue: boolean;
}

export interface PursuitDetail {
  id: string;
  accountProfileId: string;
  opportunityId: string;
  projectName: string;
  state: PursuitState;
  ownerUserId: string;
  priority: number | null;
  nextActionAt: string | null;
  closedAt: string | null;
  estimatedContractValue: number | null;
  submittedValue: number | null;
  outcomeValue: number | null;
  allowedTransitions: PursuitState[];
  transitions: { fromState: string | null; toState: string; actorType: string; actorId: string | null; reason: string | null; createdAt: string }[];
  tasks: { id: string; title: string; taskType: string; ownerUserId: string | null; dueAt: string | null; status: string }[];
  notes: { authorUserId: string; body: string; createdAt: string }[];
}

/** Full pursuit detail (account_profile_id included so routes can enforce isolation). */
export async function getPursuitDetail(db: Db, pursuitId: string): Promise<PursuitDetail | null> {
  const res = await db.execute(sql`
    SELECT pu.*, p.canonical_name AS project_name
    FROM pursuits pu JOIN opportunities o ON o.id = pu.opportunity_id
    JOIN projects p ON p.id = o.project_id WHERE pu.id = ${pursuitId}`);
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  const [tr, tk, nt] = await Promise.all([
    db.execute(sql`SELECT from_state, to_state, actor_type, actor_id, reason, created_at FROM pursuit_transitions WHERE pursuit_id = ${pursuitId} ORDER BY created_at ASC`),
    db.execute(sql`SELECT id, title, task_type, owner_user_id, due_at, status FROM pursuit_tasks WHERE pursuit_id = ${pursuitId} ORDER BY created_at ASC`),
    db.execute(sql`SELECT author_user_id, body, created_at FROM pursuit_notes WHERE pursuit_id = ${pursuitId} ORDER BY created_at DESC`),
  ]);
  const state = r["state"] as PursuitState;
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: r["id"] as string,
    accountProfileId: r["account_profile_id"] as string,
    opportunityId: r["opportunity_id"] as string,
    projectName: r["project_name"] as string,
    state,
    ownerUserId: r["owner_user_id"] as string,
    priority: num(r["priority"]),
    nextActionAt: (r["next_action_at"] as string | null) ?? null,
    closedAt: (r["closed_at"] as string | null) ?? null,
    estimatedContractValue: num(r["estimated_contract_value"]),
    submittedValue: num(r["submitted_value"]),
    outcomeValue: num(r["outcome_value"]),
    allowedTransitions: TRANSITIONS[state] ?? [],
    transitions: (tr.rows as Record<string, unknown>[]).map((x) => ({
      fromState: (x["from_state"] as string | null) ?? null,
      toState: x["to_state"] as string,
      actorType: x["actor_type"] as string,
      actorId: (x["actor_id"] as string | null) ?? null,
      reason: (x["reason"] as string | null) ?? null,
      createdAt: x["created_at"] as string,
    })),
    tasks: (tk.rows as Record<string, unknown>[]).map((x) => ({
      id: x["id"] as string,
      title: x["title"] as string,
      taskType: x["task_type"] as string,
      ownerUserId: (x["owner_user_id"] as string | null) ?? null,
      dueAt: (x["due_at"] as string | null) ?? null,
      status: x["status"] as string,
    })),
    notes: (nt.rows as Record<string, unknown>[]).map((x) => ({
      authorUserId: x["author_user_id"] as string,
      body: x["body"] as string,
      createdAt: x["created_at"] as string,
    })),
  };
}

/** Account-scoped pursuit list for the board (list + Kanban share this). */
export async function listPursuits(
  db: Db,
  accountProfileId: string,
  opts: { state?: PursuitState } = {},
): Promise<PursuitSummary[]> {
  const stateFilter = opts.state ? sql`AND pu.state = ${opts.state}` : sql``;
  const res = await db.execute(sql`
    SELECT pu.id, pu.opportunity_id, p.canonical_name AS project_name, pu.state,
      pu.owner_user_id, pu.priority, pu.next_action_at,
      (SELECT count(*) FROM pursuit_tasks t WHERE t.pursuit_id = pu.id AND t.status = 'open') AS open_tasks,
      (pu.next_action_at IS NOT NULL AND pu.next_action_at < now() AND pu.state != 'archived') AS overdue
    FROM pursuits pu
    JOIN opportunities o ON o.id = pu.opportunity_id
    JOIN projects p ON p.id = o.project_id
    WHERE pu.account_profile_id = ${accountProfileId} ${stateFilter}
    ORDER BY pu.priority DESC NULLS LAST, pu.next_action_at ASC NULLS LAST`);
  return (res.rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    opportunityId: r["opportunity_id"] as string,
    projectName: r["project_name"] as string,
    state: r["state"] as PursuitState,
    ownerUserId: r["owner_user_id"] as string,
    priority: r["priority"] === null ? null : Number(r["priority"]),
    nextActionAt: (r["next_action_at"] as string | null) ?? null,
    openTasks: Number(r["open_tasks"] ?? 0),
    overdue: Boolean(r["overdue"]),
  }));
}
