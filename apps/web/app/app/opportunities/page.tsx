import Link from "next/link";
import { redirect } from "next/navigation";
import { COUNTIES, PROJECT_STAGES } from "@otn/domain";
import ConfidenceMeter from "../../../components/proof/ConfidenceMeter.js";
import ScoreBar, {
  DEFAULT_DIGEST_MIN,
  DEFAULT_PRIORITY_MIN,
} from "../../../components/proof/ScoreBar.js";
import StatTile from "../../../components/proof/StatTile.js";
import EmptyState from "../../../components/ui/EmptyState.js";
import PageHeader from "../../../components/ui/PageHeader.js";
import Table, { HeadTr, Td, Th, Tr } from "../../../components/ui/Table.js";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { bandLabel, bandTone, formatScore, routeLabel, stageLabel } from "../../../lib/format.js";
import { accountByKey, listOpportunities, opportunityBandSummary } from "../../../lib/queries.js";
import { Badge, fmtDate } from "../../../lib/ui.js";
import { emptyReason } from "./empty-reason.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

type Params = {
  state?: string;
  county?: string;
  stage?: string;
  q?: string;
  campus?: string;
  sort?: string;
  page?: string;
};

function qs(params: Params, overrides: Partial<Record<keyof Params, string | undefined>>): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * The band control's options.
 *
 * `value: undefined` is the default view, and it is NOT "all": `listOpportunities`
 * applies `AND o.state != 'archive'` when no state is given. The old control
 * labelled that default "all" and highlighted it as such, which told the operator
 * they were seeing every row while archive was silently withheld. Active and All
 * are separate options here because they are separate queries.
 */
const BANDS: { value: string | undefined; label: string }[] = [
  { value: undefined, label: "Active" },
  { value: "priority_review", label: bandLabel("priority_review") },
  { value: "weekly_digest", label: bandLabel("weekly_digest") },
  { value: "promoted", label: bandLabel("promoted") },
  { value: "dismissed", label: bandLabel("dismissed") },
  { value: "archive", label: bandLabel("archive") },
  { value: "all", label: "All" },
];

const FIELD =
  "rounded-sm border border-line-strong bg-surface px-2 py-1 text-sm text-ink";


export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const filters = {
    ...(params.state ? { state: params.state } : {}),
    ...(params.county ? { county: params.county } : {}),
    ...(params.stage ? { stage: params.stage } : {}),
    ...(params.q ? { q: params.q } : {}),
    ...(params.campus === "1" ? { campusOnly: true } : {}),
    ...(params.sort === "recent" ? { sort: "recent" as const } : {}),
  };
  // SEQUENTIAL, NOT `Promise.all`. The production pool max is 2. Issuing both
  // reads concurrently makes this one page hold BOTH connections for the length
  // of the slower query, which starves every other in-flight request — measured,
  // not theorised: with `Promise.all` the e2e suite failed 3 of 28 (login POST
  // never returned, /app/admin/cockpit hit `statement_timeout` 57014, /app/radar
  // never navigated) and the run took 4.7m. The same suite on the same database
  // minutes earlier was 28/28 in 1.2m. Awaiting in series costs one query's
  // latency on this page and costs the rest of the app nothing.
  const { items, total } = await listOpportunities(db(), account.id, {
    ...filters,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const summary = await opportunityBandSummary(db(), account.id, filters);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // The account's own banding thresholds, defaulted exactly as the scorer
  // defaults them (scoring.ts:387-394) so the bar explains the real banding.
  const priorityMin = account.delivery.priority_review_min ?? DEFAULT_PRIORITY_MIN;
  const digestMin = account.delivery.weekly_digest_min ?? DEFAULT_DIGEST_MIN;

  const priorityCount = summary.byState["priority_review"] ?? 0;
  const activeCount = summary.total - (summary.byState["archive"] ?? 0);
  const bandCount = (value: string | undefined): number =>
    value === undefined ? activeCount : value === "all" ? summary.total : (summary.byState[value] ?? 0);
  const currentBand = params.state;

  return (
    <main>
      <PageHeader
        title="Opportunities"
        description={`${account.name} — every project scored against this account's capabilities, territory and capacity.`}
        action={
          priorityCount > 0 ? (
            // The one next action for this screen. Not a filter among filters:
            // priority review is the band that is waiting on a human decision.
            <Link
              href={`/app/opportunities${qs(params, { state: "priority_review", page: undefined })}`}
              className="inline-flex items-center rounded-sm border border-line-strong bg-[image:var(--panel-gold-bg)] px-3 py-2 text-sm font-semibold text-accent-ink"
            >
              Decide on {priorityCount} in priority review →
            </Link>
          ) : null
        }
      />

      <div className="mb-[calc(var(--stack)*1.5)] grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          tone="gold"
          value={priorityCount}
          label="Priority review"
          detail={`Score ≥ ${priorityMin}`}
        />
        <StatTile
          value={summary.byState["weekly_digest"] ?? 0}
          label="Weekly digest"
          detail={`Score ≥ ${digestMin}`}
        />
        <StatTile
          value={summary.byState["promoted"] ?? 0}
          label="Promoted"
          detail="Moved forward by hand"
        />
        <StatTile
          value={summary.unscored}
          label="Not yet scored"
          // The never-fabricate rule as a number: these rows have no score, and
          // that is different from having a score of zero.
          detail="Scorer has not run — not a zero"
        />
      </div>

      <nav aria-label="Band" className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-muted">Band</span>
        {BANDS.map((b) => {
          const active = currentBand === b.value;
          return (
            <Link
              key={b.label}
              href={`/app/opportunities${qs(params, { state: b.value, page: undefined })}`}
              aria-current={active ? "page" : undefined}
              className={[
                "inline-flex items-baseline gap-1.5 rounded-full border px-3 py-1 text-sm",
                active
                  ? "border-accent bg-surface-raised font-semibold text-ink"
                  : "border-line text-ink-muted",
              ].join(" ")}
            >
              {b.label}
              <span className="text-2xs tabular-nums text-ink-subtle">{bandCount(b.value)}</span>
            </Link>
          );
        })}
      </nav>

      <form
        method="get"
        data-testid="opportunity-filters"
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        {params.state && <input type="hidden" name="state" value={params.state} />}
        <input
          type="search"
          name="q"
          placeholder="Search name, jurisdiction, address"
          defaultValue={params.q ?? ""}
          className={`${FIELD} min-w-[16rem] flex-1`}
          data-testid="filter-q"
        />
        <select name="county" defaultValue={params.county ?? ""} className={FIELD} data-testid="filter-county">
          <option value="">All counties</option>
          {COUNTIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select name="stage" defaultValue={params.stage ?? ""} className={FIELD}>
          <option value="">All stages</option>
          {PROJECT_STAGES.map((s) => (
            <option key={s} value={s}>
              {stageLabel(s)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-muted">
          <input type="checkbox" name="campus" value="1" defaultChecked={params.campus === "1"} />
          active campus
        </label>
        <select name="sort" defaultValue={params.sort ?? "score"} className={FIELD}>
          <option value="score">by score</option>
          <option value="recent">recently changed</option>
        </select>
        <button
          type="submit"
          className="rounded-sm border border-line-strong bg-surface-raised px-3 py-1 text-sm font-semibold text-ink"
        >
          Apply
        </button>
        <Link href="/app/opportunities" className="text-sm text-ink-muted underline">
          reset
        </Link>
      </form>

      <p data-testid="opportunity-count" className="mb-2 text-sm text-ink-muted">
        {total} matching · page {page} of {pages}
      </p>

      {items.length === 0 ? (
        <EmptyState
          title="No opportunities match these filters."
          reason={emptyReason(params, summary.total)}
          action={
            <Link href="/app/opportunities" className="text-sm text-ink underline">
              Clear filters
            </Link>
          }
        />
      ) : (
        <Table
          data-testid="opportunities-table"
          caption={`Opportunities for ${account.name}, ${total} matching`}
          head={
            <HeadTr>
              <Th>Project</Th>
              <Th>Stage</Th>
              <Th numeric>Score</Th>
              <Th>Band</Th>
              <Th>Corroboration</Th>
              <Th>Last change</Th>
            </HeadTr>
          }
        >
          {items.map((o) => (
            <Tr key={o.id}>
              <Td>
                <Link
                  href={`/app/opportunities/${o.id}`}
                  className="font-semibold text-ink underline decoration-line-strong underline-offset-2"
                >
                  {o.projectName}
                </Link>
                {o.campusBlock && (
                  <>
                    {" "}
                    <Badge tone="green">campus</Badge>
                  </>
                )}
                <div className="mt-0.5 text-xs text-ink-muted">
                  {o.county} County · {o.permittingJurisdiction}
                </div>
              </Td>
              <Td>{stageLabel(o.stage)}</Td>
              <Td numeric>
                <div className="font-semibold tabular-nums text-ink">{formatScore(o.score)}</div>
                <div className="mt-1 w-16">
                  <ScoreBar score={o.score} priorityMin={priorityMin} digestMin={digestMin} />
                </div>
              </Td>
              <Td>
                <Badge tone={bandTone(o.state)}>{bandLabel(o.state)}</Badge>
                <div className="mt-0.5 text-xs text-ink-muted">{routeLabel(o.route)}</div>
              </Td>
              <Td>
                <ConfidenceMeter corroboration={o.corroboration} compact />
              </Td>
              {/* ISO dates are one token; letting them wrap turns 2026-07-09
                  into two lines and costs more width than nowrap does. */}
              <Td className="whitespace-nowrap tabular-nums">{fmtDate(o.lastMaterialChangeAt)}</Td>
            </Tr>
          ))}
        </Table>
      )}

      <p className="mt-4 flex gap-4 text-sm">
        {page > 1 && (
          <Link href={`/app/opportunities${qs(params, { page: String(page - 1) })}`} className="text-ink underline">
            ← previous
          </Link>
        )}
        {page < pages && (
          <Link href={`/app/opportunities${qs(params, { page: String(page + 1) })}`} className="text-ink underline">
            next →
          </Link>
        )}
      </p>
    </main>
  );
}
