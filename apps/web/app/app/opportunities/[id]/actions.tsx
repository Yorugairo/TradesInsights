"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StateButtons({
  opportunityId,
  state,
  dispositions,
}: {
  opportunityId: string;
  state: string;
  dispositions: readonly string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  async function setState(next: "promoted" | "dismissed" | "rescore") {
    setBusy(true);
    await fetch(`/api/app/opportunities/${opportunityId}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: next,
        ...(next === "dismissed" && reason ? { reason } : {}),
        ...(next === "dismissed" && notes ? { notes } : {}),
      }),
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
      <select value={reason} onChange={(e) => setReason(e.target.value)} data-testid="dismiss-reason">
        <option value="">dismissal reason…</option>
        {dispositions.map((d) => (
          <option key={d} value={d}>
            {d.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <input placeholder="notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ width: 180 }} />
      {(state === "promoted" || state === "dismissed") && (
        <button disabled={busy} onClick={() => setState("rescore")}>
          Return to scoring bands
        </button>
      )}
    </div>
  );
}

export function FeedbackForm({
  opportunityId,
  dispositions,
}: {
  opportunityId: string;
  dispositions: readonly string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [answers, setAnswers] = useState<Record<string, boolean | null>>({
    relevant: null,
    newToCustomer: null,
    timely: null,
    worthPursuing: null,
  });
  const [disposition, setDisposition] = useState("");
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
      body: JSON.stringify({
        ...answers,
        dispositionReason: disposition || null,
        notes: notes || null,
      }),
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
      <div style={{ margin: "0.5rem 0", display: "flex", gap: "0.5rem" }}>
        <select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
          <option value="">disposition…</option>
          {dispositions.map((d) => (
            <option key={d} value={d}>
              {d.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <input
          placeholder="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ width: "50%" }}
        />
      </div>
      <button type="submit" disabled={busy}>
        Save feedback
      </button>
      {saved && <span style={{ marginLeft: "0.5rem", color: "green" }}>saved</span>}
    </form>
  );
}

export function StartPursuitButton({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/app/pursuits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunityId }),
    });
    setBusy(false);
    if (res.ok) {
      const { id } = (await res.json()) as { id: string };
      router.push(`/app/pursuits/${id}`);
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(body.error === undefined ? "could not start pursuit" : body.error);
    }
  }

  return (
    <span>
      <button disabled={busy} onClick={start} data-testid="start-pursuit">
        Start a pursuit
      </button>
      {msg && <span style={{ marginLeft: "0.5rem", color: "#b00" }}>{msg}</span>}
    </span>
  );
}
