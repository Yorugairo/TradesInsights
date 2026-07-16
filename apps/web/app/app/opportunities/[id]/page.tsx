import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { accountByKey, opportunityDetail } from "../../../../lib/queries.js";
import { Badge, cell, fmtDate, fmtMoney, healthTone, table } from "../../../../lib/ui.js";
import { FeedbackForm, StateButtons } from "./actions.js";

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { id } = await params;
  const o = await opportunityDetail(db(), id, account.id);
  if (!o) notFound();

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

      <h2>Confirmed facts vs. inferences</h2>
      {o.extraction ? (
        <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "1fr 1fr" }}>
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
      <StateButtons opportunityId={o.id} state={o.state} />
      <h2>Feedback</h2>
      <FeedbackForm opportunityId={o.id} />
    </main>
  );
}
