import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  DISPOSITION_REASONS,
  accountBidWindows,
  bidTrackFor,
  buildDecisionMemo,
  classify,
  type BidWindowStatus,
  type ProjectFeatures,
} from "@otn/intelligence";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { accountByKey, campusSiblings, opportunityDetail } from "../../../../lib/queries.js";
import { Badge, cell, fmtDate, fmtMoney, healthTone, table } from "../../../../lib/ui.js";
import { FeedbackForm, StartPursuitButton, StateButtons } from "./actions.js";

const CAPACITY_TONE: Record<string, "green" | "amber" | "red"> = {
  likely_fit: "green",
  possible_stretch: "amber",
  likely_too_large: "amber",
  excluded: "red",
  unknown: "amber",
};

const BID_WINDOW_TONE: Record<BidWindowStatus, "green" | "amber" | "red" | "gray"> = {
  confirmed_open: "green",
  open: "green",
  opens_soon: "amber",
  likely_closed: "red",
  watch: "gray",
};

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { id } = await params;
  const o = await opportunityDetail(db(), id, account.id);
  if (!o) notFound();

  // S1 decision memo — assembled from stored rows (side-effect-free preview).
  const memo = await buildDecisionMemo(db(), id);
  // #1 — active-campus siblings (derived campus_block; null when not in one).
  const campus = await campusSiblings(db(), o.project.id, o.project.campusBlock);

  // Wave 2 E1 — the Bid Clock. TRADE-SCOPED: windows exist only for the
  // account's capabilities that carry a stated timing model (drywall/painting
  // → interior-finish); an unmodeled trade renders NOTHING here, never a
  // borrowed clock. Same classify → track → window chain the digest/export use.
  const capabilities = Array.isArray(account.capabilities) ? account.capabilities : [];
  const bidCls = classify({
    projectId: o.project.id,
    county: o.project.county,
    permittingJurisdiction: o.project.permittingJurisdiction,
    city: o.project.city,
    stage: o.project.stage,
    text: o.project.bidText,
    maxUnits: o.project.maxUnits,
    maxValuation: o.project.maxValuation,
    clusterSize: 0,
    hasVelocitySignal: false,
    orgs: [],
    aGradeEvidence: 0,
    lastMaterialChangeAt: null,
  } satisfies ProjectFeatures);
  const bidTrack = bidTrackFor(bidCls);
  const bidWindows = accountBidWindows(capabilities, {
    stage: o.project.stage,
    track: bidTrack,
    issuedAt: o.project.latestIssueDate ? new Date(o.project.latestIssueDate) : null,
  });

  const rationale = o.rationale as {
    components?: Record<string, number>;
    signals?: string[];
  } | null;
  const gateTone =
    o.gate?.status === "pass" ? "green" : o.gate?.status === "fail" ? "red" : "amber";

  return (
    <main>
      <h1 data-testid="opportunity-title">{o.project.name}</h1>
      <p>
        <Badge>{o.project.county}</Badge> <Badge>{o.project.permittingJurisdiction}</Badge>{" "}
        <Badge>{o.project.stage}</Badge> <Badge tone={gateTone}>gate: {o.gate?.status ?? "n/a"}</Badge>{" "}
        score <strong>{o.score ?? "—"}</strong> · route {o.route ?? "—"} · state {o.state} · last
        material change {fmtDate(o.project.lastMaterialChangeAt)}
      </p>
      <p>
        Address: {o.project.address ?? "—"} · Parcels:{" "}
        {Array.isArray(o.project.parcels) && o.project.parcels.length > 0
          ? (o.project.parcels as string[]).join(", ")
          : "—"}{" "}
        · Units: {o.project.maxUnits ?? "—"} · Valuation: {fmtMoney(o.project.maxValuation)} ·{" "}
        <Link href={`/app/projects/${o.project.id}`}>project page</Link>
      </p>

      {bidWindows.length > 0 && (
        <section
          data-testid="bid-clock"
          style={{
            border: "1px solid #c8d8ea",
            background: "#f3f8fd",
            borderRadius: 8,
            padding: "1rem",
            margin: "1rem 0",
          }}
        >
          <h2 style={{ marginTop: 0 }}>
            Bid clock <Badge tone="gray">{bidTrack} track</Badge>
          </h2>
          {bidWindows.map((w) => (
            <p key={w.trade} data-testid={`bid-window-${w.trade}`} style={{ margin: "0.4rem 0" }}>
              <strong style={{ textTransform: "capitalize" }}>{w.trade}</strong>{" "}
              <Badge tone={BID_WINDOW_TONE[w.status]}>{w.status.replace(/_/g, " ")}</Badge> {w.note}
            </p>
          ))}
          <p style={{ fontSize: "0.8rem", color: "#6b6b6b", marginBottom: 0 }}>
            Typical-sequencing inference for your trades only — never a promise. A stated bid
            solicitation on record always overrides this model.
          </p>
        </section>
      )}

      {o.brief && (
        <section
          data-testid="decision-brief"
          style={{
            border: "1px solid #cfe3d0",
            background: "#f4faf5",
            borderRadius: 8,
            padding: "1rem",
            margin: "1rem 0",
          }}
        >
          <h2 style={{ marginTop: 0 }}>
            The brief{" "}
            <Badge tone={memo?.verifierStatus === "passed" ? "green" : "amber"}>
              verified{memo?.verifierStatus === "passed" ? "" : " — pending gate"}
            </Badge>
          </h2>
          <p data-testid="brief-narrative" style={{ fontSize: "1.05rem", lineHeight: 1.55 }}>
            {o.brief.segments.map((s, i) => (
              <span
                key={i}
                style={s.kind === "inference" ? { color: "#6b6b6b", fontStyle: "italic" } : undefined}
              >
                {s.text}{" "}
              </span>
            ))}
          </p>
          <p style={{ fontSize: "0.8rem", color: "#6b6b6b", marginBottom: 0 }}>
            Composed from verified facts only — every sentence traces to the evidence below; italics
            are labeled inferences, not confirmed facts.
          </p>
        </section>
      )}

      {memo && (
        <section
          data-testid="decision-memo"
          style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", margin: "1rem 0" }}
        >
          <h2 style={{ marginTop: 0 }}>Decision memo</h2>
          <p>
            <strong>What changed:</strong> {memo.whatChanged}
          </p>
          <p data-testid="memo-recommended-action">
            <strong>Recommended action:</strong> {memo.recommendedAction}
          </p>
          <p>
            <strong>Fit:</strong> score {memo.score ?? "—"} · route {memo.route ?? "—"} ·{" "}
            <Badge>procurement: {memo.procurementState}</Badge>{" "}
            <Badge tone={CAPACITY_TONE[memo.capacityAssessment] ?? "amber"}>
              capacity: {memo.capacityAssessment}
            </Badge>{" "}
            <Badge tone={memo.verifierStatus === "passed" ? "green" : memo.verifierStatus === "failed" ? "red" : "amber"}>
              verifier: {memo.verifierStatus}
            </Badge>
          </p>
          {memo.capacityExplanation && (
            <p data-testid="memo-capacity">
              <strong>Capacity note:</strong> {memo.capacityExplanation}
            </p>
          )}
          <p>
            <strong>Timing:</strong> {memo.timingAssessment}
          </p>
          {memo.talkingPoints.length > 0 && (
            <div data-testid="talking-points">
              <strong>Outreach prep (evidence-only — for your own call/text):</strong>
              <ul style={{ marginTop: "0.25rem" }}>
                {memo.talkingPoints.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {campus && (
        <section
          data-testid="campus-panel"
          style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", margin: "1rem 0" }}
        >
          <h2 style={{ marginTop: 0 }}>
            Active campus <Badge tone="green">parcel block {campus.block}</Badge>
          </h2>
          <p>
            This project is one of <strong>{campus.siblings.length + 1}</strong> active projects on
            the same parcel block — one site, one relationship. Related projects:
          </p>
          <ul>
            {campus.siblings.map((s) => (
              <li key={s.id}>
                <Link href={`/app/projects/${s.id}`}>{s.name}</Link> — {s.stage}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2>Recommended next action</h2>
      <p data-testid="next-action">{o.nextAction}</p>

      <h2>Score components</h2>
      <p>
        {rationale?.components
          ? Object.entries(rationale.components)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")
          : "—"}
        {rationale?.signals?.length ? ` — signals: ${rationale.signals.join(", ")}` : ""}
      </p>

      {o.corroboration && (
        <section
          data-testid="corroboration-panel"
          style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", margin: "1rem 0" }}
        >
          <h2 style={{ marginTop: 0 }}>Corroboration</h2>
          <p>
            {(o.corroboration.sources?.length ?? 0) >= 2 ? (
              <>
                Seen independently in <strong>{o.corroboration.sources!.length}</strong> public
                sources: {o.corroboration.sources!.join(", ")}.
              </>
            ) : (
              <>Single public source so far{o.corroboration.sources?.length ? ` (${o.corroboration.sources[0]})` : ""}.</>
            )}{" "}
            {typeof o.corroboration.stageDepth === "number" && o.corroboration.stageDepth > 0 && (
              <>Lifecycle confirmed through {o.corroboration.stageDepth} distinct stage{o.corroboration.stageDepth === 1 ? "" : "s"}.</>
            )}
          </p>
          {(o.corroboration.contradictions?.length ?? 0) > 0 && (
            <div data-testid="corroboration-contradictions">
              <strong>Conflicting statements on record (both values shown — never resolved for you):</strong>
              <ul style={{ marginTop: "0.25rem" }}>
                {o.corroboration.contradictions!.map((c, i) => (
                  <li key={i}>
                    <code>{c.field}</code> stated as{" "}
                    {c.values.map((v) => JSON.stringify(v)).join(" and ")} by different records
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <h2>Confirmed facts vs. inferences</h2>
      {o.extraction ? (
        <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <div>
            <h3>Facts (confirmed, evidence-cited)</h3>
            <ul>
              {o.extraction.facts.map((f, i) => (
                <li key={i}>
                  <code>{f.path}</code> = {JSON.stringify(f.value)}{" "}
                  <Badge tone="green">confidence {f.confidence}</Badge>
                </li>
              ))}
              {o.extraction.facts.length === 0 && <li>none extracted</li>}
            </ul>
          </div>
          <div>
            <h3>Inferences (labeled, never facts)</h3>
            <ul>
              {o.extraction.inferences.map((inf, i) => (
                <li key={i}>
                  <code>{inf.type}</code> = {JSON.stringify(inf.value)}{" "}
                  <Badge tone="amber">confidence {inf.confidence}</Badge> — {inf.reason}
                </li>
              ))}
              {o.extraction.inferences.length === 0 && <li>none</li>}
            </ul>
          </div>
        </div>
      ) : (
        <p>
          No model extraction yet — model jobs are {o.verification?.status === "blocked" ? "blocked (no API key)" : "pending"}.
          Fields shown above come from deterministic parsing only.
        </p>
      )}
      {o.extraction && o.extraction.missingCriticalFacts.length > 0 && (
        <p>
          <strong>Missing critical facts:</strong> {o.extraction.missingCriticalFacts.join(", ")}
        </p>
      )}

      <h2>Organizations &amp; roles</h2>
      <ul>
        {o.roles.map((r, i) => (
          <li key={i}>
            {r.name} — {r.role ?? "unknown role"}{" "}
            {r.confirmed ? <Badge tone="green">confirmed</Badge> : <Badge tone="amber">unconfirmed</Badge>}
          </li>
        ))}
        {o.roles.length === 0 && <li>none recorded</li>}
      </ul>

      <h2>Timeline</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Date</th>
            <th style={cell}>Event</th>
            <th style={cell}>Stage</th>
            <th style={cell}>Material</th>
            <th style={cell}>Source</th>
          </tr>
        </thead>
        <tbody>
          {o.timeline.map((e, i) => (
            <tr key={i}>
              <td style={cell}>{fmtDate(e.eventDate ?? e.observedAt)}</td>
              <td style={cell}>{e.eventType}</td>
              <td style={cell}>{e.resultingStage ?? "—"}</td>
              <td style={cell}>{e.materialChange ? "yes" : ""}</td>
              <td style={cell}>{e.sourceUrl ? <a href={e.sourceUrl}>source</a> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Evidence ({o.evidence.length})</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Fact path</th>
            <th style={cell}>Evidence</th>
            <th style={cell}>Grade</th>
            <th style={cell}>Source</th>
            <th style={cell}>Retrieved</th>
          </tr>
        </thead>
        <tbody>
          {o.evidence.map((ev) => (
            <tr key={ev.id}>
              <td style={cell}>
                <code>{ev.factPath}</code>
              </td>
              <td style={cell}>{ev.evidenceText.slice(0, 240)}</td>
              <td style={cell}>
                <Badge tone={ev.authorityGrade === "A" ? "green" : ev.authorityGrade === "D" ? "red" : "amber"}>
                  {ev.authorityGrade}
                </Badge>
              </td>
              <td style={cell}>
                <a href={ev.sourceUrl}>{ev.sourceName}</a>
                {ev.pageOrSection ? ` (${ev.pageOrSection})` : ""}
              </td>
              <td style={cell}>{fmtDate(ev.retrievedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Publication gate</h2>
      <ul>
        {o.gate?.checks.map((c) => (
          <li key={c.name}>
            <Badge tone={c.pass === true ? "green" : c.pass === false ? "red" : "amber"}>
              {c.pass === true ? "pass" : c.pass === false ? "fail" : "blocked"}
            </Badge>{" "}
            <code>{c.name}</code> — {c.detail}
          </li>
        ))}
      </ul>
      {o.verification && (
        <p>
          Verifier status: <Badge tone={healthTone(o.verification.status === "succeeded" ? "green" : "amber")}>{o.verification.status}</Badge>
        </p>
      )}

      <h2>Your decision</h2>
      <StateButtons opportunityId={o.id} state={o.state} dispositions={DISPOSITION_REASONS} />
      <p style={{ marginTop: "0.75rem" }}>
        <StartPursuitButton opportunityId={o.id} />
      </p>
      <h2>Feedback</h2>
      <FeedbackForm opportunityId={o.id} dispositions={DISPOSITION_REASONS} />
    </main>
  );
}
