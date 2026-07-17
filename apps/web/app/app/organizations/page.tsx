import Link from "next/link";
import { redirect } from "next/navigation";
import { orgActivityRollup, relationshipTargets } from "@otn/intelligence";
import { COUNTIES } from "@otn/domain";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { Badge, cell, fmtDate, fmtMoney, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

/**
 * P1 — the GC league table. For a trade sub the org graph IS the product:
 * who keeps running relevant work in your territory, and who doesn't know
 * you yet. Relevance = the router's judgment (projects routed to this
 * account), never a keyword guess.
 */
export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ county?: string; flagged?: string }>;
}) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const params = await searchParams;

  const [rows, targets] = await Promise.all([
    orgActivityRollup(db(), {
      accountProfileId: account.id,
      ...(params.county ? { county: params.county } : {}),
      includeFlagged: params.flagged === "1",
      minProjects: 2,
      limit: 100,
    }),
    relationshipTargets(db(), account.id, { minRelevantProjects: 2, limit: 10 }),
  ]);

  return (
    <main>
      <h1>Organizations — {account.name}</h1>
      <p style={{ color: "#666" }}>
        Who keeps running work that routes to you. Relationship state is yours alone; activity
        comes from the shared record graph (roles, counties, stated valuations).
      </p>

      <h2>Worth meeting ({targets.length})</h2>
      <p style={{ color: "#666" }}>
        Active on ≥2 of your routed projects, no relationship recorded yet. Open one, set its
        state, and it leaves this list.
      </p>
      <table style={table} data-testid="targets-table">
        <tbody>
          {targets.map((t) => (
            <tr key={t.organizationId}>
              <td style={cell}>
                <Link href={`/app/organizations/${t.organizationId}`}>{t.name}</Link>
              </td>
              <td style={cell}>{t.relevantProjects} routed projects</td>
              <td style={cell}>{t.counties.join(", ")}</td>
              <td style={cell}>{t.statedValuationTotal ? fmtMoney(t.statedValuationTotal) : "—"}</td>
            </tr>
          ))}
          {targets.length === 0 && (
            <tr>
              <td style={cell}>No unworked targets right now — the league table below is the long list.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>League table</h2>
      <form method="get" style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "0.5rem 0" }}>
        <select name="county" defaultValue={params.county ?? ""}>
          <option value="">All counties</option>
          {COUNTIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" name="flagged" value="1" defaultChecked={params.flagged === "1"} />{" "}
          include flagged names (placeholders / individuals)
        </label>
        <button type="submit">Apply</button>
      </form>
      <table style={table} data-testid="league-table">
        <thead>
          <tr>
            <th style={cell}>Organization</th>
            <th style={cell}>Routed to you</th>
            <th style={cell}>All projects</th>
            <th style={cell}>90d</th>
            <th style={cell}>Counties</th>
            <th style={cell}>Stated valuation (total / max)</th>
            <th style={cell}>Last activity</th>
            <th style={cell}>Relationship</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.organizationId}>
              <td style={cell}>
                <Link href={`/app/organizations/${o.organizationId}`}>{o.name}</Link>{" "}
                {o.registryRef && <Badge tone="green">registry</Badge>}
                {o.flags.map((f) => (
                  <Badge key={f} tone="amber">
                    {f.replaceAll("_", " ")}
                  </Badge>
                ))}
              </td>
              <td style={{ ...cell, fontWeight: 600 }}>{o.relevantProjects}</td>
              <td style={cell}>{o.projects}</td>
              <td style={cell}>{o.projects90d}</td>
              <td style={cell}>{o.counties.join(", ")}</td>
              <td style={cell}>
                {o.statedValuationTotal ? fmtMoney(o.statedValuationTotal) : "—"}
                {o.statedValuationMax ? ` / ${fmtMoney(o.statedValuationMax)}` : ""}
              </td>
              <td style={cell}>{fmtDate(o.latestActivityAt)}</td>
              <td style={cell}>
                {o.relationshipState ? (
                  <Badge tone={o.relationshipState === "do_not_pursue" || o.relationshipState === "incumbent_blocked" ? "red" : o.relationshipState === "preferred" || o.relationshipState === "active_relationship" ? "green" : "amber"}>
                    {o.relationshipState.replaceAll("_", " ")}
                  </Badge>
                ) : (
                  <Badge tone="gray">not set</Badge>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={cell} colSpan={8} data-testid="orgs-empty">
                No organizations match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
