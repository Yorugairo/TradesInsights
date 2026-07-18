import { redirect } from "next/navigation";
import { pipelineSummary } from "@otn/delivery";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { cell, fmtMoney, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

/** The premium headline: what OTN got you. Sourced → pursued → bid → won, with
 * dollars where a human recorded them, plus the lead-time-vs-boards proof.
 * Every number is reproduced from stored rows — no manual aggregates. */
export default async function PipelinePage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");

  const p = await pipelineSummary(db(), account.id);
  const funnel: [string, number][] = [
    ["Surfaced by OTN", p.surfacedByOtn],
    ["Pursuits opened", p.pursuitsStarted],
    ["Reached bidding", p.reachedBidding],
    ["Submitted", p.reachedSubmission],
    ["Won", p.won],
    ["Lost", p.lost],
  ];
  const maxN = Math.max(1, ...funnel.map(([, n]) => n));
  const h = p.firstLookHeadline;

  return (
    <main>
      <h1>Your OTN pipeline — {account.name}</h1>
      <p style={{ color: "#666" }}>
        Everything below is reproduced from stored events and your own pursuit records — no
        manually edited totals. Dollars are counted only where you entered them; contract value is
        marked influenced only where you attributed it to OTN.
      </p>

      {/* Headline dollars */}
      <div
        data-testid="pipeline-headline"
        style={{ display: "flex", gap: "1rem", flexWrap: "wrap", margin: "1rem 0" }}
      >
        {[
          ["Won (your entry)", fmtMoney(p.wonValueUsd)],
          ["In flight", fmtMoney(p.inFlightValueUsd)],
          ["OTN-influenced value", fmtMoney(p.influencedValueUsd)],
        ].map(([k, v]) => (
          <div
            key={k}
            style={{ flex: "1 1 160px", border: "1px solid #cfe3d0", background: "#f4faf5", borderRadius: 8, padding: "0.75rem 1rem" }}
          >
            <div style={{ fontSize: "0.8rem", color: "#6b6b6b" }}>{k}</div>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* The lead-time-vs-boards proof, front and center */}
      {(p.medianAdvanceNoticeDays !== null || h) && (
        <p data-testid="pipeline-leadtime" style={{ fontSize: "1.05rem", margin: "1rem 0" }}>
          {p.medianAdvanceNoticeDays !== null && (
            <>
              Median advance notice on your milestoned projects:{" "}
              <strong>{p.medianAdvanceNoticeDays} days</strong> before the permit issued.{" "}
            </>
          )}
          {h && (
            <>
              In {h.county ?? "your coverage"}, OTN surfaced{" "}
              <strong>{Math.round((h.shareEarly ?? 0) * 100)}%</strong> of{" "}
              {h.sourceKey.replaceAll("_", " ")} projects a median of{" "}
              <strong>{h.medianLeadDaysWhenEarly} days</strong> before the permit — before they
              reach the public bid boards.
            </>
          )}
        </p>
      )}

      {/* Funnel */}
      <h2>Funnel</h2>
      <table style={table} data-testid="pipeline-funnel">
        <tbody>
          {funnel.map(([k, n]) => (
            <tr key={k}>
              <td style={{ ...cell, width: 160 }}>{k}</td>
              <td style={{ ...cell, fontWeight: 600, width: 60 }}>{n}</td>
              <td style={cell}>
                <div
                  style={{
                    height: 14,
                    width: `${(n / maxN) * 100}%`,
                    minWidth: n > 0 ? 4 : 0,
                    background: k === "Won" ? "#2f8f4e" : k === "Lost" ? "#b04a4a" : "#7aa7c7",
                    borderRadius: 3,
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "#666", fontSize: "0.85rem" }}>
        &ldquo;Surfaced by OTN&rdquo; is opportunities in your priority/digest bands; the rest come
        from your pursuit records. Win/loss dollars and OTN-influence are yours to record on each
        pursuit.
      </p>
    </main>
  );
}
