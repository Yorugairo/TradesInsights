"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const TASK_TYPES = [
  "verify_gc", "verify_bid_status", "identify_estimator_contact",
  "check_account_relationship", "review_capacity", "review_public_work_eligibility",
  "attend_job_walk", "bid_no_bid_decision", "follow_up_after_submission",
];

export function PursuitActions({
  pursuitId,
  allowedTransitions,
}: {
  pursuitId: string;
  allowedTransitions: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [value, setValue] = useState("");
  const [date, setDate] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // Outcome/submission/follow-up states need extra data; the server enforces it.
  const needsReason = ["no_bid", "won", "lost"].includes(to);
  const needsDate = ["won", "lost", "submitted", "follow_up"].includes(to);

  async function transition() {
    setBusy(true);
    setErr(null);
    const metadata: Record<string, unknown> = {};
    if (value) metadata["value"] = Number(value);
    if (to === "submitted" && date) metadata["submittedAt"] = date;
    if ((to === "won" || to === "lost") && date) metadata["outcomeDate"] = date;
    if (to === "follow_up" && date) {
      metadata["followUpDate"] = date;
      metadata["followUpOwner"] = "account";
    }
    const res = await fetch(`/api/app/pursuits/${pursuitId}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, reason: reason || undefined, metadata }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(((await res.json()) as { error?: string }).error ?? "transition failed");
      return;
    }
    setTo("");
    router.refresh();
  }

  async function addTask(form: FormData) {
    setBusy(true);
    await fetch(`/api/app/pursuits/${pursuitId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: form.get("title"), taskType: form.get("taskType") }),
    });
    setBusy(false);
    router.refresh();
  }

  async function addNote(form: FormData) {
    setBusy(true);
    await fetch(`/api/app/pursuits/${pursuitId}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: form.get("body") }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="grid gap-4">
      <div>
        <h3>Advance state</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select data-testid="transition-to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">move to…</option>
            {allowedTransitions.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          {needsReason && (
            <input placeholder="reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
          {needsDate && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          <input placeholder="value $" value={value} onChange={(e) => setValue(e.target.value)} className="w-24 rounded-sm border border-line-strong bg-surface px-2 py-1 text-sm text-ink" />
          <button disabled={busy || !to} onClick={transition} data-testid="transition-btn">
            Apply
          </button>
        </div>
        {err && (
          <p data-testid="transition-error" className="font-semibold text-bad">
            {err}
          </p>
        )}
      </div>

      <div>
        <h3>Add task</h3>
        <form action={addTask} className="flex flex-wrap gap-2">
          <input name="title" placeholder="task title" required />
          <select name="taskType" required>
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <button disabled={busy}>Add task</button>
        </form>
      </div>

      <div>
        <h3>Add note</h3>
        <form action={addNote} className="flex gap-2">
          <input name="body" placeholder="note" required className="flex-1 rounded-sm border border-line-strong bg-surface px-2 py-1 text-sm text-ink" />
          <button disabled={busy}>Add note</button>
        </form>
      </div>
    </div>
  );
}
