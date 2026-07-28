import { notFound, redirect } from "next/navigation";
import { getInvitation } from "@otn/intelligence";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { accountByKey } from "../../../../lib/queries.js";
import { Badge, cell, fmtDate, table } from "../../../../lib/ui.js";

export const dynamic = "force-dynamic";

export default async function InvitationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { id } = await params;
  const inv = await getInvitation(db(), id);
  if (!inv || inv.accountProfileId !== account.id) notFound();
  const s = inv.summary;

  return (
    <main>
      <h1 data-testid="invitation-title">{s.projectName ?? "Unmatched invitation"}</h1>
      <p>
        <Badge tone={s.matchStatus === "matched" ? "green" : s.matchStatus === "review" ? "amber" : "gray"}>
          {s.matchStatus}
        </Badge>{" "}
        · status {s.invitationStatus} · bid due {fmtDate(s.bidDueAt)} · job walk {fmtDate(s.jobWalkAt)}
      </p>
      <p>Scope: {s.scopeSummary ?? "—"} · Estimator: {s.estimatorName ?? "—"}</p>

      <h2>Event history</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>When</th>
            <th style={cell}>Event</th>
            <th style={cell}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {inv.events.map((e, i) => (
            <tr key={i}>
              <td style={cell}>{fmtDate(e.createdAt)}</td>
              <td style={cell}>{e.eventType}</td>
              <td style={cell}>
                <code className="text-xs text-ink-muted">{JSON.stringify(e.metadata)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
