import Link from "next/link";
import { redirect } from "next/navigation";
import { listPendingReviews } from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { cell, fmtDate, table } from "../../../../lib/ui.js";
import { ReviewDecision } from "./actions.js";

export const dynamic = "force-dynamic";

export default async function AdminReviewPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");
  const reviews = await listPendingReviews(db());

  return (
    <main>
      <h1>Resolution review queue</h1>
      <p>
        Ambiguous matches held for a human decision (spec §10). Merge joins the record to the
        candidate project; reject re-resolves the record with that candidate excluded.
      </p>
      <table style={table} data-testid="review-table">
        <thead>
          <tr>
            <th style={cell}>Record</th>
            <th style={cell}>Candidate project</th>
            <th style={cell}>Rule</th>
            <th style={cell}>Score</th>
            <th style={cell}>Reasons</th>
            <th style={cell}>Created</th>
            <th style={cell}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((r) => (
            <tr key={r.id}>
              <td style={cell}>
                {r.recordSourceUrl ? <a href={r.recordSourceUrl}>{r.recordTitle ?? r.sourceRecordId}</a> : (r.recordTitle ?? r.sourceRecordId)}
              </td>
              <td style={cell}>
                {r.candidateProjectId ? (
                  <Link href={`/app/projects/${r.candidateProjectId}`}>{r.candidateProjectId.slice(0, 8)}…</Link>
                ) : (
                  "—"
                )}
              </td>
              <td style={cell}>{r.matchedRule}</td>
              <td style={cell}>{r.score.toFixed(2)}</td>
              <td style={cell}>{JSON.stringify(r.reasons)}</td>
              <td style={cell}>{fmtDate(r.createdAt)}</td>
              <td style={cell}>
                <ReviewDecision reviewId={r.id} />
              </td>
            </tr>
          ))}
          {reviews.length === 0 && (
            <tr>
              <td style={cell} colSpan={7}>
                Review queue is empty.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
