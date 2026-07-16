import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOrganizationView } from "@otn/intelligence";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { accountByKey } from "../../../../lib/queries.js";
import { Badge, cell, fmtDate, table } from "../../../../lib/ui.js";
import { RelationshipActions } from "./actions.js";

export const dynamic = "force-dynamic";

export default async function OrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const { id } = await params;
  const view = await getOrganizationView(db(), id, account.id);
  if (!view) notFound();

  return (
    <main>
      <h1 data-testid="org-title">{view.organization.name}</h1>
      <p>
        {view.organization.ubi ? `UBI ${view.organization.ubi} · ` : ""}
        {view.organization.status ? (
          <Badge tone={view.organization.verifiedAt ? "green" : "amber"}>
            {view.organization.status}
            {view.organization.verifiedAt ? ` (verified ${fmtDate(view.organization.verifiedAt)})` : " (unverified)"}
          </Badge>
        ) : (
          "status unknown"
        )}
        {view.relationship?.alertSuppressed && (
          <>
            {" "}
            <Badge tone="red">alerts suppressed</Badge>
          </>
        )}
      </p>

      <h2>Your relationship</h2>
      <RelationshipActions organizationId={view.organization.id} current={view.relationship} />

      <h2>Public roles (shared record graph)</h2>
      <ul data-testid="org-public-roles">
        {view.publicRoles.map((r, i) => (
          <li key={i}>
            <Link href={`/app/projects/${r.projectId}`}>{r.projectName}</Link> — {r.role ?? "role unknown"}{" "}
            {r.confirmed ? <Badge tone="green">confirmed</Badge> : <Badge tone="amber">unconfirmed</Badge>}
          </li>
        ))}
        {view.publicRoles.length === 0 && <li>none on your opportunities</li>}
      </ul>

      <h2>Contacts</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Name</th>
            <th style={cell}>Role</th>
            <th style={cell}>Email</th>
            <th style={cell}>Source</th>
          </tr>
        </thead>
        <tbody>
          {view.contacts.map((c, i) => (
            <tr key={i}>
              <td style={cell}>{c.name}</td>
              <td style={cell}>{c.role ?? "—"}</td>
              <td style={cell}>{c.email ?? "—"}</td>
              <td style={cell}>
                <Badge tone={c.customerVerified ? "green" : "gray"}>
                  {c.sourceType.replaceAll("_", " ")}
                  {c.customerVerified ? " · verified" : ""}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.contacts.length === 0 && <p>No contacts recorded.</p>}

      <h2>Invitations from this GC</h2>
      <ul>
        {view.invitations.map((inv) => (
          <li key={inv.id}>
            <Link href={`/app/invitations/${inv.id}`}>{inv.projectName ?? "(unmatched)"}</Link> —{" "}
            {inv.invitationStatus} · bid due {fmtDate(inv.bidDueAt)}
          </li>
        ))}
        {view.invitations.length === 0 && <li>none</li>}
      </ul>
    </main>
  );
}
