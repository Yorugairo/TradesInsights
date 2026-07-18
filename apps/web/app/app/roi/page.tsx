import { redirect } from "next/navigation";
import {
  detectionLagBySource,
  evidenceLeadTime,
  firstLookByCoverage,
  roiScorecard,
} from "@otn/delivery";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { Badge, cell, fmtMoney, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export default async function RoiPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 86_400_000);
  const s = await roiScorecard(db(), account.id, { start, end });
  const [lead, lag, firstLook] = await Promise.all([
    evidenceLeadTime(db(), account.id),
    detectionLagBySource(db()),
    firstLookByCoverage(db()),
  ]);
  const d = (v: number | null): string => (v === null ? "—" : `${v} d`);

  const rows: [string, string][] = [
    ["Opportunities delivered", String(s.opportunitiesDelivered)],
    ["New to customer", String(s.newToCustomer)],
    ["Relevant rate", pct(s.relevantRate)],
    ["Worth-pursuing rate", pct(s.worthPursuingRate)],
    ["Relationship targets created", String(s.relationshipTargetsCreated)],
    ["Invitations connected to a public signal", String(s.invitationsConnectedToSignal)],
    ["Bids submitted", String(s.bidsSubmitted)],
    ["Wins / losses / no-bids", `${s.wins} / ${s.losses} / ${s.noBids}`],
    ["Influenced contract value (human-attributed)", fmtMoney(s.influencedContractValue)],
    ["Research time saved (min)", String(s.researchTimeSavedMinutes)],
    ["Duplicate delivery rate", pct(s.duplicateRate)],
    ["Expired delivery rate", pct(s.expiredRate)],
  ];

  return (
    <main>
      <h1>ROI scorecard — {account.name}</h1>
      <p style={{ color: "#666" }}>
        Trailing 90 days. Every number is reproduced from stored events — no manually edited
        aggregates. Attributable revenue is counted only where a human marked the outcome as
        OTN-influenced.
      </p>
      <p data-testid="unsupported-facts">
        Unsupported factual claims:{" "}
        <Badge tone={s.unsupportedFactCount === 0 ? "green" : "red"}>{s.unsupportedFactCount}</Badge>
      </p>
      <table style={table} data-testid="roi-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={cell}>{k}</td>
              <td style={{ ...cell, fontWeight: 600 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Lead time (backtest over stored events)</h2>
      <p style={{ color: "#666" }}>
        For your opportunities whose project reached a dated permit-issued milestone: how many
        days earlier the evidence graph first knew about the project (SEPA, entitlement,
        application…). Computed from stated event dates — what the sources could have told you,
        not when we happened to fetch them.
      </p>
      <table style={table} data-testid="leadtime-table">
        <tbody>
          <tr>
            <td style={cell}>Opportunities measured</td>
            <td style={{ ...cell, fontWeight: 600 }}>{lead.measured}</td>
          </tr>
          <tr>
            <td style={cell}>Median advance notice</td>
            <td style={{ ...cell, fontWeight: 600 }}>{d(lead.medianDays)}</td>
          </tr>
          <tr>
            <td style={cell}>P25 / P75</td>
            <td style={{ ...cell, fontWeight: 600 }}>
              {d(lead.p25Days)} / {d(lead.p75Days)}
            </td>
          </tr>
          <tr>
            <td style={cell}>≥30 / ≥60 / ≥90 days of notice</td>
            <td style={{ ...cell, fontWeight: 600 }}>
              {pct(lead.shareGte30d)} / {pct(lead.shareGte60d)} / {pct(lead.shareGte90d)}
            </td>
          </tr>
          <tr>
            <td style={cell}>No early warning (first sighting was the permit)</td>
            <td style={{ ...cell, fontWeight: 600 }}>{lead.noEarlyWarning}</td>
          </tr>
        </tbody>
      </table>

      <h2>First-look advantage — we see it before the boards</h2>
      <p style={{ color: "#666" }}>
        Per source and county: how often our earliest sighting of a project predates its
        permit-issued (publicly biddable) milestone, and — when it does — the median days of
        lead. Once a permit issues it surfaces on the aggregator bid boards, so this is the
        head start OTN gives you over everyone quoting off those boards. Permit-only sources
        sit near zero (they see it at permit time); pre-permit coverage is where the lead comes
        from. Groups below {20} milestoned projects are omitted, never shown thin.
      </p>
      <table style={table} data-testid="first-look-table">
        <thead>
          <tr>
            <th style={cell}>Source</th>
            <th style={cell}>County</th>
            <th style={cell}>Projects</th>
            <th style={cell}>Surfaced pre-permit</th>
            <th style={cell}>Median lead when early</th>
          </tr>
        </thead>
        <tbody>
          {firstLook.length === 0 ? (
            <tr>
              <td style={cell} colSpan={5}>
                No source×county group meets the sample floor yet.
              </td>
            </tr>
          ) : (
            firstLook.map((f) => (
              <tr key={`${f.sourceKey}:${f.county ?? "statewide"}`}>
                <td style={cell}>{f.sourceKey}</td>
                <td style={cell}>{f.county ?? "statewide"}</td>
                <td style={cell}>{f.projects}</td>
                <td style={{ ...cell, fontWeight: 600 }}>{pct(f.shareEarly)}</td>
                <td style={{ ...cell, fontWeight: 600 }}>{d(f.medianLeadDaysWhenEarly)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2>Source detection lag</h2>
      <p style={{ color: "#666" }}>
        Days between a record&apos;s stated event date and when OTN first ingested it. The
        all-time median includes historical backfill (ingested long after the fact by design);
        the trailing-30-day column is live freshness.
      </p>
      <table style={table} data-testid="detection-lag-table">
        <thead>
          <tr>
            <th style={cell}>Source</th>
            <th style={cell}>Events</th>
            <th style={cell}>Median lag (all time, incl. backfill)</th>
            <th style={cell}>Median lag (last 30d)</th>
          </tr>
        </thead>
        <tbody>
          {lag.map((row) => (
            <tr key={row.sourceKey}>
              <td style={cell}>{row.sourceKey}</td>
              <td style={cell}>{row.events}</td>
              <td style={cell}>{d(row.medianDaysAllTime)}</td>
              <td style={cell}>
                {row.recentEvents > 0 ? d(row.medianDaysRecent) : "— (no recent records)"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
