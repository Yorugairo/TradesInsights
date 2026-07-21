import { modelRuns, type Db } from "@otn/db";

/**
 * model_runs persistence shared by every model job type (extraction,
 * verification, …). Every attempt — succeeded, rejected, blocked, error —
 * writes a row: the table is both the §13 audit trail and the budget ledger.
 */

export interface ModelRunRow {
  jobType: string;
  /** The project a run is about, when it is about one. Account-scoped jobs that
   * span many projects (e.g. assistant_query, which answers over the whole
   * account's opportunities) leave this null — the run is keyed by account, not
   * project. */
  projectId?: string | null;
  /** Set for account-scoped jobs (e.g. brief_draft) so two accounts holding
   * opportunities on the same project keep distinct runs. Null otherwise. */
  accountProfileId?: string;
  provider: string;
  model: string;
  promptVersion: string;
  status: "succeeded" | "rejected" | "blocked" | "error";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  resultHash?: string;
  resultJson?: unknown;
  error?: string;
}

export async function persistModelRun(db: Db, row: ModelRunRow): Promise<string> {
  const [inserted] = await db
    .insert(modelRuns)
    .values({
      jobType: row.jobType,
      projectId: row.projectId ?? null,
      accountProfileId: row.accountProfileId ?? null,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      inputTokens: row.inputTokens ?? null,
      outputTokens: row.outputTokens ?? null,
      costUsd: row.costUsd ?? null,
      latencyMs: row.latencyMs ?? null,
      resultHash: row.resultHash ?? null,
      resultJson: row.resultJson ?? null,
      status: row.status,
      error: row.error ?? null,
    })
    .returning({ id: modelRuns.id });
  return inserted!.id;
}
