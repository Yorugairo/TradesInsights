"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
