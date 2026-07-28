import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  fieldRollup,
  getPursuitDetail,
  getTakeoffSheet,
  listFieldEntries,
  listFieldLinks,
} from "@otn/intelligence";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { accountByKey } from "../../../../lib/queries.js";
import { Badge, cell, fmtDate, fmtMoney, table } from "../../../../lib/ui.js";
import { PursuitActions } from "./actions.js";
import { FieldSection } from "./field-section.js";

export const dynamic = "force-dynamic";

export default async function PursuitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { id } = await params;
  const p = await getPursuitDetail(db(), id);
  if (!p || p.accountProfileId !== account.id) notFound();
  // Sequential on purpose — the web pool caps at 2 connections.
  const sheet = await getTakeoffSheet(db(), p.id);
  const links = await listFieldLinks(db(), p.id);
  const entries = await listFieldEntries(db(), p.id, { limit: 25 });
  const rollup = await fieldRollup(db(), p.id);

  return (
    <main>
      <h1 data-testid="pursuit-title">{p.projectName}</h1>
      <p>
        <Badge>{p.state.replaceAll("_", " ")}</Badge> · owner {p.ownerUserId} ·{" "}
        <Link href={`/app/opportunities/${p.opportunityId}`}>opportunity</Link>
        {p.nextActionAt ? ` · next action ${fmtDate(p.nextActionAt)}` : ""}
      </p>
      <p data-testid="pursuit-money">
        Estimated {fmtMoney(p.estimatedContractValue)} · submitted {fmtMoney(p.submittedValue)} · outcome{" "}
        {fmtMoney(p.outcomeValue)}
      </p>

      <h2>Takeoff</h2>
      <div data-testid="takeoff-card">
        {sheet ? (
          <p>
            {sheet.lines.length} line{sheet.lines.length === 1 ? "" : "s"} ({sheet.totals.derivedCount} derived ·{" "}
            {sheet.totals.manualCount} manual) · bid price <strong>~{fmtMoney(sheet.totals.bidPrice)}</strong>{" "}
            <Badge tone={sheet.status === "final" ? "green" : "amber"}>{sheet.status}</Badge> ·{" "}
            <Link href={`/app/pursuits/${p.id}/takeoff`}>open sheet</Link>
          </p>
        ) : (
          <p>
            No takeoff sheet yet — <Link href={`/app/pursuits/${p.id}/takeoff`}>start takeoff</Link>{" "}
            (seeded from the permit evidence; every derived figure is an estimate).
          </p>
        )}
      </div>

      <PursuitActions pursuitId={p.id} allowedTransitions={p.allowedTransitions} />

      <h2>Field</h2>
      <FieldSection pursuitId={p.id} links={links} entries={entries} rollup={rollup} />

      <h2>Tasks</h2>
      <ul>
        {p.tasks.map((t) => (
          <li key={t.id}>
            {t.title} — <code>{t.taskType.replaceAll("_", " ")}</code>{" "}
            <Badge tone={t.status === "open" ? "amber" : "green"}>{t.status}</Badge>
            {t.dueAt ? ` · due ${fmtDate(t.dueAt)}` : ""}
          </li>
        ))}
        {p.tasks.length === 0 && <li>none</li>}
      </ul>

      <h2>State history</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>When</th>
            <th style={cell}>From → To</th>
            <th style={cell}>Actor</th>
            <th style={cell}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {p.transitions.map((t, i) => (
            <tr key={i}>
              <td style={cell}>{fmtDate(t.createdAt)}</td>
              <td style={cell}>
                {t.fromState ?? "—"} → {t.toState}
              </td>
              <td style={cell}>
                {t.actorType}
                {t.actorId ? ` (${t.actorId})` : ""}
              </td>
              <td style={cell}>{t.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Notes</h2>
      <ul>
        {p.notes.map((n, i) => (
          <li key={i}>
            <em>{fmtDate(n.createdAt)}</em> — {n.body}
          </li>
        ))}
        {p.notes.length === 0 && <li>none</li>}
      </ul>
    </main>
  );
}
