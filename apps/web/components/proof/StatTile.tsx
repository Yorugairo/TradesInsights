// Proof primitive (platform design system, register A "authority"): a metric tile
// for real, sourced numbers — verified counts, indices, coverage stats. Never feed
// this fabricated values; taste.md rule 1 ("proof is the material") is the point.
//
// Ported from OneTradeNetwork/apps/registry/src/components/StatTile.tsx. Same
// contract, CSS Modules swapped for Tailwind utilities over the shared token
// layer, so a tile in Insights and a tile in OTN are the same object.
//
// ONE DELIBERATE WIDENING: `value` accepts `null`. OTN's callers always had a
// formatted string; Insights routinely holds "we have not measured this", and
// forcing every call site to remember `?? "—"` is how a real unknown eventually
// gets rendered as 0. Absent renders as an em dash, never as a zero.

type Props = {
  value: string | number | null;
  label: string;
  detail?: string;
  tone?: "gold" | "neutral";
  /**
   * Testid for the value element.
   *
   * `value` stays `string | number | null` on purpose — widening it to ReactNode
   * so a caller could pass `<span data-testid=…>` would also let a caller pass
   * arbitrary markup and route around the em-dash rule above. A page that needs
   * a hook on the number asks for one instead.
   */
  valueTestId?: string;
};

export default function StatTile({ value, label, detail, tone = "neutral", valueTestId }: Props) {
  const display =
    value === null ? "—" : typeof value === "number" ? value.toLocaleString("en-US") : value;

  return (
    <div
      className={[
        "flex min-w-0 flex-col gap-1 rounded-md border px-[18px] py-4",
        tone === "gold"
          ? "border-line-strong bg-[image:var(--panel-gold-bg)]"
          : "border-line bg-surface",
      ].join(" ")}
    >
      <div
        data-testid={valueTestId}
        className={[
          "text-stat font-extrabold tabular-nums",
          tone === "gold" ? "text-accent-ink" : "text-ink",
        ].join(" ")}
      >
        {display}
      </div>
      <div className="text-2xs uppercase tracking-[0.08em] text-ink-muted">{label}</div>
      {detail ? <div className="text-xs text-ink-muted">{detail}</div> : null}
    </div>
  );
}
