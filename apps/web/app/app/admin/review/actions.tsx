"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Batch3 #1 — bulk decision over one triage cluster. */
export function ClusterDecision({
  matchedRule,
  reasonKey,
  candidateProjectId,
  count,
}: {
  matchedRule: string;
  reasonKey: string;
  candidateProjectId: string | null;
  count: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function decide(decision: "merge" | "reject") {
    if (!window.confirm(`${decision.toUpperCase()} all ${count} pending reviews in this cluster?`)) return;
    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/admin/review-queue/cluster/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchedRule,
        reasonKey,
        candidateProjectId,
        decision,
        ...(note ? { note } : {}),
      }),
    });
    setBusy(false);
    const body = (await res.json().catch(() => null)) as
      | { decided?: number; errors?: unknown[]; error?: string }
      | null;
    if (!res.ok) {
      setMessage(body?.error ?? `failed (${res.status})`);
      return;
    }
    setMessage(`decided ${body?.decided ?? 0}${body?.errors?.length ? `, ${body.errors.length} errors` : ""}`);
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 whitespace-nowrap">
      {candidateProjectId && (
        <>
          <button disabled={busy} onClick={() => decide("merge")} data-testid="cluster-merge">
            Merge all
          </button>{" "}
        </>
      )}
      <button disabled={busy} onClick={() => decide("reject")} data-testid="cluster-reject">
        Reject all
      </button>{" "}
      <input placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} className="w-24 rounded-sm border border-line-strong bg-surface px-1.5 py-0.5 text-xs text-ink" />
      {message && <small className="ml-1 text-ink-muted">{message}</small>}
    </span>
  );
}

export function ReviewDecision({ reviewId }: { reviewId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "merge" | "reject") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/review-queue/${reviewId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `failed (${res.status})`);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 whitespace-nowrap">
      <button disabled={busy} onClick={() => decide("merge")}>
        Merge
      </button>{" "}
      <button disabled={busy} onClick={() => decide("reject")}>
        Reject
      </button>{" "}
      <input placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} className="w-28 rounded-sm border border-line-strong bg-surface px-1.5 py-0.5 text-xs text-ink" />
      {error && <small className="ml-1 font-semibold text-bad">{error}</small>}
    </span>
  );
}
