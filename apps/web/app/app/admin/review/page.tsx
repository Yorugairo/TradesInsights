import Link from "next/link";
import { redirect } from "next/navigation";
import {
  clustersToCover,
  listPendingReviews,
  triageReviewQueue,
  type ReviewCluster,
} from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { cell, fmtDate, table } from "../../../../lib/ui.js";
import { ClusterDecision, ReviewDecision } from "./actions.js";

export const dynamic = "force-dynamic";

const rows = (cs: readonly ReviewCluster[]) => cs.reduce((n, c) => n + c.count, 0);

/**
 * What a blocked cluster is waiting for, in the reviewer's words. `org_evidence`
 * is stamped by `pnpm review reclassify`: the resolver compared the record's
 * TITLE to the candidate project's NAME — neither is a company name — and the
 * project carries no organization to compare instead. No threshold fixes that,
 * so the row is a pipeline job, not a review job.
 */
const AWAITING_COPY: Record<string, string> = {
  org_evidence: "needs an organization on the candidate project — nothing to compare yet",
};
const awaitingCopy = (a: string | null) =>
  (a && AWAITING_COPY[a]) ?? "needs parcel or org evidence";

/** The cluster table, reused by the actionable, singleton and blocked sections. */
function ClusterTable({
  clusters,
  testId,
  decidable,
}: {
  clusters: ReviewCluster[];
  testId: string;
  decidable: boolean;
}) {
  return (
    <table style={table} data-testid={testId}>
      <thead>
        <tr>
          <th style={cell}>Count</th>
          <th style={cell}>Rule / reason</th>
          <th style={cell}>Candidate project</th>
          <th style={cell}>Score range</th>
          <th style={cell}>Sample records</th>
          <th style={cell}>{decidable ? "Bulk decision" : "Blocked on"}</th>
        </tr>
      </thead>
      <tbody>
        {clusters.map((c, i) => (
          <tr key={`${c.matchedRule}:${c.reasonKey}:${c.candidateProjectId ?? "none"}:${i}`}>
            <td style={cell} className="font-semibold">{c.count}</td>
            <td style={cell}>
              {c.matchedRule}
              <br />
              <small>{c.reasons.join(" + ") || c.reasonKey || "—"}</small>
              {c.comparanda === "org_roles" && (
                <>
                  <br />
                  <small className="text-ink-muted">
                    re-checked against the project&apos;s organization names — they agree
                  </small>
                </>
              )}
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
              {decidable ? (
                <ClusterDecision
                  matchedRule={c.matchedRule}
                  reasonKey={c.reasonKey}
                  candidateProjectId={c.candidateProjectId}
                  count={c.count}
                />
              ) : (
                <small className="text-ink-muted">{awaitingCopy(c.awaiting)}</small>
              )}
            </td>
          </tr>
        ))}
        {clusters.length === 0 && (
          <tr>
            <td style={cell} colSpan={6}>
              Nothing here.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function AdminReviewPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");
  const reviews = await listPendingReviews(db());
  const clusters = await triageReviewQueue(db());

  // Split BEFORE sorting so each section is independently ranked by size — the
  // only ordering that makes the queue finite to work through.
  const bySize = (a: ReviewCluster, b: ReviewCluster) => b.count - a.count;
  const decidable = clusters.filter((c) => c.reviewState === "actionable").sort(bySize);
  const blocked = clusters.filter((c) => c.reviewState !== "actionable").sort(bySize);
  // Singletons are a fifth of the rows spread over more than half the clusters —
  // real work, but never the work to do first. Collapsed, not hidden.
  const bulk = decidable.filter((c) => c.count > 1);
  const singletons = decidable.filter((c) => c.count === 1);

  // Named separately from the rest of `blocked` because it is the round-2
  // finding made visible: rows that LOOK decidable (a same-address name
  // mismatch is a real reason) but compare a permit title to a project name.
  const awaitingOrgEvidence = blocked.filter((c) => c.awaiting === "org_evidence");
  const pendingTotal = rows(clusters);
  const half = clustersToCover(decidable, 0.5);
  const eighty = clustersToCover(decidable, 0.8);

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

      <p data-testid="queue-shape">
        <strong>{rows(decidable)}</strong> rows you can decide, in{" "}
        <strong>{decidable.length}</strong> clusters — the largest <strong>{half}</strong> cover
        half of them, <strong>{eighty}</strong> cover 80%.{" "}
        {blocked.length > 0 ? (
          <>
            A further <strong>{rows(blocked)}</strong> rows are waiting on evidence, not on you (see
            below)
            {awaitingOrgEvidence.length > 0 ? (
              <>
                {" "}
                — <strong data-testid="awaiting-org-evidence">{rows(awaitingOrgEvidence)}</strong> of
                them because the candidate project has no organization to compare against
              </>
            ) : null}
            . {pendingTotal} pending in total.
          </>
        ) : null}
      </p>

      <h2>
        Work these first — {rows(bulk)} rows in {bulk.length} clusters
      </h2>
      <p className="max-w-[70ch] text-sm text-ink-muted">
        One row per (rule, reason, candidate project), largest first. Bulk decisions apply the same
        per-review provenance as deciding rows one at a time. Bulk <em>reject</em> is the safe mass
        action (each record re-resolves with the candidate excluded); bulk <em>merge</em> joins
        every record to the candidate — use it only when the samples clearly belong to it.
      </p>
      <ClusterTable clusters={bulk.slice(0, 100)} testId="triage-table" decidable />

      {singletons.length > 0 && (
        <details>
          <summary>
            <strong>{singletons.length}</strong> single-record clusters — one decision each, no
            leverage. Open these once the batches above are cleared.
          </summary>
          <ClusterTable clusters={singletons.slice(0, 200)} testId="singleton-table" decidable />
        </details>
      )}

      {blocked.length > 0 && (
        <details>
          <summary>
            <strong>{rows(blocked)}</strong> rows in {blocked.length} clusters are{" "}
            <strong>not yours to decide yet</strong> — a fuzzy name near a location with no parcel
            or org support. Deciding them by hand is guesswork; they need evidence gathered first.
          </summary>
          <ClusterTable clusters={blocked.slice(0, 100)} testId="blocked-table" decidable={false} />
        </details>
      )}

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
