"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The decision surface. Behaviour is unchanged from the pre-Tailwind version —
 * same endpoints, same payloads, same four testids (`dismiss-btn`,
 * `dismiss-reason`, `feedback-form`, `start-pursuit`). Only the styling moved
 * onto tokens, plus one real fix noted at `TriState`.
 */

const BTN =
  "inline-flex items-center rounded-sm border border-line-strong bg-surface-raised px-3 py-1.5 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex items-center rounded-sm border border-line-strong bg-[image:var(--panel-gold-bg)] px-3 py-1.5 text-sm font-semibold text-accent-ink disabled:cursor-not-allowed disabled:opacity-50";
const FIELD = "rounded-sm border border-line-strong bg-surface px-2 py-1 text-sm text-ink";

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
    <div className="flex flex-wrap items-center gap-2">
      <button
        className={BTN_PRIMARY}
        disabled={busy || state === "promoted"}
        onClick={() => setState("promoted")}
      >
        Promote
      </button>
      <button
        className={BTN}
        disabled={busy || state === "dismissed"}
        onClick={() => setState("dismissed")}
        data-testid="dismiss-btn"
      >
        Dismiss
      </button>
      <select
        className={FIELD}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="dismiss-reason"
      >
        <option value="">dismissal reason…</option>
        {dispositions.map((d) => (
          <option key={d} value={d}>
            {d.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <input
        className={`${FIELD} w-48`}
        placeholder="notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {(state === "promoted" || state === "dismissed") && (
        <button className={BTN} disabled={busy} onClick={() => setState("rescore")}>
          Return to scoring bands
        </button>
      )}
    </div>
  );
}

/**
 * Hoisted out of `FeedbackForm`.
 *
 * It was previously declared inside the component body, so every keystroke in
 * the notes field produced a NEW component type and React unmounted and
 * remounted all four selects — dropping focus mid-interaction. Declaring a
 * component inside a render is the bug; the fix is to not do that.
 */
function TriState({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (next: boolean | null) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-ink-muted">
      {label}
      <select
        className={FIELD}
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}
      >
        <option value="">—</option>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    </label>
  );
}

const FEEDBACK_FIELDS: { key: string; label: string }[] = [
  { key: "relevant", label: "Relevant?" },
  { key: "newToCustomer", label: "New to you?" },
  { key: "timely", label: "Timely?" },
  { key: "worthPursuing", label: "Worth pursuing?" },
];

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
    <form onSubmit={submit} data-testid="feedback-form" className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        {FEEDBACK_FIELDS.map((f) => (
          <TriState
            key={f.key}
            label={f.label}
            value={answers[f.key] ?? null}
            onChange={(next) => setAnswers((a) => ({ ...a, [f.key]: next }))}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          className={FIELD}
          value={disposition}
          onChange={(e) => setDisposition(e.target.value)}
        >
          <option value="">disposition…</option>
          {dispositions.map((d) => (
            <option key={d} value={d}>
              {d.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <input
          className={`${FIELD} min-w-[16rem] flex-1`}
          placeholder="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className={BTN} disabled={busy}>
          Save feedback
        </button>
        {saved && <span className="text-sm font-semibold text-ok">saved</span>}
      </div>
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
    <span className="inline-flex items-center gap-2">
      <button className={BTN} disabled={busy} onClick={start} data-testid="start-pursuit">
        Start a pursuit
      </button>
      {msg && <span className="text-sm font-semibold text-bad">{msg}</span>}
    </span>
  );
}
