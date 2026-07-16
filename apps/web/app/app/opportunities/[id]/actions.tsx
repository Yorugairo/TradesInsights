"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StateButtons({ opportunityId, state }: { opportunityId: string; state: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");

  async function setState(next: "promoted" | "dismissed" | "rescore") {
    setBusy(true);
    await fetch(`/api/app/opportunities/${opportunityId}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: next, ...(reason ? { reason } : {}) }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
      <button disabled={busy || state === "promoted"} onClick={() => setState("promoted")}>
        Promote
      </button>
      <button disabled={busy || state === "dismissed"} onClick={() => setState("dismissed")} data-testid="dismiss-btn">
        Dismiss
      </button>
      <input
        placeholder="dismissal reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ width: 220 }}
      />
      {(state === "promoted" || state === "dismissed") && (
        <button disabled={busy} onClick={() => setState("rescore")}>
          Return to scoring bands
        </button>
      )}
    </div>
  );
}

export function FeedbackForm({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [answers, setAnswers] = useState<Record<string, boolean | null>>({
    relevant: null,
    newToCustomer: null,
    timely: null,
    worthPursuing: null,
  });
  const [notes, setNotes] = useState("");

  function TriState({ field, label }: { field: string; label: string }) {
    const v = answers[field];
    return (
      <label style={{ marginRight: "1rem" }}>
        {label}{" "}
        <select
          value={v === null ? "" : String(v)}
          onChange={(e) =>
            setAnswers((a) => ({ ...a, [field]: e.target.value === "" ? null : e.target.value === "true" }))
          }
        >
          <option value="">—</option>
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      </label>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch(`/api/app/opportunities/${opportunityId}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...answers, notes: notes || null }),
    });
    setBusy(false);
    setSaved(res.ok);
    router.refresh();
  }

  return (
    <form onSubmit={submit} data-testid="feedback-form">
      <TriState field="relevant" label="Relevant?" />
      <TriState field="newToCustomer" label="New to you?" />
      <TriState field="timely" label="Timely?" />
      <TriState field="worthPursuing" label="Worth pursuing?" />
      <div style={{ margin: "0.5rem 0" }}>
        <input
          placeholder="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ width: "60%" }}
        />
      </div>
      <button type="submit" disabled={busy}>
        Save feedback
      </button>
      {saved && <span style={{ marginLeft: "0.5rem", color: "green" }}>saved</span>}
    </form>
  );
}
