import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey, listAccountInvitations } from "../../../lib/queries.js";
import { Badge, cell, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

export default async function InvitationsPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const items = await listAccountInvitations(db(), account.id, `web:${session.accountKey}`);

  return (
    <main>
      <h1>Bid invitations — {account.name}</h1>
      <p style={{ color: "#666" }}>
        Private to your account: customer-authorized exports only, never scraped. Access to these
        records is audited. Only an explicit invitation/solicitation confirms bidding.
      </p>
      {items.length === 0 ? (
        <p data-testid="invitations-empty">
          No invitations ingested. This source activates once you authorize an export
          (see docs/source-policy.md — customer_bid_inbox).
        </p>
      ) : (
        <table style={table} data-testid="invitations-table">
          <thead>
            <tr>
              <th style={cell}>Invitation</th>
              <th style={cell}>Scope</th>
              <th style={cell}>GC</th>
              <th style={cell}>Status</th>
              <th style={cell}>Bid due</th>
              <th style={cell}>County</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.recordId}>
                <td style={cell}>{i.title ?? i.externalId}</td>
                <td style={cell}>{i.scope ?? "—"}</td>
                <td style={cell}>{i.generalContractor ?? "—"}</td>
                <td style={cell}>
                  <Badge tone={i.stage === "bidding_confirmed" ? "green" : "gray"}>
                    {i.status ?? "—"}
                  </Badge>
                </td>
                <td style={cell}>{i.bidDueDate ?? "—"}</td>
                <td style={cell}>{i.county ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
