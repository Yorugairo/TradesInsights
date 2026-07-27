// Proof primitive (platform design system, register A "authority"): a small pill
// naming a data source or provenance fact (e.g. "OEWS May 2025 · labor index 1.33").
// The visible-source discipline is the trust wedge vs. opaque competitor numbers.
//
// Ported from OneTradeNetwork/apps/registry/src/components/SourceChip.tsx.
//
// In Insights this is the component that answers "says who?" — a chip with no
// real source behind it is worse than no chip, because it borrows the credibility
// of the ones that are real.

type Props = {
  label: string;
  detail?: string;
  /** Renders as a link when the provenance has a fetchable URL. */
  href?: string;
};

export default function SourceChip({ label, detail, href }: Props) {
  const body = (
    <>
      <span className="text-[0.78rem] font-semibold text-ink">{label}</span>
      {detail ? <span className="text-xs tabular-nums text-ink-muted">{detail}</span> : null}
    </>
  );

  // `whitespace-nowrap` keeps "source · detail" on one line, but a long agency
  // name must be allowed to wrap on a phone rather than force the page into
  // horizontal overflow (OTN's own @media max-width:640px rule).
  const shell =
    "inline-flex items-baseline gap-2 whitespace-nowrap rounded-full border border-chip-line bg-chip px-3 py-1.5 max-sm:whitespace-normal";

  if (href) {
    return (
      <a className={`${shell} underline decoration-line-strong underline-offset-2`} href={href}>
        {body}
      </a>
    );
  }
  return <span className={shell}>{body}</span>;
}
