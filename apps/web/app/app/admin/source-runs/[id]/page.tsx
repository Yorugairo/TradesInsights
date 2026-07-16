import { notFound, redirect } from "next/navigation";
import { currentSession } from "../../../../../lib/auth.js";
import { db } from "../../../../../lib/db.js";
import { sourceRunDetail } from "../../../../../lib/queries.js";
import { fmtDate } from "../../../../../lib/ui.js";

export const dynamic = "force-dynamic";

export default async function SourceRunPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");
  const { id } = await params;
  const run = await sourceRunDetail(db(), id);
  if (!run) notFound();

  return (
    <main>
      <h1>
        Source run — {run["source_key"] as string} ({run["status"] as string})
      </h1>
      <p>
        Started {fmtDate(run["started_at"] as string)} · completed {fmtDate(run["completed_at"] as string | null)} ·
        artifacts {String(run["artifact_count"])}
      </p>
      <p>
        discovered {String(run["discovered_count"])} · fetched {String(run["fetched_count"])} · unchanged{" "}
        {String(run["unchanged_count"])} · parsed {String(run["parsed_count"])} · rejected{" "}
        {String(run["rejected_count"])} · duplicate {String(run["duplicate_count"])} · errors{" "}
        {String(run["error_count"])}
      </p>
      <h2>Metrics / dead letters</h2>
      <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: "0.5rem" }}>
        {JSON.stringify(run["metrics_json"], null, 2)}
      </pre>
      <h2>Checkpoint</h2>
      <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: "0.5rem" }}>
        {JSON.stringify(run["checkpoint_json"], null, 2)}
      </pre>
    </main>
  );
}
