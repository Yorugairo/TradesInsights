// Proof primitive, Insights-specific: the publication-gate verdict for an
// opportunity, as a single glanceable badge.
//
// The gate has THREE outcomes and one non-outcome, and the difference between
// the last two is the whole point of the component:
//
//   pass                 — every check passed; publishable
//   fail                 — a check failed; we know why not
//   blocked_on_verifier  — the model verifier could not run (no keys). The gate
//                          did not say no. It could not ask.
//   null                 — the gate has never been evaluated for this record
//
// Rendering `blocked_on_verifier` or `null` as anything that resembles "fail"
// invents a judgement the pipeline refused to make; rendering either as
// anything that resembles "pass" invents evidence. Both get their own state.
//
// Mirrors packages/intelligence/src/gate/gate.ts:24-28.

export type GateStatus = "pass" | "fail" | "blocked_on_verifier" | null | undefined;

type GateBadgeState = {
  label: string;
  detail: string;
  /** Drives the visual treatment; `unknown` is deliberately not a status colour. */
  tone: "ok" | "bad" | "warn" | "unknown";
};

export function gateBadgeState(status: GateStatus): GateBadgeState {
  switch (status) {
    case "pass":
      return { label: "Publishable", detail: "All gate checks passed.", tone: "ok" };
    case "fail":
      return { label: "Blocked", detail: "At least one gate check failed.", tone: "bad" };
    case "blocked_on_verifier":
      return {
        label: "Awaiting verifier",
        detail: "Model verification could not run — this is not a failure.",
        tone: "warn",
      };
    default:
      return {
        label: "Not evaluated",
        detail: "The gate has not run for this record.",
        tone: "unknown",
      };
  }
}

const TONE_CLASSES: Record<GateBadgeState["tone"], string> = {
  ok: "border-ok text-ok",
  bad: "border-bad text-bad",
  warn: "border-warn text-warn",
  // Dashed and colourless: an un-run gate must not borrow the visual weight of
  // a verdict. See ConfidenceMeter for the same rule applied to corroboration.
  unknown: "border-dashed border-line-strong text-ink-subtle",
};

export default function GateBadge({
  status,
  showDetail = false,
}: {
  status: GateStatus;
  showDetail?: boolean;
}) {
  const state = gateBadgeState(status);

  return (
    <span className="inline-flex items-baseline gap-2">
      <span
        className={[
          "inline-flex items-center rounded-full border px-2.5 py-0.5",
          "text-2xs font-semibold uppercase tracking-[0.08em]",
          TONE_CLASSES[state.tone],
        ].join(" ")}
        title={state.detail}
      >
        {state.label}
      </span>
      {showDetail ? <span className="text-xs text-ink-muted">{state.detail}</span> : null}
    </span>
  );
}
