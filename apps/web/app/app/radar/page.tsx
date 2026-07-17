import Link from "next/link";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { Badge, cell, fmtDate, fmtMoney, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

/**
 * P3.2 — the pre-application radar: the account's routed opportunities still
 * at concept/pre-application/entitlement — the 3–9-months-ahead pipeline
 * (Pierce pre-app screenings, SEPA actions, land-use applications). Radar is
 * for planning, not bidding: no contact prompts here.
 */
export default async function RadarPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");

  const res = await db().execute(sql`
    SELECT o.id, p.canonical_name, p.county, p.permitting_jurisdiction, p.current_stage,
      o.current_score, o.last_material_change_at, p.campus_block,
      rec.max_valuation
    FROM opportunities o JOIN projects p ON p.id = o.project_id
    LEFT JOIN LATERAL (
      SELECT max((sr.normalized_json->>'valuationUsd')::numeric)::float AS max_valuation
      FROM record_resolutions rr JOIN source_records sr ON sr.id = rr.source_record_id
      WHERE rr.project_id = p.id AND rr.status = 'active'
    ) rec ON true
    WHERE o.account_profile_id = ${account.id}
      AND o.state != 'dismissed'
      AND p.current_stage IN ('concept', 'preapplication', 'entitlement')
    ORDER BY o.last_material_change_at DESC NULLS LAST
    LIMIT 100`);
  const rows = res.rows as Record<string, unknown>[];

  return (
    <main>
      <h1>Radar — {account.name}</h1>
      <p style={{ color: "#666" }} data-testid="radar-summary">
        {rows.length} early-stage projects routed to you (pre-application / entitlement / SEPA).
        This is the 3–9-months-ahead pipeline — plan relationships now, bid later.
      </p>
      <table style={table} data-testid="radar-table">
        <thead>
          <tr>
            <th style={cell}>Project</th>
            <th style={cell}>Stage</th>
            <th style={cell}>County / Jurisdiction</th>
            <th style={cell}>Stated valuation</th>
            <th style={cell}>Last movement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r["id"] as string}>
              <td style={cell}>
                <Link href={`/app/opportunities/${r["id"] as string}`}>
                  {r["canonical_name"] as string}
                </Link>{" "}
                {(r["campus_block"] as string | null) && <Badge tone="green">campus</Badge>}
              </td>
              <td style={cell}>{(r["current_stage"] as string).replaceAll("_", " ")}</td>
              <td style={cell}>
                {r["county"] as string} / {r["permitting_jurisdiction"] as string}
              </td>
              <td style={cell}>
                {r["max_valuation"] ? fmtMoney(Number(r["max_valuation"])) : "—"}
              </td>
              <td style={cell}>{fmtDate(r["last_material_change_at"] as string | null)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={cell} colSpan={5}>
                Nothing on the radar right now.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
