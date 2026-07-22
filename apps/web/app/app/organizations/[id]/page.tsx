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

      {view.organization.registryIdentity && (
        <p data-testid="org-registry-identity">
          <Badge tone="green">One Trade Network verified</Badge>{" "}
          {String(view.organization.registryIdentity["canonical_name"] ?? "")}
          {view.organization.registryIdentity["ubi"]
            ? ` · UBI ${String(view.organization.registryIdentity["ubi"])}`
            : ""}
          {Array.isArray(view.organization.registryIdentity["contractor_numbers"]) &&
          (view.organization.registryIdentity["contractor_numbers"] as string[]).length > 0
            ? ` · License ${(view.organization.registryIdentity["contractor_numbers"] as string[]).join(", ")}`
            : ""}
          {view.organization.registryIdentity["phone"]
            ? ` · ${String(view.organization.registryIdentity["phone"])}`
            : ""}
          {view.organization.registryIdentity["city"]
            ? ` · ${String(view.organization.registryIdentity["city"])}, ${String(view.organization.registryIdentity["state"] ?? "WA")}`
            : ""}
          {view.organization.registryIdentity["google_rating"] != null
            ? ` · ★ ${String(view.organization.registryIdentity["google_rating"])}${
                view.organization.registryIdentity["google_review_count"] != null
                  ? ` (${String(view.organization.registryIdentity["google_review_count"])} reviews)`
                  : ""
              }`
            : ""}
          {Array.isArray(view.organization.registryIdentity["trade_codes"]) &&
          (view.organization.registryIdentity["trade_codes"] as string[]).length > 0
            ? ` · Trades: ${(view.organization.registryIdentity["trade_codes"] as string[]).join(", ")}`
            : ""}
        </p>
      )}

      <p data-testid="org-activity">
        Permit activity: {view.activity.projectsTotal} project
        {view.activity.projectsTotal === 1 ? "" : "s"} on record · {view.activity.projects12m} in
        the last 12 months · {view.activity.projects90d} in the last 90 days
      </p>

      <h2>Your relationship</h2>
      <RelationshipActions organizationId={view.organization.id} current={view.relationship} />

      <h2>Working history with {view.organization.name}</h2>
      <p style={{ color: "#666" }}>
        Your opportunities on this GC&apos;s projects — open the opportunity for the memo, brief,
        and outreach draft.
      </p>
      <table style={table} data-testid="working-history">
        <thead>
          <tr>
            <th style={cell}>Project</th>
            <th style={cell}>County</th>
            <th style={cell}>Stage</th>
            <th style={cell}>Score</th>
            <th style={cell}>Status</th>
            <th style={cell}>Last activity</th>
          </tr>
        </thead>
        <tbody>
          {view.workingHistory.map((h) => (
            <tr key={h.opportunityId}>
              <td style={cell}>
                <Link href={`/app/opportunities/${h.opportunityId}`}>{h.projectName}</Link>{" "}
                {h.warmGcActive && <Badge tone="green">warm relationship</Badge>}
              </td>
              <td style={cell}>{h.county}</td>
              <td style={cell}>{h.stage.replaceAll("_", " ")}</td>
              <td style={cell}>{h.score ?? "—"}</td>
              <td style={cell}>
                {h.pursuitState ? (
                  <Badge
                    tone={
                      h.pursuitState === "won" ? "green" : h.pursuitState === "lost" || h.pursuitState === "no_bid" ? "red" : "amber"
                    }
                  >
                    pursuit: {h.pursuitState.replaceAll("_", " ")}
                    {h.pursuitState === "won" && h.outcomeValue ? ` (${`$${Math.round(h.outcomeValue).toLocaleString("en-US")}`})` : ""}
                  </Badge>
                ) : (
                  <Badge tone="gray">{h.opportunityState.replaceAll("_", " ")}</Badge>
                )}
              </td>
              <td style={cell}>{fmtDate(h.lastActivityAt)}</td>
            </tr>
          ))}
          {view.workingHistory.length === 0 && (
            <tr>
              <td style={cell} colSpan={6}>
                No shared opportunities yet — when this GC&apos;s projects route to you, they appear here.
              </td>
            </tr>
          )}
        </tbody>
      </table>

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
