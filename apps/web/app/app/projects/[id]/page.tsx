import { notFound, redirect } from "next/navigation";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { accountByKey, accountHasProject, projectDetail } from "../../../../lib/queries.js";
import { Badge, cell, fmtDate, table } from "../../../../lib/ui.js";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await params;

  if (session.role !== "admin") {
    if (!session.accountKey) redirect("/login");
    const account = await accountByKey(db(), session.accountKey);
    if (!account || !(await accountHasProject(db(), account.id, id))) notFound();
  }
  const p = await projectDetail(db(), id);
  if (!p) notFound();

  return (
    <main>
      <h1>{p.name}</h1>
      <p>
        <Badge>{p.county}</Badge> <Badge>{p.permittingJurisdiction}</Badge> <Badge>{p.stage}</Badge>
        {p.developmentName && <> · development: {p.developmentName}</>}
      </p>
      <p>
        Address: {p.address ?? "—"} · Parcels:{" "}
        {Array.isArray(p.parcels) && p.parcels.length > 0 ? (p.parcels as string[]).join(", ") : "—"}
      </p>

      <h2>Source records ({p.records.length})</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>External ID</th>
            <th style={cell}>Type</th>
            <th style={cell}>Title</th>
            <th style={cell}>Source</th>
            <th style={cell}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {p.records.map((r) => (
            <tr key={r.id}>
              <td style={cell}>{r.externalId}</td>
              <td style={cell}>{r.recordType}</td>
              <td style={cell}>{r.title ?? "—"}</td>
              <td style={cell}>{r.sourceUrl ? <a href={r.sourceUrl}>{r.sourceName}</a> : r.sourceName}</td>
              <td style={cell}>{fmtDate(r.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Organizations &amp; roles</h2>
      <ul>
        {p.roles.map((r, i) => (
          <li key={i}>
            {r.name} — {r.role ?? "unknown role"}{" "}
            {r.confirmed ? <Badge tone="green">confirmed</Badge> : <Badge tone="amber">unconfirmed</Badge>}
          </li>
        ))}
        {p.roles.length === 0 && <li>none recorded</li>}
      </ul>

      <h2>Timeline</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Date</th>
            <th style={cell}>Event</th>
            <th style={cell}>Stage</th>
            <th style={cell}>Material</th>
          </tr>
        </thead>
        <tbody>
          {p.timeline.map((e, i) => (
            <tr key={i}>
              <td style={cell}>{fmtDate(e.eventDate ?? e.observedAt)}</td>
              <td style={cell}>{e.eventType}</td>
              <td style={cell}>{e.resultingStage ?? "—"}</td>
              <td style={cell}>{e.materialChange ? "yes" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Evidence ({p.evidence.length})</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Fact path</th>
            <th style={cell}>Evidence</th>
            <th style={cell}>Grade</th>
            <th style={cell}>Source</th>
            <th style={cell}>Retrieved</th>
          </tr>
        </thead>
        <tbody>
          {p.evidence.map((ev) => (
            <tr key={ev.id}>
              <td style={cell}>
                <code>{ev.factPath}</code>
              </td>
              <td style={cell}>{ev.evidenceText.slice(0, 240)}</td>
              <td style={cell}>{ev.authorityGrade}</td>
              <td style={cell}>
                <a href={ev.sourceUrl}>{ev.sourceName}</a>
              </td>
              <td style={cell}>{fmtDate(ev.retrievedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
