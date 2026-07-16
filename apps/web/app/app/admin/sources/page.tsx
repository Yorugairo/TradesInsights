import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { listSourcesAdmin } from "../../../../lib/queries.js";
import { Badge, cell, fmtDate, healthTone, table } from "../../../../lib/ui.js";
import { SourceActions } from "./actions.js";

export const dynamic = "force-dynamic";

export default async function AdminSourcesPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");
  const sources = await listSourcesAdmin(db());

  return (
    <main>
      <h1>Sources</h1>
      <table style={table} data-testid="sources-table">
        <thead>
          <tr>
            <th style={cell}>Key</th>
            <th style={cell}>County</th>
            <th style={cell}>Enabled</th>
            <th style={cell}>Health</th>
            <th style={cell}>Last success</th>
            <th style={cell}>Last run</th>
            <th style={cell}>Records</th>
            <th style={cell}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td style={cell}>
                <strong>{s.key}</strong>
                <br />
                <small>{s.name}</small>
              </td>
              <td style={cell}>{s.county ?? "—"}</td>
              <td style={cell}>{s.enabled ? "yes" : "no"}</td>
              <td style={cell}>
                <Badge tone={healthTone(s.freshnessState)}>{s.freshnessState}</Badge>
              </td>
              <td style={cell}>{fmtDate(s.lastSuccessAt)}</td>
              <td style={cell}>
                {s.lastRun ? (
                  <Link href={`/app/admin/source-runs/${s.lastRun.id}`}>
                    {s.lastRun.status} · p{s.lastRun.parsedCount} r{s.lastRun.rejectedCount} e
                    {s.lastRun.errorCount}
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <td style={cell}>{s.recordCount}</td>
              <td style={cell}>
                <SourceActions sourceKey={s.key} enabled={s.enabled} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
