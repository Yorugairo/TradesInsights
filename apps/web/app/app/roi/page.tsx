import { redirect } from "next/navigation";
import { roiScorecard } from "@otn/delivery";
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
    </main>
  );
}
