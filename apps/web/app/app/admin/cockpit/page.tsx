import Link from "next/link";
import { redirect } from "next/navigation";
import { createRegistryPool } from "@otn/db";
import { queueSummary, type QueueSummary } from "@otn/intelligence";
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

  const pool = createRegistryPool();
  const summary = await queueSummary(db(), pool);
  const seamOffline = pool === null;

  return (
    <main style={{ padding: "1rem", maxWidth: 1050 }}>
      <h1>Queue cockpit</h1>
      <Mission />

      {seamOffline && (
        <p style={{ color: "#a00", margin: "0.5rem 0" }}>
          <strong>Registry seam offline</strong> (<code>REGISTRY_DATABASE_URL</code> unset). Family
          and Google Place sections show what Insights can see on its own — not zeros.
        </p>
      )}

      <SectionHeading
        title="Work now"
        blurb="Highest-quality signals, smallest queues — the direct differentiator over a commodity L&I pull."
      />
      <div style={grid}>
        <RegistryReviewCard summary={summary} />
        <FamiliesCard summary={summary} />
      </div>

      <SectionHeading
        title="Chunk it down"
        blurb="Large queues worked by pattern, not row by row — decide a shape once, clear all of it."
      />
      <div style={grid}>
        <ResolutionReviewCard summary={summary} />
        <GooglePlaceCard summary={summary} />
      </div>

      <SectionHeading
        title="Match lanes"
        blurb="Automatic binding rules. One is live but unfueled; one is gated until enrichment lands."
      />
      <div style={grid}>
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
      style={{ border: "1px solid #ddd", borderRadius: 6, padding: "0.6rem 0.8rem", margin: "0.75rem 0" }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>What is this for?</summary>
      <div style={{ color: "#444", fontSize: "0.9rem", marginTop: "0.5rem" }}>
        <p style={{ margin: "0.3rem 0" }}>
          Anyone can pull the L&amp;I contractor list. The Registry earns its edge by{" "}
          <strong>cross-referencing</strong> that list into a knowledge graph — person, contractor,
          entity, enterprise, DBA — so a customer can see <strong>who to contact</strong> and{" "}
          <strong>how the money flows</strong> between the companies on a project.
        </p>
        <p style={{ margin: "0.3rem 0" }}>
          Each queue below approves one kind of link. Approving links makes the Registry smarter,
          which sharpens Insights matches, which surfaces more links — the flywheel. Work them in the
          order shown: the smallest, highest-confidence queues first.
        </p>
        <p style={{ margin: "0.3rem 0", color: "#666" }}>
          Nothing here changes data. Every card links to the page where a decision is actually made.
        </p>
      </div>
    </details>
  );
}

function SectionHeading({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div style={{ margin: "1.25rem 0 0.5rem" }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p style={{ color: "#666", margin: "0.15rem 0 0", fontSize: "0.9rem" }}>{blurb}</p>
    </div>
  );
}

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  gap: "0.75rem",
};

const card: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 6,
  padding: "0.75rem 0.9rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

/** A queue card: number, one-line claim, a body, and the link that acts on it. */
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
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
        <strong>
          <span style={{ color: "#999" }}>Queue {n} · </span>
          {title}
        </strong>
        <span style={{ fontSize: "1.4rem", fontWeight: 700, whiteSpace: "nowrap" }}>{count}</span>
      </div>
      <div style={{ fontSize: "0.88rem", color: "#333" }}>{children}</div>
      {href ? (
        <div>
          <Link href={href}>{hrefLabel ?? "Open →"}</Link>
        </div>
      ) : (
        <div style={{ color: "#999", fontSize: "0.85rem" }}>{hrefLabel}</div>
      )}
    </div>
  );
}

function RegistryReviewCard({ summary }: { summary: QueueSummary }) {
  const { total, byRule } = summary.registryReview;
  const phone = summary.lanes.enrichmentPhoneCandidates30d;
  const top = byRule.slice(0, 3);
  return (
    <QueueCard
      n={2}
      title="Registry review"
      count={total.toLocaleString()}
      href="/app/admin/registry-review"
      hrefLabel="Review bindings →"
    >
      <div>Org → registry identity bindings awaiting a human accept.</div>
      {top.length > 0 && (
        <div style={{ color: "#666", marginTop: "0.25rem" }}>
          {top.map((r) => (
            <span key={r.ruleKey} style={{ marginRight: "0.6rem" }}>
              <code>{r.ruleKey}</code> {r.count}
            </span>
          ))}
        </div>
      )}
      <div style={{ color: "#666", marginTop: "0.25rem" }}>
        +{phone.toLocaleString()} from the phone lane (30d){" "}
        {phone === 0 && <span style={{ color: "#999" }}>· unfueled, Phase A backlogged</span>}
      </div>
    </QueueCard>
  );
}

function FamiliesCard({ summary }: { summary: QueueSummary }) {
  const f = summary.families;
  if (!f) {
    return (
      <QueueCard n={4} title="Corporate families" count="—" href="/app/admin/corporate-families" hrefLabel="Open →">
        <span style={{ color: "#a00" }}>Seam offline — families derive from the registry identity view.</span>
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
      <div style={{ color: "#666", marginTop: "0.25rem" }}>
        {f.count.toLocaleString()} families derived (entities under one L&amp;I principal).
      </div>
    </QueueCard>
  );
}

function ResolutionReviewCard({ summary }: { summary: QueueSummary }) {
  const { total, clusters } = summary.resolutionReview;
  return (
    <QueueCard
      n={1}
      title="Resolution review"
      count={total.toLocaleString()}
      href="/app/admin/review"
      hrefLabel="Bulk-decide by pattern →"
    >
      <div>Permit → project attachment. Work the top patterns, not the {total.toLocaleString()} rows.</div>
      {clusters.length > 0 ? (
        <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", color: "#333" }}>
          {clusters.map((c, i) => (
            <li key={`${c.matchedRule}-${c.reasonKey}-${c.candidateProjectId ?? "none"}-${i}`}>
              <code>{c.matchedRule}</code> · {c.count.toLocaleString()}
              {c.candidateName ? (
                <span style={{ color: "#666" }}> → {c.candidateName}</span>
              ) : (
                <span style={{ color: "#999" }}> → new project</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div style={{ color: "#999", marginTop: "0.25rem" }}>Queue empty.</div>
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
        <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", color: "#333" }}>
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
      <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", color: "#333" }}>
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
    <QueueCard n={6} title="Phone match lane" count={n.toLocaleString()} hrefLabel="Feeds registry review when it fires">
      <div>
        <Badge tone={n > 0 ? "green" : "gray"}>{n > 0 ? "active" : "unfueled"}</Badge> candidates in the
        last 30 days.
      </div>
      <div style={{ color: "#666", marginTop: "0.25rem" }}>
        Structurally unfueled today (61 org phones, zero overlap with any registry or L&amp;I phone).
        Phase A would fuel it — currently backlogged.
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
      <div style={{ color: "#666", marginTop: "0.25rem" }}>
        Activation waits on enrichment coverage being demonstrably real — Insights can fuel domain
        discovery better than the L&amp;I registration ever could.
      </div>
    </QueueCard>
  );
}
