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
    <span style={{ whiteSpace: "nowrap" }}>
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
      <input placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 100 }} />
      {message && <small style={{ marginLeft: "0.3rem" }}>{message}</small>}
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
    <span style={{ whiteSpace: "nowrap" }}>
      <button disabled={busy} onClick={() => decide("merge")}>
        Merge
      </button>{" "}
      <button disabled={busy} onClick={() => decide("reject")}>
        Reject
      </button>{" "}
      <input placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 120 }} />
      {error && <small style={{ color: "crimson", marginLeft: "0.3rem" }}>{error}</small>}
    </span>
  );
}
