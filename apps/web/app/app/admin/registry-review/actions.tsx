"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Accept/reject one registry observation (Increment 3 review gate). */
export function ObservationDecision({ observationId }: { observationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "accept" | "reject") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/registry-observations/${observationId}/decision`, {
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
      <button disabled={busy} onClick={() => decide("accept")} data-testid="obs-accept">
        Accept
      </button>{" "}
      <button disabled={busy} onClick={() => decide("reject")} data-testid="obs-reject">
        Reject
      </button>{" "}
      <input placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 110 }} />
      {error && <small style={{ color: "crimson", marginLeft: "0.3rem" }}>{error}</small>}
    </span>
  );
}
