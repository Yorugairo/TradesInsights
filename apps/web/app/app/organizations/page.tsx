import Link from "next/link";
import { redirect } from "next/navigation";
import { listAccountOrganizations } from "@otn/intelligence";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey } from "../../../lib/queries.js";
import { Badge, cell, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

export default async function OrganizationsPage() {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const orgs = await listAccountOrganizations(db(), account.id);

  return (
    <main>
      <h1>Organizations</h1>
      <p style={{ color: "#666" }}>
        GCs, developers, and architects on your opportunities. Relationship state is yours alone;
        public roles come from the shared record graph.
      </p>
      {orgs.length === 0 ? (
        <p data-testid="orgs-empty">No organizations on your opportunities yet.</p>
      ) : (
        <table style={table} data-testid="orgs-table">
          <thead>
            <tr>
              <th style={cell}>Organization</th>
              <th style={cell}>Relationship</th>
              <th style={cell}>Projects</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id}>
                <td style={cell}>
                  <Link href={`/app/organizations/${o.id}`}>{o.name}</Link>
                </td>
                <td style={cell}>
                  {o.relationshipState ? (
                    <Badge tone={o.blocked ? "red" : o.preferred ? "green" : "amber"}>
                      {o.relationshipState.replaceAll("_", " ")}
                    </Badge>
                  ) : (
                    <Badge tone="gray">not set</Badge>
                  )}
                </td>
                <td style={cell}>{o.projectCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
