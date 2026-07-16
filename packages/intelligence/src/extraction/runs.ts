import { modelRuns, type Db } from "@otn/db";

/**
 * model_runs persistence shared by every model job type (extraction,
 * verification, …). Every attempt — succeeded, rejected, blocked, error —
 * writes a row: the table is both the §13 audit trail and the budget ledger.
 */

export interface ModelRunRow {
  jobType: string;
  projectId: string;
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
      projectId: row.projectId,
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
