import Link from "next/link";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import PageHeader from "../../../components/ui/PageHeader.js";
import Table, { HeadTr, Td, Th, Tr } from "../../../components/ui/Table.js";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { formatValuation, stageLabel } from "../../../lib/format.js";
import { accountByKey } from "../../../lib/queries.js";
import { Badge, fmtDate } from "../../../lib/ui.js";

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
      <PageHeader
        title="Radar"
        description={
          // `radar-summary` is asserted to contain "early-stage" (app.spec.ts:299),
          // so that phrasing is load-bearing, not decorative.
          <span data-testid="radar-summary">
            {rows.length} early-stage projects routed to {account.name} (pre-application /
            entitlement / SEPA). This is the 3–9-months-ahead pipeline — plan relationships now,
            bid later.
          </span>
        }
      />

      {/*
        The table is rendered unconditionally: `radar-table` is asserted VISIBLE,
        so swapping it for an EmptyState would fail the gate. The empty case
        therefore lives inside the tbody — still with a reason, never a blank.
      */}
      <Table
        data-testid="radar-table"
        caption="Early-stage projects routed to this account"
        head={
          <HeadTr>
            <Th>Project</Th>
            <Th>Stage</Th>
            <Th>County / Jurisdiction</Th>
            <Th numeric>Stated valuation</Th>
            <Th>Last movement</Th>
          </HeadTr>
        }
      >
        {rows.map((r) => (
          <Tr key={r["id"] as string}>
            <Td>
              <Link
                href={`/app/opportunities/${r["id"] as string}`}
                className="font-semibold text-ink underline decoration-line-strong underline-offset-2"
              >
                {r["canonical_name"] as string}
              </Link>{" "}
              {(r["campus_block"] as string | null) && <Badge tone="green">campus</Badge>}
            </Td>
            <Td>{stageLabel(r["current_stage"] as string)}</Td>
            <Td>
              {r["county"] as string} / {r["permitting_jurisdiction"] as string}
            </Td>
            {/* Absent valuation is an em dash, not $0 — nobody stated a number. */}
            <Td numeric>
              {formatValuation(r["max_valuation"] === null ? null : Number(r["max_valuation"]))}
            </Td>
            <Td className="whitespace-nowrap tabular-nums">
              {fmtDate(r["last_material_change_at"] as string | null)}
            </Td>
          </Tr>
        ))}
        {rows.length === 0 && (
          <Tr>
            <Td className="text-ink-muted">
              Nothing on the radar right now — no routed opportunity for this account is at
              concept, pre-application or entitlement. That is a real empty set, not a missing
              feed.
            </Td>
          </Tr>
        )}
      </Table>
    </main>
  );
}
