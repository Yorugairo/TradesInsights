import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey, listAccountFeedback } from "../../../lib/queries.js";
import { cell, fmtDate, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

function yn(v: unknown): string {
  return v === true ? "yes" : v === false ? "no" : "—";
}

export default async function FeedbackPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const rows = await listAccountFeedback(db(), account.id);

  return (
    <main>
      <h1>Feedback — {account.name}</h1>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Project</th>
            <th style={cell}>Relevant</th>
            <th style={cell}>New</th>
            <th style={cell}>Timely</th>
            <th style={cell}>Pursue</th>
            <th style={cell}>Disposition</th>
            <th style={cell}>Notes</th>
            <th style={cell}>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r["id"] as string}>
              <td style={cell}>{r["canonical_name"] as string}</td>
              <td style={cell}>{yn(r["relevant"])}</td>
              <td style={cell}>{yn(r["new_to_customer"])}</td>
              <td style={cell}>{yn(r["timely"])}</td>
              <td style={cell}>{yn(r["worth_pursuing"])}</td>
              <td style={cell}>{(r["disposition_reason"] as string | null) ?? "—"}</td>
              <td style={cell}>{(r["notes"] as string | null) ?? "—"}</td>
              <td style={cell}>{fmtDate(r["created_at"] as string)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={cell} colSpan={8}>
                No feedback recorded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
