import { redirect } from "next/navigation";
import {
  detectionLagBySource,
  evidenceLeadTime,
  firstLookByCoverage,
  outcomeAttribution,
  roiScorecard,
} from "@otn/delivery";
import StatTile from "../../../components/proof/StatTile.js";
import Card, { CardBody } from "../../../components/ui/Card.js";
import EmptyState from "../../../components/ui/EmptyState.js";
import PageHeader from "../../../components/ui/PageHeader.js";
import Panel from "../../../components/ui/Panel.js";
import Table, { HeadTr, Td, Th, Tr } from "../../../components/ui/Table.js";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { fmtMoney } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

/** Trailing window for the scorecard, in days. */
const WINDOW_DAYS = 90;
/** Groups thinner than this are omitted from first-look, never shown thin. */
const FIRST_LOOK_FLOOR = 20;

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/** A two-column figure row. Absent renders as the em dash upstream, never 0. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Tr>
      <Td>{label}</Td>
      <Td numeric className="font-semibold">
        {value}
      </Td>
    </Tr>
  );
}

export default async function RoiPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86_400_000);

  // SEQUENTIAL. This was a `Promise.all` of four reads against a pool whose max
  // is 2 — so two ran, two queued, and the page held BOTH connections for the
  // duration while every other request waited. Measured elsewhere in this
  // retrofit: that pattern cost three e2e failures on pages the change never
  // touched. Concurrency here could buy 2x at most and costs the rest of the
  // app everything.
  const s = await roiScorecard(db(), account.id, { start, end });
  const lead = await evidenceLeadTime(db(), account.id);
  const lag = await detectionLagBySource(db());
  const firstLook = await firstLookByCoverage(db());
  const outcomes = await outcomeAttribution(db(), account.id);

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

  const clean = s.unsupportedFactCount === 0;

  return (
    <main>
      <PageHeader
        title="ROI scorecard"
        description={`${account.name} — trailing ${WINDOW_DAYS} days. Every number is reproduced from stored events, with no manually edited aggregates. Attributable revenue is counted only where a human marked the outcome as OTN-influenced.`}
      />

      {/*
        "What we could not verify" leads the page.
        It used to be a one-line <p> with a badge, below the fold of the header.
        The plan's instruction for this page is that `unsupported-facts` gets
        MORE prominent, never less — it is the number that makes every other
        number on the page worth reading, and a product that hides its own
        error count is asking to be trusted rather than earning it.
      */}
      <Card
        tone={clean ? "neutral" : "gold"}
        className={`mb-[calc(var(--stack)*1.5)] ${clean ? "" : "border-bad"}`}
      >
        <CardBody>
          <p data-testid="unsupported-facts" className="flex flex-wrap items-baseline gap-3">
            <span
              className={`text-stat font-extrabold tabular-nums ${clean ? "text-ok" : "text-bad"}`}
            >
              {s.unsupportedFactCount}
            </span>
            <span className="text-2xs uppercase tracking-[0.08em] text-ink-muted">
              Unsupported factual claims
            </span>
            <span className="text-sm text-ink-muted">
              {clean
                ? "Every claim delivered in this window traces to cited evidence."
                : "Claims delivered without evidence that survives the gate. This is a defect count, not a metric to optimise."}
            </span>
          </p>
        </CardBody>
      </Card>

      <div className="mb-[calc(var(--stack)*1.5)] grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile tone="gold" value={s.opportunitiesDelivered} label="Delivered" detail={`Last ${WINDOW_DAYS} days`} />
        <StatTile value={pct(s.worthPursuingRate)} label="Worth pursuing" detail="Your own feedback" />
        <StatTile value={s.bidsSubmitted} label="Bids submitted" />
        <StatTile
          value={fmtMoney(s.influencedContractValue)}
          label="Influenced value"
          detail="Only where you attributed it"
        />
      </div>

      <Panel title="Scorecard" detail={`Trailing ${WINDOW_DAYS} days, reproduced from stored events.`}>
        <Table data-testid="roi-table" caption="ROI scorecard figures">
          {rows.map(([k, v]) => (
            <Figure key={k} label={k} value={v} />
          ))}
        </Table>
      </Panel>

      <Panel
        title="Outcomes — from your own decisions"
        detail="Rolled up from the decision ledger: every won / lost / no-bid you recorded, with the snapshot taken at decision time. The win rate stays hidden until 5 decided bids — never a thin percentage."
      >
        {outcomes.decided === 0 ? (
          <EmptyState
            data-testid="outcomes-empty"
            title="No decided outcomes yet."
            reason="Outcomes are recorded by hand on a pursuit — nothing infers a win or a loss — so an empty ledger means none have been marked, not that none happened."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <Table data-testid="outcomes-table" caption="Recorded outcomes">
              <Figure
                label="Decided (won / lost / no-bid)"
                value={`${outcomes.decided} (${outcomes.wins} / ${outcomes.losses} / ${outcomes.noBids})`}
              />
              <Figure label="Win rate (of decided bids)" value={pct(outcomes.winRate)} />
              <Figure label="Won contract value (as recorded)" value={fmtMoney(outcomes.wonValue)} />
            </Table>
            {outcomes.byCounty.length > 0 && (
              <Table
                data-testid="outcomes-by-county"
                caption="Recorded outcomes by county"
                head={
                  <HeadTr>
                    <Th>County</Th>
                    <Th numeric>Won</Th>
                    <Th numeric>Lost</Th>
                    <Th numeric>No-bid</Th>
                    <Th numeric>Won value</Th>
                  </HeadTr>
                }
              >
                {outcomes.byCounty.map((b) => (
                  <Tr key={b.key}>
                    <Td>{b.key}</Td>
                    <Td numeric>{b.wins}</Td>
                    <Td numeric>{b.losses}</Td>
                    <Td numeric>{b.noBids}</Td>
                    <Td numeric>{b.wonValue ? fmtMoney(b.wonValue) : "—"}</Td>
                  </Tr>
                ))}
              </Table>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="Lead time (backtest over stored events)"
        detail="For your opportunities whose project reached a dated permit-issued milestone: how many days earlier the evidence graph first knew about the project (SEPA, entitlement, application…). Computed from stated event dates — what the sources could have told you, not when we happened to fetch them."
      >
        <Table data-testid="leadtime-table" caption="Lead-time backtest">
          <Figure label="Opportunities measured" value={String(lead.measured)} />
          <Figure label="Median advance notice" value={d(lead.medianDays)} />
          <Figure label="P25 / P75" value={`${d(lead.p25Days)} / ${d(lead.p75Days)}`} />
          <Figure
            label="≥30 / ≥60 / ≥90 days of notice"
            value={`${pct(lead.shareGte30d)} / ${pct(lead.shareGte60d)} / ${pct(lead.shareGte90d)}`}
          />
          <Figure
            label="No early warning (first sighting was the permit)"
            value={String(lead.noEarlyWarning)}
          />
        </Table>
      </Panel>

      <Panel
        title="First-look advantage — we see it before the boards"
        detail={`Per source and county: how often our earliest sighting of a project predates its permit-issued (publicly biddable) milestone, and — when it does — the median days of lead. Once a permit issues it surfaces on the aggregator bid boards, so this is the head start OTN gives you over everyone quoting off those boards. Permit-only sources sit near zero (they see it at permit time); pre-permit coverage is where the lead comes from. Groups below ${FIRST_LOOK_FLOOR} milestoned projects are omitted, never shown thin.`}
      >
        <Table
          data-testid="first-look-table"
          caption="First-look advantage by source and county"
          head={
            <HeadTr>
              <Th>Source</Th>
              <Th>County</Th>
              <Th numeric>Projects</Th>
              <Th numeric>Surfaced pre-permit</Th>
              <Th numeric>Median lead when early</Th>
            </HeadTr>
          }
        >
          {firstLook.length === 0 ? (
            <Tr>
              <Td className="text-ink-muted">
                No source×county group meets the {FIRST_LOOK_FLOOR}-project sample floor yet. The
                groups exist; they are withheld rather than shown thin.
              </Td>
            </Tr>
          ) : (
            firstLook.map((f) => (
              <Tr key={`${f.sourceKey}:${f.county ?? "statewide"}`}>
                <Td>{f.sourceKey}</Td>
                <Td>{f.county ?? "statewide"}</Td>
                <Td numeric>{f.projects}</Td>
                <Td numeric className="font-semibold">
                  {pct(f.shareEarly)}
                </Td>
                <Td numeric className="font-semibold">
                  {d(f.medianLeadDaysWhenEarly)}
                </Td>
              </Tr>
            ))
          )}
        </Table>
      </Panel>

      <Panel
        title="Source detection lag"
        detail="Days between a record's stated event date and when OTN first ingested it. The all-time median includes historical backfill (ingested long after the fact by design); the trailing-30-day column is live freshness."
      >
        <Table
          data-testid="detection-lag-table"
          caption="Detection lag by source"
          head={
            <HeadTr>
              <Th>Source</Th>
              <Th numeric>Events</Th>
              <Th numeric>Median lag (all time, incl. backfill)</Th>
              <Th numeric>Median lag (last 30d)</Th>
            </HeadTr>
          }
        >
          {lag.map((row) => (
            <Tr key={row.sourceKey}>
              <Td>{row.sourceKey}</Td>
              <Td numeric>{row.events}</Td>
              <Td numeric>{d(row.medianDaysAllTime)}</Td>
              {/* "no recent records" is not the same as a lag of zero. */}
              <Td numeric className={row.recentEvents > 0 ? "" : "text-ink-subtle"}>
                {row.recentEvents > 0 ? d(row.medianDaysRecent) : "— no recent records"}
              </Td>
            </Tr>
          ))}
        </Table>
      </Panel>
    </main>
  );
}
