import Link from "next/link";
import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey, listDigests } from "../../../lib/queries.js";
import { cell, fmtDate, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

export default async function DigestsPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const digests = await listDigests(db(), account.id);

  return (
    <main>
      <h1>Digests — {account.name}</h1>
      {digests.length === 0 ? (
        <p data-testid="digests-empty">No digests delivered yet (weekly digest lands in M3.6).</p>
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <th style={cell}>Type</th>
              <th style={cell}>Period</th>
              <th style={cell}>Status</th>
              <th style={cell}>Sent</th>
            </tr>
          </thead>
          <tbody>
            {digests.map((d) => (
              <tr key={d.id}>
                <td style={cell}>
                  {/* The row is the way in to the reader (M1). Linking the type
                      cell rather than adding a column keeps the table narrow
                      enough for a phone. */}
                  <Link href={`/app/digests/${d.id}`} data-testid="digest-link">
                    {d.deliveryType}
                  </Link>
                </td>
                <td style={cell}>
                  {fmtDate(d.periodStart)} → {fmtDate(d.periodEnd)}
                </td>
                <td style={cell}>{d.status}</td>
                <td style={cell}>{fmtDate(d.sentAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
