import Link from "next/link";
import { redirect } from "next/navigation";
import { PURSUIT_STATES, listPursuits } from "@otn/intelligence";
import StatTile from "../../../components/proof/StatTile.js";
import EmptyState from "../../../components/ui/EmptyState.js";
import PageHeader from "../../../components/ui/PageHeader.js";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { Badge, fmtDate } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

// Board columns are the active pipeline stages; terminal states get a tail column.
const COLUMNS = PURSUIT_STATES.filter((s) => s !== "archived");

export default async function PursuitsPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");

  const all = await listPursuits(db(), account.id);
  const byState = new Map<string, typeof all>();
  for (const p of all) {
    const list = byState.get(p.state) ?? [];
    list.push(p);
    byState.set(p.state, list);
  }
  const active = all.filter((p) => p.state !== "archived").length;
  const overdue = all.filter((p) => p.overdue).length;

  return (
    <main>
      <PageHeader
        title="Pursuits"
        description={`${account.name} — the bid/no-bid workflow for opportunities you have taken on.`}
      />

      <div className="mb-[calc(var(--stack)*1.5)] grid grid-cols-2 gap-3 sm:grid-cols-3">
        {/*
          `pursuit-count` is asserted, so the number keeps its own element. It
          moves into a StatTile rather than staying a <strong> in a sentence —
          same value, same testid, and now it is legible from across the room.
        */}
        <StatTile tone="gold" value={active} valueTestId="pursuit-count" label="Active pursuits" />
        <StatTile
          value={overdue}
          label="Overdue"
          detail={overdue > 0 ? "Next action date has passed" : "Nothing past its next action"}
        />
        <StatTile value={all.length} label="All pursuits" detail="Including archived" />
      </div>

      {all.length === 0 ? (
        <EmptyState
          data-testid="pursuits-empty"
          title="No pursuits yet."
          reason="A pursuit is opened by hand from an opportunity — nothing creates one automatically, so an empty board means none have been started, not that none were found."
        />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {COLUMNS.map((state) => {
            const items = byState.get(state) ?? [];
            return (
              <section
                key={state}
                data-testid={`pursuit-col-${state}`}
                className="min-w-[14rem] shrink-0 rounded-lg border border-line bg-surface p-2"
              >
                <h3 className="mb-2 text-2xs uppercase tracking-[0.08em] text-ink-muted">
                  {state.replaceAll("_", " ")} ({items.length})
                </h3>
                <div className="flex flex-col gap-2">
                  {items.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-md border border-line-strong bg-surface-raised p-2"
                    >
                      <Link
                        href={`/app/pursuits/${p.id}`}
                        className="font-semibold text-ink underline decoration-line-strong underline-offset-2"
                      >
                        {p.projectName}
                      </Link>
                      <div className="mt-1 text-xs text-ink-muted">
                        owner {p.ownerUserId} · tasks {p.openTasks}
                        {p.overdue && (
                          <>
                            {" "}
                            <Badge tone="red">overdue</Badge>
                          </>
                        )}
                      </div>
                      {p.nextActionAt && (
                        <div className="mt-0.5 text-xs tabular-nums text-ink-subtle">
                          next {fmtDate(p.nextActionAt)}
                        </div>
                      )}
                    </div>
                  ))}
                  {items.length === 0 && (
                    <p className="px-1 py-2 text-xs text-ink-subtle">Nothing in this stage.</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
