import PgBoss from "pg-boss";
import type { Logger } from "pino";
import { getAdapter } from "@otn/adapters";
import { createDb, createPool, type Db } from "@otn/db";
import {
  runSource,
  S3ObjectStore,
  s3ConfigFromEnv,
  type RunResult,
} from "@otn/source-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv } from "./env.js";

export const SOURCE_RUN_QUEUE = "source-run";
export const SOURCE_RUN_DEAD_LETTER = "source-run-dead-letter";

export const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
);

export interface SourceRunJob {
  sourceKey: string;
  allowDisabled?: boolean;
  backfill?: { from: string; to: string };
}

export async function createBoss(databaseUrl = process.env.DATABASE_URL): Promise<PgBoss> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const boss = new PgBoss({ connectionString: databaseUrl });
  await boss.start();
  await boss.createQueue(SOURCE_RUN_DEAD_LETTER);
  // Retries with exponential backoff; exhausted jobs land in the dead-letter
  // queue with their payload intact so the failure can be reproduced.
  await boss.createQueue(SOURCE_RUN_QUEUE, {
    name: SOURCE_RUN_QUEUE,
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    deadLetter: SOURCE_RUN_DEAD_LETTER,
  });
  return boss;
}

export async function executeSourceRun(
  db: Db,
  job: SourceRunJob,
  logger: Logger,
): Promise<RunResult> {
  const adapter = getAdapter(job.sourceKey);
  const objectStore = new S3ObjectStore(s3ConfigFromEnv());
  await objectStore.ensureBucket();
  const result = await runSource({
    db,
    adapter,
    objectStore,
    logger,
    fixturesDir: FIXTURES_DIR,
    userAgent: requireEnv("SOURCE_USER_AGENT"),
    ...(job.allowDisabled !== undefined && { allowDisabled: job.allowDisabled }),
    ...(job.backfill && { backfill: job.backfill }),
  });
  if (result.status === "failed") {
    // Throw so pg-boss retries and eventually dead-letters the job.
    throw new Error(`source run failed for ${job.sourceKey}: run ${result.sourceRunId}`);
  }
  return result;
}

export async function registerWorkers(boss: PgBoss, logger: Logger): Promise<void> {
  const pool = createPool();
  const db = createDb(pool);
  await boss.work<SourceRunJob>(SOURCE_RUN_QUEUE, async ([job]) => {
    if (!job) return;
    const jobLogger = logger.child({ jobId: job.id, queue: SOURCE_RUN_QUEUE });
    jobLogger.info({ data: job.data }, "job started");
    await executeSourceRun(db, job.data, jobLogger);
  });
}
