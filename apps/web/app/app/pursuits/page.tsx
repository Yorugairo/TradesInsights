import Link from "next/link";
import { redirect } from "next/navigation";
import { PURSUIT_STATES, listPursuits } from "@otn/intelligence";
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

  return (
    <main>
      <h1>Pursuits</h1>
      <p>
        Active pursuits: <strong data-testid="pursuit-count">{all.filter((p) => p.state !== "archived").length}</strong> ·
        overdue: <strong>{all.filter((p) => p.overdue).length}</strong>
      </p>
      {all.length === 0 && (
        <p data-testid="pursuits-empty">
          No pursuits yet. Open one from an opportunity to start tracking a bid/no-bid workflow.
        </p>
      )}
      <div style={{ display: "flex", gap: "0.75rem", overflowX: "auto", paddingBottom: "1rem" }}>
        {COLUMNS.map((state) => {
          const items = byState.get(state) ?? [];
          return (
            <section
              key={state}
              data-testid={`pursuit-col-${state}`}
              style={{ minWidth: 220, border: "1px solid #eee", borderRadius: 8, padding: "0.5rem" }}
            >
              <h3 style={{ fontSize: "0.9rem", marginTop: 0 }}>
                {state.replaceAll("_", " ")} ({items.length})
              </h3>
              {items.map((p) => (
                <div
                  key={p.id}
                  style={{ border: "1px solid #ddd", borderRadius: 6, padding: "0.5rem", marginBottom: "0.5rem" }}
                >
                  <Link href={`/app/pursuits/${p.id}`}>
                    <strong>{p.projectName}</strong>
                  </Link>
                  <div style={{ fontSize: "0.8rem", color: "#555" }}>
                    owner {p.ownerUserId} · tasks {p.openTasks}
                    {p.overdue && (
                      <>
                        {" "}
                        <Badge tone="red">overdue</Badge>
                      </>
                    )}
                  </div>
                  {p.nextActionAt && (
                    <div style={{ fontSize: "0.75rem", color: "#777" }}>next {fmtDate(p.nextActionAt)}</div>
                  )}
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </main>
  );
}
