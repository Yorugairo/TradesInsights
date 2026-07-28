import { redirect } from "next/navigation";
import { pipelineSummary } from "@otn/delivery";
import StatTile from "../../../components/proof/StatTile.js";
import PageHeader from "../../../components/ui/PageHeader.js";
import Panel from "../../../components/ui/Panel.js";
import Table, { Td, Tr } from "../../../components/ui/Table.js";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { fmtMoney } from "../../../lib/ui.js";

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
      <PageHeader
        title="Your OTN pipeline"
        description={`${account.name} — reproduced from stored events and your own pursuit records, with no manually edited totals. Dollars are counted only where you entered them; contract value is marked influenced only where you attributed it to OTN.`}
      />

      <div
        data-testid="pipeline-headline"
        className="mb-[calc(var(--stack)*1.5)] grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        {/*
          `fmtMoney` renders an absent figure as the em dash, so a customer who
          has recorded nothing sees "—" and not "$0". The difference matters here
          more than anywhere: $0 won reads as a verdict on the product.
        */}
        <StatTile tone="gold" value={fmtMoney(p.wonValueUsd)} label="Won (your entry)" />
        <StatTile value={fmtMoney(p.inFlightValueUsd)} label="In flight" />
        <StatTile
          value={fmtMoney(p.influencedValueUsd)}
          label="OTN-influenced value"
          detail="Only where you attributed it"
        />
      </div>

      {(p.medianAdvanceNoticeDays !== null || h) && (
        <p data-testid="pipeline-leadtime" className="mb-[calc(var(--stack)*1.5)] max-w-[70ch] text-base text-ink">
          {p.medianAdvanceNoticeDays !== null && (
            <>
              Median advance notice on your milestoned projects:{" "}
              <strong className="tabular-nums">{p.medianAdvanceNoticeDays} days</strong> before the
              permit issued.{" "}
            </>
          )}
          {h && (
            <>
              In {h.county ?? "your coverage"}, OTN surfaced{" "}
              <strong className="tabular-nums">{Math.round((h.shareEarly ?? 0) * 100)}%</strong> of{" "}
              {h.sourceKey.replaceAll("_", " ")} projects a median of{" "}
              <strong className="tabular-nums">{h.medianLeadDaysWhenEarly} days</strong> before the
              permit — before they reach the public bid boards.
            </>
          )}
        </p>
      )}

      <Panel
        title="Funnel"
        detail="“Surfaced by OTN” is opportunities in your priority/digest bands; the rest come from your pursuit records. Win/loss dollars and OTN-influence are yours to record on each pursuit."
      >
        <Table data-testid="pipeline-funnel" caption="Pipeline funnel counts">
          {funnel.map(([k, n]) => (
            <Tr key={k}>
              <Td className="w-40 whitespace-nowrap">{k}</Td>
              <Td numeric className="w-16 font-semibold">
                {n}
              </Td>
              <Td>
                <div
                  className={[
                    "h-3.5 rounded-sm",
                    k === "Won" ? "bg-ok" : k === "Lost" ? "bg-bad" : "bg-accent",
                  ].join(" ")}
                  // Legitimately dynamic: the width IS the datum. `minWidth`
                  // keeps a non-zero count visible instead of rounding it away,
                  // while a true zero stays a zero-width bar.
                  style={{ width: `${(n / maxN) * 100}%`, minWidth: n > 0 ? 4 : 0 }}
                />
              </Td>
            </Tr>
          ))}
        </Table>
      </Panel>
    </main>
  );
}
