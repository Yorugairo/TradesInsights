import Link from "next/link";
import { redirect } from "next/navigation";
import StatTile from "../../../../components/proof/StatTile.js";
import PageHeader from "../../../../components/ui/PageHeader.js";
import Table, { HeadTr, Td, Th, Tr } from "../../../../components/ui/Table.js";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { listSourcesAdmin } from "../../../../lib/queries.js";
import { Badge, fmtDate, healthTone } from "../../../../lib/ui.js";
import { SourceActions } from "./actions.js";

export const dynamic = "force-dynamic";

export default async function AdminSourcesPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");
  const sources = await listSourcesAdmin(db());

  const red = sources.filter((s) => s.freshnessState === "red").length;
  const amber = sources.filter((s) => s.freshnessState === "amber").length;
  // A source that has never succeeded is not "stale" — it has never worked at
  // all, and that is a different repair job. Folding it into amber/red would
  // hide it inside a number that reads as a freshness problem.
  const neverRan = sources.filter((s) => s.lastSuccessAt === null).length;

  return (
    <main>
      <PageHeader
        title="Sources"
        description="Every configured feed, its freshness state, and its last run. Freshness is measured against each source's own cadence, so a monthly source is not red for being a week old."
      />

      <div className="mb-[calc(var(--stack)*1.5)] grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile value={sources.length} label="Configured" />
        <StatTile value={sources.filter((s) => s.enabled).length} label="Enabled" />
        <StatTile
          tone={red > 0 ? "gold" : "neutral"}
          value={red}
          label="Red"
          detail={amber > 0 ? `${amber} amber` : "No amber"}
        />
        <StatTile
          value={neverRan}
          label="Never succeeded"
          detail="No successful run on record — not the same as stale"
        />
      </div>

      <Table
        data-testid="sources-table"
        caption="Configured sources with health and last run"
        head={
          <HeadTr>
            <Th>Key</Th>
            <Th>County</Th>
            <Th>Enabled</Th>
            <Th>Health</Th>
            <Th>Last success</Th>
            <Th>Last run</Th>
            <Th numeric>Records</Th>
            <Th>Actions</Th>
          </HeadTr>
        }
      >
        {sources.map((s) => (
          <Tr key={s.id}>
            <Td>
              <div className="font-semibold text-ink">{s.key}</div>
              <div className="mt-0.5 text-xs text-ink-muted">{s.name}</div>
            </Td>
            <Td>{s.county ?? "—"}</Td>
            <Td>{s.enabled ? <Badge tone="green">yes</Badge> : <Badge tone="gray">no</Badge>}</Td>
            <Td>
              <Badge tone={healthTone(s.freshnessState)}>{s.freshnessState}</Badge>
            </Td>
            <Td className="whitespace-nowrap tabular-nums">
              {s.lastSuccessAt ? fmtDate(s.lastSuccessAt) : <span className="text-ink-subtle">never</span>}
            </Td>
            <Td>
              {s.lastRun ? (
                <Link
                  href={`/app/admin/source-runs/${s.lastRun.id}`}
                  className="whitespace-nowrap text-ink underline decoration-line-strong underline-offset-2"
                >
                  {s.lastRun.status} · p{s.lastRun.parsedCount} r{s.lastRun.rejectedCount} e
                  {s.lastRun.errorCount}
                </Link>
              ) : (
                "—"
              )}
            </Td>
            <Td numeric>{s.recordCount}</Td>
            <Td>
              <SourceActions sourceKey={s.key} enabled={s.enabled} />
            </Td>
          </Tr>
        ))}
      </Table>
    </main>
  );
}
