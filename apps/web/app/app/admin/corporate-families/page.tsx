import Link from "next/link";
import { redirect } from "next/navigation";
import { createRegistryPool } from "@otn/db";
import {
  buildFamilies,
  corporateFamilyRollup,
  loadPersonCandidates,
  type CorporateFamilyRollupRow,
} from "@otn/intelligence";
import {
  buildPrincipalPersonIndex,
  fetchRegistryIdentityRows,
  matchPrincipalsToPeople,
  type PrincipalPersonMatch,
} from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { Badge, cell, fmtDate, fmtMoney, table } from "../../../../lib/ui.js";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

/**
 * Corporate families — the identity tier ABOVE the legal entity.
 *
 * WA L&I gives us brand (contractor licence) and enterprise (UBI) for free, but
 * common CONTROL sits above both. `Erdahl, Darrin P` holds nine separate UBIs
 * that every other surface shows as nine unrelated companies. Grouping on the
 * L&I principal is the only way to see one buying decision-maker behind them.
 *
 * PRIVACY (owner decision, 2026-07-23): this page displays PRIVATE INDIVIDUALS.
 * It is admin-only under `/app/`, gated by `currentSession()` like every other
 * `/app/*` route. Principal names must never reach a public registry page, a
 * pSEO surface, a digest, or any unauthenticated route.
 *
 * NOTHING HERE BINDS. A family is derived at read time and is analytic only: it
 * creates no `registry_ref`, stamps no identifier, and does not feed
 * `evaluateStrictBind`. The second section is explicitly a DISCOVERY queue — a
 * human reads the evidence and decides.
 */
export default async function CorporateFamiliesPage({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");

  const params = await searchParams;
  const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const pool = createRegistryPool();
  if (!pool) return <Unavailable reason="REGISTRY_DATABASE_URL is not set — the registry seam is offline." />;

  const rows = await fetchRegistryIdentityRows(pool);
  const { families, dropped } = buildFamilies(rows);
  // Families are derived from the REGISTRY contract; activity lives in Insights.
  // One fetch feeds both the rollup and the discovery lane below.
  const rollups = await corporateFamilyRollup(db(), families, { limit });
  const rollupById = new Map(rollups.map((r) => [r.familyId, r]));

  const candidates = await loadPersonCandidates(db());
  const matches = matchPrincipalsToPeople(candidates, buildPrincipalPersonIndex(rows));
  // Confirmations of what we already know are noise here; the new groupings are
  // the point. Both counts are shown so the ratio stays honest.
  const newMatches = matches.filter((m) => !m.alreadyBound).slice(0, limit);

  return (
    <main style={{ padding: "1rem", maxWidth: 1100 }}>
      <p>
        <Link href="/app/admin/registry-review">← registry review</Link>
      </p>
      <h1>Corporate families — common control above the legal entity</h1>
      <p style={{ color: "#666" }}>
        Registry entities grouped by shared L&amp;I principal (officer/owner). Registered agents are
        filtered out registry-side — they carry no control signal and would fuse unrelated companies.
        <strong> Derived at read time and analytic only</strong>: nothing on this page binds an
        identity, stamps an identifier, or auto-accepts anything.
      </p>
      <p style={{ color: "#a00" }}>
        <strong>Private individuals.</strong> Principal names are shown here because this page is
        admin-only and authenticated. They must not be copied into a digest, an export, or any
        public page.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", margin: "0.5rem 0" }}>
        <span style={{ color: "#666" }}>
          {families.length} families derived · {rollups.length} with Insights activity
        </span>
        <span>·</span>
        {[50, 100, 300].map((n) => (
          <Link key={n} href={`?limit=${n}`} style={{ fontWeight: n === limit ? 700 : 400 }}>
            limit {n}
          </Link>
        ))}
      </div>

      {dropped.length > 0 && (
        <p style={{ color: "#a00" }}>
          <strong>{dropped.length} group(s) dropped</strong> for exceeding the size cap (
          {dropped.map((d) => `${d.principalKey}: ${d.entityCount}`).join(", ")}). A group this large
          is an agent that slipped both registry-side filters, not a family — dropped rather than
          truncated so the regression stays visible.
        </p>
      )}

      <h2>Families — {Math.min(families.length, limit)} shown</h2>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Principal(s)</th>
            <th style={cell}>Entities</th>
            <th style={cell}>Insights brands</th>
            <th style={cell}>Projects</th>
            <th style={cell}>90d</th>
            <th style={cell}>Stated value</th>
            <th style={cell}>Counties</th>
            <th style={cell}>Latest</th>
          </tr>
        </thead>
        <tbody>
          {families.slice(0, limit).map((f) => {
            const r: CorporateFamilyRollupRow | undefined = rollupById.get(f.familyId);
            return (
              <tr key={f.familyId}>
                <td style={cell}>
                  <strong>{f.principalNames.join(" · ")}</strong>
                  <br />
                  <small style={{ color: "#666" }}>
                    <code>{f.familyId}</code>
                  </small>
                </td>
                <td style={cell}>
                  {f.entityIds.length} <Badge tone="gray">registry</Badge>
                  <br />
                  <small>{f.entityNames.join(", ") || "—"}</small>
                </td>
                <td style={cell}>
                  {/* No rollup row = no Insights org bound to any member yet. That
                      is a real state, not a zero: we know the family exists but
                      have seen none of its work. */}
                  {r ? (
                    <>
                      {r.brandCount} of {r.boundEntityCount} bound
                      <br />
                      <small>{r.orgNames.join(", ")}</small>
                    </>
                  ) : (
                    <small style={{ color: "#666" }}>none bound</small>
                  )}
                </td>
                <td style={cell}>{r ? r.projects : "—"}</td>
                <td style={cell}>{r ? r.projects90d : "—"}</td>
                <td style={cell}>{r ? fmtMoney(r.statedValuationTotal) : "—"}</td>
                <td style={cell}>
                  <small>{r?.counties.join(", ") || "—"}</small>
                </td>
                <td style={cell}>
                  <small>{fmtDate(r?.latestActivityAt)}</small>
                </td>
              </tr>
            );
          })}
          {families.length === 0 && (
            <tr>
              <td style={cell} colSpan={8}>
                No families derived — the contract view has no <code>principals</code> column yet, or
                no principal spans more than one entity.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Principal ↔ person discovery — {newMatches.length} new</h2>
      <p style={{ color: "#666" }}>
        Insights people whose name matches a registry principal, where the match reaches entities we
        are <em>not</em> already bound to. An organization row that is really a human, or a named
        public contact at a company, may be the controlling principal of several registry entities —
        which is how a new family becomes visible. The key here is deliberately coarse (surname +
        given name, no middle initial), because permit data rarely carries a middle name; that means
        real collisions, which is exactly why this is a review queue and not a binding rule.{" "}
        <strong>
          {matches.length - newMatches.length} further match(es) merely confirm an existing binding
          and are hidden.
        </strong>
      </p>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Insights person</th>
            <th style={cell}>Source</th>
            <th style={cell}>Their org</th>
            <th style={cell}>Reaches registry entities</th>
          </tr>
        </thead>
        <tbody>
          {newMatches.map((m: PrincipalPersonMatch, i) => (
            <tr key={`${m.candidate.organizationId}-${m.coreKey}-${i}`}>
              <td style={cell}>
                <strong>{m.candidate.personName}</strong>
                <br />
                <small style={{ color: "#666" }}>
                  <code>{m.coreKey}</code>
                </small>
              </td>
              <td style={cell}>
                <Badge tone={m.candidate.source === "organization" ? "amber" : "gray"}>
                  {m.candidate.source}
                </Badge>
              </td>
              <td style={cell}>
                <small>{m.candidate.organizationName}</small>
                {m.candidate.registryRef && (
                  <>
                    <br />
                    <small style={{ color: "#666" }}>already bound elsewhere</small>
                  </>
                )}
              </td>
              <td style={cell}>
                {m.entities.length}
                <br />
                <small>
                  {m.entities
                    .map((e) => `${e.entityName ?? e.entityId} (as "${e.principalName}")`)
                    .join(", ")}
                </small>
              </td>
            </tr>
          ))}
          {newMatches.length === 0 && (
            <tr>
              <td style={cell} colSpan={4}>
                No new principal ↔ person matches.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <main style={{ padding: "1rem", maxWidth: 1100 }}>
      <h1>Corporate families</h1>
      <p style={{ color: "#a00" }}>{reason}</p>
    </main>
  );
}
