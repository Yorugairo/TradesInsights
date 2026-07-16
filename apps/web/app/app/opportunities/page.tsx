import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey, listOpportunities } from "../../../lib/queries.js";
import { Badge, cell, fmtDate, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { state } = await searchParams;
  const items = await listOpportunities(db(), account.id, {
    ...(state ? { state } : {}),
    limit: 200,
  });

  return (
    <main>
      <h1>Opportunities — {account.name}</h1>
      <p>
        Filter:{" "}
        {["all", "priority_review", "weekly_digest", "promoted", "dismissed"].map((s) => (
          <Link
            key={s}
            href={s === "all" ? "/app/opportunities" : `/app/opportunities?state=${s}`}
            style={{ marginRight: "0.75rem", fontWeight: (state ?? "all") === s ? "bold" : "normal" }}
          >
            {s.replace("_", " ")}
          </Link>
        ))}
      </p>
      <table style={table} data-testid="opportunities-table">
        <thead>
          <tr>
            <th style={cell}>Project</th>
            <th style={cell}>County</th>
            <th style={cell}>Jurisdiction</th>
            <th style={cell}>Stage</th>
            <th style={cell}>Score</th>
            <th style={cell}>Route</th>
            <th style={cell}>State</th>
            <th style={cell}>Last change</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td style={cell}>
                <Link href={`/app/opportunities/${o.id}`}>{o.projectName}</Link>
              </td>
              <td style={cell}>{o.county}</td>
              <td style={cell}>{o.permittingJurisdiction}</td>
              <td style={cell}>{o.stage}</td>
              <td style={cell}>{o.score ?? "—"}</td>
              <td style={cell}>{o.route ?? "—"}</td>
              <td style={cell}>
                <Badge tone={o.state === "priority_review" ? "green" : o.state === "dismissed" ? "red" : "gray"}>
                  {o.state}
                </Badge>
              </td>
              <td style={cell}>{fmtDate(o.lastMaterialChangeAt)}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td style={cell} colSpan={8}>
                No opportunities in this state.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
