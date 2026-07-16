import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { jsonError, withAdmin } from "../../../../../../lib/api.js";

const bodySchema = z.object({ enabled: z.boolean().default(false), note: z.string().max(500).optional() });

// POST /api/admin/sources/{key}/disable — flips sources.enabled (and records
// the operator note on the coverage entry). Raw artifacts stay immutable;
// disabling only stops future runs.
export const POST = withAdmin<{ key: string }>(async ({ db, params, req }) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError(400, "invalid body");
  const updated = await db.execute(sql`
    UPDATE sources SET enabled = ${parsed.data.enabled} WHERE key = ${params.key} RETURNING id`);
  if (updated.rows.length === 0) return jsonError(404, "unknown source key");
  const sourceId = (updated.rows[0] as { id: string }).id;
  await db.execute(sql`
    UPDATE coverage_entries
    SET status = ${parsed.data.enabled ? "enabled" : "disabled"},
        notes = COALESCE(${parsed.data.note ?? null}, notes)
    WHERE source_id = ${sourceId}`);
  return NextResponse.json({ ok: true, enabled: parsed.data.enabled });
});
