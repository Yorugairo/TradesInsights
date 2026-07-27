// Layout primitive: a bounded surface. Compound so the header can carry an
// action slot without the base component growing a props soup.
//
//   <Card>
//     <CardHeader title="Bid window" action={<GateBadge status={s} />} />
//     <CardBody>…</CardBody>
//   </Card>
//
// Server component. Nothing here needs client JS, and a `"use client"` at this
// depth would pull every consuming page across the boundary with it.

import type { ReactNode } from "react";

type CardProps = {
  children: ReactNode;
  /** `gold` is for the one card on a page that carries the decision. Use sparingly. */
  tone?: "neutral" | "gold";
  className?: string;
  "data-testid"?: string;
};

/**
 * Every primitive in this directory forwards `data-testid`. That is not a
 * convenience — the e2e suite selects exclusively by testid, which is what makes
 * a full visual rewrite safe. A primitive that swallowed the attribute would
 * force retrofits to wrap it in a bare <div> just to keep the hook, and the
 * first person in a hurry would instead edit the spec.
 */
export default function Card({
  children,
  tone = "neutral",
  className = "",
  "data-testid": testId,
}: CardProps) {
  return (
    <div
      data-testid={testId}
      className={[
        "rounded-lg border",
        tone === "gold"
          ? "border-line-strong bg-[image:var(--panel-gold-bg)]"
          : "border-line bg-surface",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  detail,
  action,
}: {
  title: ReactNode;
  detail?: ReactNode;
  /** Right-aligned slot: a badge, a link, a small control. */
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-ink">{title}</div>
        {detail ? <div className="mt-0.5 text-xs text-ink-muted">{detail}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  // Padding tracks --row-pad-* so the density toggle reaches inside cards too,
  // instead of compacting tables while cards stay comfortable.
  return <div className={`px-4 py-[var(--stack)] ${className}`.trim()}>{children}</div>;
}

export function CardFooter({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-line px-4 py-2 text-xs text-ink-muted">{children}</div>
  );
}
