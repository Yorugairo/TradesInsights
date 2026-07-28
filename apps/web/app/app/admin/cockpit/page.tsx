import Link from "next/link";
import { redirect } from "next/navigation";
import { registryPool } from "../../../../lib/registry-db.js";
import { queueSummary, type QueueSummary } from "@otn/intelligence";
import PageHeader from "../../../../components/ui/PageHeader.js";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { Badge } from "../../../../lib/ui.js";

export const dynamic = "force-dynamic";

/**
 * Queue cockpit — the front door to every identity/enrichment review lane.
 *
 * There are six streams and no two ask the same question; opening a tab does not
 * tell you what to work first. This page states the mission, then lists the
 * lanes in the OWNER'S priority order (queue-cockpit plan): work the highest-
 * quality signals now, chunk the large ones, and show the dormant lanes with the
 * one reason each is dormant — so a lane that is gated never reads as "done".
 *
 * Every count comes from `queueSummary`, which reads the same source each queue
 * page reads — the cockpit can't drift from the page it links to. Seam-dependent
 * sections (families, Google Place) show "seam offline", never a fake zero, when
 * `REGISTRY_DATABASE_URL` is unset or the Phase D view is not built yet.
 *
 * Admin-only (like every `/app/admin/*` queue). Only aggregate integers render
 * here — no principal or person names — so the privacy contract of the
 * underlying family data is preserved.
 */
export default async function CockpitPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");

  const pool = registryPool();
  const summary = await queueSummary(db(), pool);
  const seamOffline = pool === null;

  return (
    // No page padding here. The app shell owns the gutter; this page used to set
    // its own on top of it, which showed as a double margin on every admin screen.
    <main>
      <PageHeader
        title="Queue cockpit"
        description="Six review streams, in the order they are worth working. Nothing on this page changes data — every card links to the page where a decision is actually made."
      />

      <Mission />

      {seamOffline && (
        // Not a zero. The registry seam being unreachable and the queue being
        // empty are different facts, and the whole page is built to keep them
        // apart.
        <p className="mb-[calc(var(--stack)*1.5)] rounded-md border border-bad px-4 py-3 text-sm text-bad">
          <strong>Registry seam offline</strong> (<code>REGISTRY_DATABASE_URL</code> unset). Family
          and Google Place sections show what Insights can see on its own — not zeros.
        </p>
      )}

      <SectionHeading
        title="Work now"
        blurb="Highest-quality signals, smallest queues — the direct differentiator over a commodity L&I pull."
      />
      <div className={GRID}>
        <RegistryReviewCard summary={summary} />
        <FamiliesCard summary={summary} />
      </div>

      <SectionHeading
        title="Chunk it down"
        blurb="Large queues worked by pattern, not row by row — decide a shape once, clear all of it."
      />
      <div className={GRID}>
        <ResolutionReviewCard summary={summary} />
        <GooglePlaceCard summary={summary} />
      </div>

      <SectionHeading
        title="Match lanes"
        blurb="Automatic binding rules. One is live but unfueled; one is gated until enrichment lands."
      />
      <div className={GRID}>
        <PhoneLaneCard summary={summary} />
        <DomainLaneCard />
      </div>
    </main>
  );
}

/** The strategic why, stated before the numbers. Dismissible, open by default —
 * the same Orientation-panel convention the individual queue pages use. */
function Mission() {
  return (
    <details
      open
      className="mb-[calc(var(--stack)*1.5)] rounded-md border border-line bg-surface px-4 py-3"
    >
      <summary className="cursor-pointer font-semibold text-ink">What is this for?</summary>
      <div className="mt-2 flex flex-col gap-2 text-sm text-ink-muted">
        <p>
          Anyone can pull the L&amp;I contractor list. The Registry earns its edge by{" "}
          <strong className="text-ink">cross-referencing</strong> that list into a knowledge graph —
          person, contractor, entity, enterprise, DBA — so a customer can see{" "}
          <strong className="text-ink">who to contact</strong> and{" "}
          <strong className="text-ink">how the money flows</strong> between the companies on a
          project.
        </p>
        <p>
          Each queue below approves one kind of link. Approving links makes the Registry smarter,
          which sharpens Insights matches, which surfaces more links — the flywheel. Work them in
          the order shown: the smallest, highest-confidence queues first.
        </p>
        <p className="text-ink-subtle">
          Nothing here changes data. Every card links to the page where a decision is actually
          made.
        </p>
      </div>
    </details>
  );
}

function SectionHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mb-2 mt-[calc(var(--stack)*1.5)]">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="mt-0.5 max-w-[70ch] text-sm text-ink-muted">{blurb}</p>
    </div>
  );
}

const GRID = "grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(20rem,100%),1fr))]";

const CARD_BASE = "flex flex-col gap-1.5 rounded-md border border-line bg-surface px-4 py-3";

/**
 * A queue card: number, one-line claim, a body, and the link that acts on it.
 *
 * The WHOLE card is the click target when the queue is actionable. Previously
 * only the trailing "Review bindings →" text was a link, so clicking the card,
 * its title, or the big count — the three things an operator actually aims at —
 * did nothing, and the cockpit read as though it had no link at all.
 *
 * One <Link> wrapping everything (rather than a link per element) also keeps it
 * to a single tab stop with the queue name and count inside its accessible name,
 * so keyboard and screen-reader users get "Registry review 760, Review bindings"
 * as one target instead of tabbing past inert text to reach a bare arrow.
 *
 * Dormant queues (no href) stay a plain <div>: nothing to click, and rendering a
 * disabled-looking link would imply the lane is merely unfinished rather than
 * deliberately gated.
 */
function QueueCard({
  n,
  title,
  count,
  href,
  hrefLabel,
  children,
}: {
  n: number;
  title: string;
  count: React.ReactNode;
  href?: string;
  hrefLabel?: string;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <strong className="text-ink">
          <span className="font-normal text-ink-subtle">Queue {n} · </span>
          {title}
        </strong>
        <span className="whitespace-nowrap text-xl font-bold tabular-nums text-ink">{count}</span>
      </div>
      <div className="text-sm text-ink-muted">{children}</div>
    </>
  );

  if (!href) {
    return (
      <div className={CARD_BASE}>
        {body}
        <div className="text-xs text-ink-subtle">{hrefLabel}</div>
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={`${CARD_BASE} no-underline hover:border-line-strong hover:bg-surface-raised`}
    >
      {body}
      <div className="text-sm font-semibold text-accent-ink">{hrefLabel ?? "Open →"}</div>
    </Link>
  );
}

function RegistryReviewCard({ summary }: { summary: QueueSummary }) {
  const { total, byRule, byTier } = summary.registryReview;
  const phone = summary.lanes.enrichmentPhoneCandidates30d;
  const top = byRule.slice(0, 3);
  const tone = (tier: string): "green" | "amber" | "gray" =>
    tier === "tier1" ? "green" : tier === "tier2" ? "amber" : "gray";
  return (
    <QueueCard
      n={2}
      title="Registry review"
      count={total.toLocaleString()}
      href="/app/admin/registry-review"
      hrefLabel="Review bindings →"
    >
      <div>Org → registry identity bindings awaiting a human accept.</div>
      {byTier.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {byTier.map((t) => (
            <span key={t.tier}>
              <Badge tone={tone(t.tier)}>{t.count}</Badge> {t.label}
            </span>
          ))}
        </div>
      )}
      {top.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-3 text-ink-subtle">
          {top.map((r) => (
            <span key={r.ruleKey}>
              <code>{r.ruleKey}</code> {r.count}
            </span>
          ))}
        </div>
      )}
      <div className="mt-1 text-ink-subtle">
        +{phone.toLocaleString()} from the phone lane (30d){" "}
        {phone === 0 && <span>· unfueled, Phase A backlogged</span>}
      </div>
    </QueueCard>
  );
}

function FamiliesCard({ summary }: { summary: QueueSummary }) {
  const f = summary.families;
  if (!f) {
    return (
      <QueueCard
        n={4}
        title="Corporate families"
        count="—"
        href="/app/admin/corporate-families"
        hrefLabel="Open →"
      >
        <span className="text-bad">
          Seam offline — families derive from the registry identity view.
        </span>
      </QueueCard>
    );
  }
  return (
    <QueueCard
      n={4}
      title="Corporate families"
      count={f.pairsStrong.toLocaleString()}
      href="/app/admin/corporate-families"
      hrefLabel="Confirm relationships →"
    >
      <div>
        <Badge tone="green">{f.pairsStrong}</Badge> corroborated principal↔person pairs ready to
        confirm, of {f.pairsNew.toLocaleString()} new.
      </div>
      <div className="mt-1 text-ink-subtle">
        {f.count.toLocaleString()} families derived (entities under one L&amp;I principal).
      </div>
    </QueueCard>
  );
}

function ResolutionReviewCard({ summary }: { summary: QueueSummary }) {
  const { total, actionable, awaitingEvidence, clustersToHalf, clustersToEighty, clusters } =
    summary.resolutionReview;
  return (
    <QueueCard
      n={1}
      title="Resolution review"
      // The headline is what the operator can ACT on. Leading with the raw total
      // overstated the work threefold and made a finite queue look bottomless.
      count={actionable.toLocaleString()}
      href="/app/admin/review"
      hrefLabel="Bulk-decide by pattern →"
    >
      <div>
        Permit → project attachment. The largest <strong>{clustersToHalf}</strong> clusters clear
        half of it, <strong>{clustersToEighty}</strong> clear 80%.
      </div>
      {awaitingEvidence > 0 && (
        <div className="mt-1 text-ink-subtle">
          {awaitingEvidence.toLocaleString()} of {total.toLocaleString()} are waiting on parcel/org
          evidence, not on a reviewer.
        </div>
      )}
      {clusters.length > 0 ? (
        <ul className="mt-1.5 list-disc pl-4">
          {clusters.map((c, i) => (
            <li key={`${c.matchedRule}-${c.reasonKey}-${c.candidateProjectId ?? "none"}-${i}`}>
              <code>{c.matchedRule}</code> · {c.count.toLocaleString()}
              {c.candidateName ? (
                <span className="text-ink-subtle"> → {c.candidateName}</span>
              ) : (
                <span className="text-ink-subtle"> → new project</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-ink-subtle">Queue empty.</div>
      )}
    </QueueCard>
  );
}

function GooglePlaceCard({ summary }: { summary: QueueSummary }) {
  const g = summary.googlePlace;
  if (!g) {
    // Null means the registry seam is unreachable (no pool, or the contract view
    // is missing mid-deploy) — never a zero. Show the chunk DEFINITIONS only.
    return (
      <QueueCard n={3} title="Google Place review" count="—" hrefLabel="registry seam offline">
        <div>Place ↔ entity matches, split three ways:</div>
        <ul className="mt-1.5 list-disc pl-4">
          <li>human-ready</li>
          <li>awaiting the lineage auto-resolver</li>
          <li>awaiting evidence-gathering automation</li>
        </ul>
      </QueueCard>
    );
  }
  return (
    <QueueCard
      n={3}
      title="Google Place review"
      count={g.actionable.toLocaleString()}
      href="/app/admin/google-place-review"
      hrefLabel="Work the queue →"
    >
      <div>Place ↔ entity matches:</div>
      <ul className="mt-1.5 list-disc pl-4">
        <li>
          <strong>{g.actionable.toLocaleString()}</strong> human-ready
        </li>
        <li>{g.awaitingAutoResolver.toLocaleString()} awaiting the auto-resolver</li>
        <li>{g.awaitingEvidence.toLocaleString()} awaiting evidence gathering</li>
      </ul>
    </QueueCard>
  );
}

function PhoneLaneCard({ summary }: { summary: QueueSummary }) {
  const n = summary.lanes.enrichmentPhoneCandidates30d;
  return (
    <QueueCard
      n={6}
      title="Phone match lane"
      count={n.toLocaleString()}
      hrefLabel="Feeds registry review when it fires"
    >
      <div>
        <Badge tone={n > 0 ? "green" : "gray"}>{n > 0 ? "active" : "unfueled"}</Badge> candidates in
        the last 30 days.
      </div>
      <div className="mt-1 text-ink-subtle">
        Structurally unfueled today (61 org phones, zero overlap with any registry or L&amp;I
        phone). Phase A would fuel it — currently backlogged.
      </div>
    </QueueCard>
  );
}

function DomainLaneCard() {
  return (
    <QueueCard n={5} title="Domain match lane" count="gated" hrefLabel="Phase E groundwork">
      <div>
        <Badge tone="gray">gated</Badge> 0 of 3,797 orgs carry a website today.
      </div>
      <div className="mt-1 text-ink-subtle">
        Activation waits on enrichment coverage being demonstrably real — Insights can fuel domain
        discovery better than the L&amp;I registration ever could.
      </div>
    </QueueCard>
  );
}
