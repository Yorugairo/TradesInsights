// Proof primitive: when a derived number was last computed.
//
// Some numbers in this product are read live and some are derived on a
// schedule. The operator cannot tell which by looking, and the difference
// decides whether "0 pairs ready" means "you cleared the queue" or "the job
// has not run since Tuesday".
//
// So anything derived carries its stamp. This is the same discipline the
// corroboration jsonb already applies with its own `derivedAt` field
// (packages/resolution/src/corroboration.ts:100) — this component is the UI
// half of it, and the reason it is a component rather than an inline span is
// that the staleness threshold and the wording should not drift between pages.

/** Relative age in the coarsest unit that is still honest. */
export function formatAge(fromIso: string, now: number): string {
  const ms = now - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function DerivedAt({
  at,
  stale = false,
  now = Date.now(),
}: {
  /** ISO-8601 timestamp of the derivation. */
  at: string;
  /** Old enough that the UI should say so rather than quietly showing old counts. */
  stale?: boolean;
  /** Injectable for tests; never pass this from a page. */
  now?: number;
}) {
  return (
    <div
      className={`mt-1 text-2xs uppercase tracking-[0.08em] ${stale ? "text-warn" : "text-ink-subtle"}`}
      data-derived-stale={stale ? "true" : "false"}
      title={at}
    >
      {stale ? "Stale — derived " : "Derived "}
      {formatAge(at, now)}
      {stale ? "; the refresh has not succeeded since" : ""}
    </div>
  );
}
