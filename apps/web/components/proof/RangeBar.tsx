// Proof primitive (platform design system, register A "authority"): renders a
// low -> typical -> high range as a horizontal band with a marker at the typical
// value. Pure presentation, SSR-safe (no client JS) — callers pass pre-formatted
// value labels so the component stays unit- and vertical-neutral.
//
// Ported from OneTradeNetwork/apps/registry/src/components/RangeBar.tsx.

type Props = {
  low: number;
  typical: number;
  high: number;
  lowLabel?: string;
  typicalLabel?: string;
  highLabel?: string;
  // Compact mode: track + marker only (values live in surrounding table cells).
  compact?: boolean;
  ariaLabel?: string;
};

/**
 * Position of the typical marker, 0-100.
 *
 * The `span > 0` guard is not defensive padding — a degenerate range where
 * `low === high` is a REAL state in this product (a trade with a single
 * observed bid, a market with one comparable). Without the guard that case is
 * `0/0` and the marker's `left` becomes `NaN%`, which browsers drop silently:
 * the marker renders at the far left and reads as "bottom of the range".
 * Centre is the honest rendering of "one point, no spread".
 */
export function rangeMarkerPercent(low: number, typical: number, high: number): number {
  const span = high - low;
  return span > 0 ? Math.min(100, Math.max(0, ((typical - low) / span) * 100)) : 50;
}

export default function RangeBar({
  low,
  typical,
  high,
  lowLabel,
  typicalLabel,
  highLabel,
  compact = false,
  ariaLabel,
}: Props) {
  const markerPercent = rangeMarkerPercent(low, typical, high);
  const label =
    ariaLabel ||
    `Range from ${lowLabel ?? low} to ${highLabel ?? high}, typically ${typicalLabel ?? typical}`;

  return (
    <div className="w-full" role="img" aria-label={label}>
      {!compact && (
        <div className="mb-2.5 flex items-end justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <Caption>Low</Caption>
            <Value>{lowLabel}</Value>
          </span>
          <span className="flex flex-col gap-0.5 text-center">
            <Caption>Typical</Caption>
            <span className="text-[1.35rem] font-bold tabular-nums text-accent-ink">
              {typicalLabel}
            </span>
          </span>
          <span className="flex flex-col gap-0.5 text-right">
            <Caption>High</Caption>
            <Value>{highLabel}</Value>
          </span>
        </div>
      )}
      <div
        className={`relative rounded-[4px] bg-track ${compact ? "h-[5px]" : "h-2"}`}
      >
        <div className="absolute inset-0 rounded-[4px] bg-[image:var(--range-band)]" />
        <div
          className={[
            "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
            "border-2 border-surface bg-accent",
            compact ? "h-2.5 w-2.5" : "h-3.5 w-3.5 shadow-[0_0_10px_var(--accent-glow)]",
          ].join(" ")}
          // Legitimately dynamic: the marker's position IS the datum. There is
          // no utility class for "37.4% from the left".
          style={{ left: `${markerPercent}%` }}
        />
      </div>
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xs uppercase tracking-[0.08em] text-ink-muted">{children}</span>
  );
}

function Value({ children }: { children: React.ReactNode }) {
  return <span className="text-base font-semibold tabular-nums text-ink">{children}</span>;
}
