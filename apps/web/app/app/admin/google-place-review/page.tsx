import Link from "next/link";
import { redirect } from "next/navigation";
import { createRegistryPool } from "@otn/db";
import { fetchGooglePlaceBlockedSummary, fetchGooglePlaceReviewRows } from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { Badge, cell, table } from "../../../../lib/ui.js";
import { PlaceReviewTable } from "./batch-table.js";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Google Place review — the registry's queue, worked from Insights.
 *
 * This queue had 2,000+ pending rows and NO web UI; it was worked only by an
 * offline Python script. Insights reads it through the `registry_public` contract
 * views and writes decisions to the partner hand-off table — it never touches
 * `registry_internal`.
 *
 * Only `actionable` rows are listed. The rest are counted, not hidden: the blocked
 * summary at the bottom is the drift canary, because the view's WHERE clause can
 * never be the safeguard against a reason string changing registry-side.
 */
export default async function GooglePlaceReviewPage({
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
  if (!pool) {
    return (
      <main style={{ padding: "1rem", maxWidth: 1200 }}>
        <Crumbs />
        <h1>Google Place review</h1>
        <p style={{ color: "#a00" }}>
          REGISTRY_DATABASE_URL is not set — the registry seam is offline.
        </p>
      </main>
    );
  }

  const [rows, blocked] = await Promise.all([
    fetchGooglePlaceReviewRows(pool, { state: "actionable", limit }),
    fetchGooglePlaceBlockedSummary(pool),
  ]);
  const blockedTotal = blocked.reduce((n, b) => n + b.count, 0);

  return (
    <main style={{ padding: "1rem", maxWidth: 1200 }}>
      <Crumbs />
      <h1>Google Place review — is this Google listing this contractor?</h1>

      <Orientation />

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", margin: "0.5rem 0" }}>
        <span style={{ color: "#666" }}>{rows.length} actionable shown</span>
        <span>·</span>
        {[50, 100, 500].map((n) => (
          <Link key={n} href={`?limit=${n}`} style={{ fontWeight: n === limit ? 700 : 400 }}>
            limit {n}
          </Link>
        ))}
      </div>

      {/* Rows render client-side so one selection can span many of them; a
          server-rendered table cannot hold shared checkbox state. */}
      <PlaceReviewTable rows={rows} />
      {rows.length === 0 && blockedTotal > 0 && (
        <p style={{ color: "#666" }}>
          {blockedTotal.toLocaleString()} pending rows are not human decisions yet — see below.
        </p>
      )}

      <h2>Not human decisions yet — {blockedTotal.toLocaleString()} pending</h2>
      <p style={{ color: "#666", marginTop: 0 }}>
        These are counted, never hidden. If a reason string drifts registry-side its rows land
        here instead of silently becoming your work — so a number moving in this table is the
        signal to re-check the contract view.
      </p>
      <table style={table}>
        <tbody>
          {blocked.map((b) => (
            <tr key={`${b.reviewState}:${b.reason}`}>
              <td style={cell}>
                <Badge tone={b.reviewState === "awaiting_auto_resolver" ? "amber" : "gray"}>
                  {b.reviewState.replace(/_/g, " ")}
                </Badge>
              </td>
              <td style={{ ...cell, fontWeight: 600 }}>{b.count.toLocaleString()}</td>
              <td style={cell}>
                <small>{b.reason}</small>
              </td>
            </tr>
          ))}
          {blocked.length === 0 && (
            <tr>
              <td style={cell} colSpan={3}>
                Nothing blocked.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

function Crumbs() {
  return (
    <p>
      <Link href="/app/admin/cockpit">← cockpit</Link>
      {" · "}
      <Link href="/app/admin/registry-review">registry review →</Link>
    </p>
  );
}

/** What claim is being judged — stated before any row (Orientation convention). */
function Orientation() {
  return (
    <details
      open
      style={{ border: "1px solid #ddd", borderRadius: 6, padding: "0.6rem 0.8rem", margin: "0.75rem 0" }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>What am I looking at?</summary>
      <div style={{ color: "#444", fontSize: "0.9rem", marginTop: "0.5rem" }}>
        <p style={{ margin: "0.3rem 0" }}>
          Each row pairs one <strong>WA L&amp;I licensed contractor</strong> with one{" "}
          <strong>Google Maps listing</strong> a scraper thought might be the same business. You are
          judging exactly one thing: <em>is this listing that contractor?</em>
        </p>
        <p style={{ margin: "0.3rem 0" }}>
          Compare the address first — it is the strongest signal. A different phone is common and
          weak evidence on its own (businesses change numbers; L&amp;I registrations go stale). A
          different <em>address</em> usually means a different business.
        </p>
        <p style={{ margin: "0.3rem 0" }}>
          Your decision is <strong>queued for the registry</strong>, not applied here — the registry
          owns this queue and applies decisions itself, so a row someone else already resolved is
          never overwritten. L&amp;I remains the identity and phone authority throughout.
        </p>
      </div>
    </details>
  );
}
