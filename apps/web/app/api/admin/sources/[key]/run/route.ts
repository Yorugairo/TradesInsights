import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import PgBoss from "pg-boss";
import { jsonError, withAdmin } from "../../../../../../lib/api.js";

// Matches apps/worker/src/jobs.ts — the worker owns the queue configuration.
const SOURCE_RUN_QUEUE = "source-run";

// POST /api/admin/sources/{key}/run — enqueue a durable source run for the
// worker to execute (retry/dead-letter handled by the worker's queue config).
export const POST = withAdmin<{ key: string }>(async ({ db, params }) => {
  const exists = await db.execute(sql`SELECT 1 FROM sources WHERE key = ${params.key}`);
  if (exists.rows.length === 0) return jsonError(404, "unknown source key");

  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL! });
  await boss.start();
  try {
    const jobId = await boss.send(SOURCE_RUN_QUEUE, { sourceKey: params.key });
    return NextResponse.json({ ok: true, jobId });
  } finally {
    await boss.stop({ close: true, timeout: 1000 });
  }
});
