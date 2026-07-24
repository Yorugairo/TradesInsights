import Link from "next/link";
import { redirect } from "next/navigation";
import { listPendingReviews, triageReviewQueue } from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { cell, fmtDate, table } from "../../../../lib/ui.js";
import { ClusterDecision, ReviewDecision } from "./actions.js";

export const dynamic = "force-dynamic";

export default async function AdminReviewPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");
  const reviews = await listPendingReviews(db());
  const clusters = await triageReviewQueue(db());
  const pendingTotal = clusters.reduce((n, c) => n + c.count, 0);

  return (
    <main>
      <p>
        <Link href="/app/admin/cockpit">← cockpit</Link>
      </p>
      <h1>Resolution review queue</h1>
      <p>
        Ambiguous matches held for a human decision (spec §10). Merge joins the record to the
        candidate project; reject re-resolves the record with that candidate excluded.
      </p>

      <h2>
        Triage clusters — {pendingTotal} pending across {clusters.length} patterns
      </h2>
      <p style={{ color: "#666" }}>
        One row per (rule, reason, candidate project). Bulk decisions apply the same per-review
        provenance as deciding rows one at a time. Bulk <em>reject</em> is the safe mass action
        (each record re-resolves with the candidate excluded); bulk <em>merge</em> joins every
        record to the candidate — use it only when the samples clearly belong to it.
      </p>
      <table style={table} data-testid="triage-table">
        <thead>
          <tr>
            <th style={cell}>Count</th>
            <th style={cell}>Rule / reason</th>
            <th style={cell}>Candidate project</th>
            <th style={cell}>Score range</th>
            <th style={cell}>Sample records</th>
            <th style={cell}>Bulk decision</th>
          </tr>
        </thead>
        <tbody>
          {clusters.slice(0, 100).map((c, i) => (
            <tr key={i}>
              <td style={{ ...cell, fontWeight: 600 }}>{c.count}</td>
              <td style={cell}>
                {c.matchedRule}
                <br />
                <small>{c.reasonKey || "—"}</small>
              </td>
              <td style={cell}>
                {c.candidateProjectId ? (
                  <Link href={`/app/projects/${c.candidateProjectId}`}>
                    {c.candidateName ?? c.candidateProjectId.slice(0, 8)}
                  </Link>
                ) : (
                  "—"
                )}
                {c.candidateCounty ? <small> · {c.candidateCounty}</small> : null}
              </td>
              <td style={cell}>
                {c.minScore.toFixed(2)}–{c.maxScore.toFixed(2)}
              </td>
              <td style={cell}>
                {c.sampleTitles.map((t, j) => (
                  <div key={j}>
                    <small>{t.slice(0, 80)}</small>
                  </div>
                ))}
              </td>
              <td style={cell}>
                <ClusterDecision
                  matchedRule={c.matchedRule}
                  reasonKey={c.reasonKey}
                  candidateProjectId={c.candidateProjectId}
                  count={c.count}
                />
              </td>
            </tr>
          ))}
          {clusters.length === 0 && (
            <tr>
              <td style={cell} colSpan={6}>
                Queue is empty.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Individual reviews (oldest 100)</h2>
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
