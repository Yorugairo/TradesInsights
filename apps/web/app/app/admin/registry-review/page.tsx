import Link from "next/link";
import { redirect } from "next/navigation";
import { listRegistryObservations } from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { cell, table } from "../../../../lib/ui.js";
import { ObservationDecision } from "./actions.js";

/**
 * Registry review — the human gate on the One Trade Network seam. Top pending
 * observations by deterministic trust; nothing binds identity, reaches a
 * customer's bucket, or exports to the registry until accepted here (or by a
 * rule whose reviewed history earned auto-accept). Each decision teaches the
 * per-rule accept rate for the next pass.
 */
export default async function RegistryReviewPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");
  const pending = await listRegistryObservations(db(), { status: "pending", limit: 25 });
  const recent = await listRegistryObservations(db(), { status: "accepted", limit: 8 });

  const describe = (o: (typeof pending)[number]): string => {
    const p = o.payload;
    if (o.observationType === "binding_name_match") {
      return `Bind "${String(p["org_name"] ?? "")}" → registry "${String(p["registry_name"] ?? "")}" (${String(p["registry_city"] ?? "?")})`;
    }
    if (o.observationType === "phone_adoption") {
      return `Adopt L&I phone ${String(p["phone"] ?? "")} for ${o.organizationName}`;
    }
    if (o.observationType === "alias_export") {
      return `Teach registry alias "${String(p["alias_display"] ?? "")}"`;
    }
    return `Teach registry trade "${String(p["trade_code"] ?? "")}" (${(p["permit_type_samples"] as string[] | undefined)?.length ?? 0} permit types)`;
  };

  return (
    <main style={{ padding: "1rem", maxWidth: 1100 }}>
      <p>
        <Link href="/app/admin/review">← resolution review</Link>
      </p>
      <h1>Registry review — One Trade Network seam</h1>
      <p style={{ color: "#666" }}>
        Top pending observations by deterministic trust. <strong>Accept</strong> applies immediately:
        a binding stamps the organization&apos;s registry identity; a phone adoption becomes a
        customer-visible contact; alias/trade rows queue for the nightly export to the registry.
        Every decision updates that rule&apos;s accept history, so scoring sharpens each pass.
      </p>
      <h2>Pending — {pending.length} shown</h2>
      <table style={table} data-testid="registry-observations-table">
        <thead>
          <tr>
            <th style={cell}>Trust</th>
            <th style={cell}>Type</th>
            <th style={cell}>Suggestion</th>
            <th style={cell}>Rule</th>
            <th style={cell}>Components</th>
            <th style={cell}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {pending.map((o) => (
            <tr key={o.id}>
              <td style={cell}>
                <strong>{o.trustScore.toFixed(2)}</strong>
              </td>
              <td style={cell}>{o.observationType.replace(/_/g, " ")}</td>
              <td style={cell}>{describe(o)}</td>
              <td style={cell}>
                <code>{o.ruleKey}</code>
              </td>
              <td style={cell}>
                <small>
                  {Object.entries(o.trustComponents)
                    .map(([k, v]) => `${k} ${Number(v).toFixed(2)}`)
                    .join(" · ")}
                </small>
              </td>
              <td style={cell}>
                <ObservationDecision observationId={o.id} />
              </td>
            </tr>
          ))}
          {pending.length === 0 && (
            <tr>
              <td style={cell} colSpan={6}>
                Queue is empty — the nightly pass regenerates it when the registry connection is
                configured.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Recently accepted</h2>
      <table style={table}>
        <tbody>
          {recent.map((o) => (
            <tr key={o.id}>
              <td style={cell}>{o.trustScore.toFixed(2)}</td>
              <td style={cell}>{o.observationType.replace(/_/g, " ")}</td>
              <td style={cell}>{describe(o)}</td>
              <td style={cell}>
                <small>{o.decidedBy}</small>
              </td>
            </tr>
          ))}
          {recent.length === 0 && (
            <tr>
              <td style={cell} colSpan={4}>
                Nothing accepted yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
