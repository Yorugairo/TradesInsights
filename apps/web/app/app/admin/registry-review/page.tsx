import Link from "next/link";
import { redirect } from "next/navigation";
import { classifyReviewTier, listRegistryObservations, type ReviewTier } from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { cell, table } from "../../../../lib/ui.js";
import { RegistryReviewTable, type EvidenceView, type ReviewRow } from "./actions.js";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 500;

type Observation = Awaited<ReturnType<typeof listRegistryObservations>>[number];

/**
 * Registry review — the human gate on the One Trade Network seam. Top pending
 * observations by deterministic trust; nothing binds identity, reaches a
 * customer's bucket, or exports to the registry until accepted here (or by a
 * rule whose reviewed history earned auto-accept). Each decision teaches the
 * per-rule accept rate for the next pass.
 *
 * `?limit=` (1–200, default 50) and `?rule=` narrow the window; the rule filter
 * is applied over the fetched page (no shared-lib change for a UI concern).
 */
export default async function RegistryReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string; rule?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");

  const params = await searchParams;
  const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rule = params.rule?.trim() || null;

  const fetched = await listRegistryObservations(db(), { status: "pending", limit });
  const recent = await listRegistryObservations(db(), { status: "accepted", limit: 8 });

  // Per-rule counts over the fetched window (honest label: "of N shown", not a
  // full-queue total — the window caps at 200).
  const ruleCounts = new Map<string, number>();
  for (const o of fetched) ruleCounts.set(o.ruleKey, (ruleCounts.get(o.ruleKey) ?? 0) + 1);
  const rulePresets = [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Confidence tier per candidate (deterministic — drives the grouped batch UI).
  const TIER_ORDER: ReviewTier[] = ["tier1", "tier2", "tier3"];
  const tierOf = new Map(fetched.map((o) => [o.id, classifyReviewTier(o)]));

  const filtered = rule ? fetched.filter((o) => o.ruleKey === rule) : fetched;
  // Highest-confidence tier first, then trust desc within a tier.
  const pending = [...filtered].sort((a, b) => {
    const ta = TIER_ORDER.indexOf(tierOf.get(a.id)!.tier);
    const tb = TIER_ORDER.indexOf(tierOf.get(b.id)!.tier);
    return ta !== tb ? ta - tb : b.trustScore - a.trustScore;
  });
  const rows: ReviewRow[] = pending.map((o) => {
    const ti = tierOf.get(o.id)!;
    return {
      id: o.id,
      trustScore: o.trustScore,
      observationType: o.observationType,
      ruleKey: o.ruleKey,
      tier: ti.tier,
      tierLabel: ti.label,
      tierReason: ti.reason,
      suggestion: describe(o),
      evidence: extractEvidence(o),
      components: Object.entries(o.trustComponents)
        .map(([k, v]) => `${k} ${Number(v).toFixed(2)}`)
        .join(" · "),
    };
  });

  const linkFor = (r: string | null) => {
    const q = new URLSearchParams();
    q.set("limit", String(limit));
    if (r) q.set("rule", r);
    return `?${q.toString()}`;
  };

  return (
    <main style={{ padding: "1rem", maxWidth: 1100 }}>
      <p>
        <Link href="/app/admin/cockpit">← cockpit</Link>
        {" · "}
        <Link href="/app/admin/review">← resolution review</Link>
        {" · "}
        <Link href="/app/admin/corporate-families">corporate families →</Link>
      </p>
      <h1>Registry review — One Trade Network seam</h1>
      <p style={{ color: "#666" }}>
        Top pending observations by deterministic trust. <strong>Accept</strong> applies immediately:
        a binding stamps the organization&apos;s registry identity; a phone adoption becomes a
        customer-visible contact; alias/trade rows queue for the nightly export to the registry.
        Every decision updates that rule&apos;s accept history, so scoring sharpens each pass.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", margin: "0.5rem 0" }}>
        <span style={{ color: "#666" }}>Window: {fetched.length} of ≤{MAX_LIMIT}</span>
        <span>·</span>
        {[50, 100, 200].map((n) => (
          <Link key={n} href={`?limit=${n}${rule ? `&rule=${rule}` : ""}`} style={{ fontWeight: n === limit ? 700 : 400 }}>
            limit {n}
          </Link>
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", margin: "0.25rem 0 0.75rem" }}>
        <small style={{ color: "#666" }}>Rules (of window):</small>
        <Link href={linkFor(null)} style={{ fontWeight: rule ? 400 : 700 }}>
          <small>all {fetched.length}</small>
        </Link>
        {rulePresets.map(([r, n]) => (
          <Link key={r} href={linkFor(r)} style={{ fontWeight: rule === r ? 700 : 400 }}>
            <small>
              <code>{r}</code> {n}
            </small>
          </Link>
        ))}
      </div>

      <h2>
        Pending — {rows.length} shown{rule ? ` (rule ${rule})` : ""}
      </h2>
      <RegistryReviewTable rows={rows} />

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

function describe(o: Observation): string {
  const p = o.payload;
  if (o.observationType === "binding_name_match") {
    // When the match landed on a DBA/brand rather than the entity's canonical
    // name, say so up front — "→ registry Fischer Services" alone hid that the
    // actual match was "2 Sons Plumbing", a name the reviewer never sees
    // otherwise unless they open the evidence line.
    const brand = p["matched_brand_name"] ?? p["matched_registry_name"];
    const via = brand ? ` (as "${String(brand)}")` : "";
    return `Bind "${String(p["org_name"] ?? "")}" → registry "${String(p["registry_name"] ?? "")}"${via} (${String(p["registry_city"] ?? "?")})`;
  }
  if (o.observationType === "phone_adoption") {
    return `Adopt L&I phone ${String(p["phone"] ?? "")} for ${o.organizationName}`;
  }
  if (o.observationType === "alias_export") {
    return `Teach registry alias "${String(p["alias_display"] ?? "")}"`;
  }
  return `Teach registry trade "${String(p["trade_code"] ?? "")}" (${(p["permit_type_samples"] as string[] | undefined)?.length ?? 0} permit types)`;
}

/** Pull the reviewer-facing evidence out of a name-binding payload (null otherwise). */
function extractEvidence(o: Observation): EvidenceView | null {
  if (o.observationType !== "binding_name_match") return null;
  const p = o.payload;
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    nameSimilarity: numOrNull(p["name_similarity"]),
    orgPhones: strArr(p["phone_evidence"]),
    registryPhone: strOrNull(p["registry_phone"]),
    phoneAgrees: p["phone_agrees"] === true,
    registryGooglePhone: strOrNull(p["registry_google_phone"]),
    orgAddresses: strArr(p["address_evidence"]),
    registryAddress: strOrNull(p["registry_address"]),
    sharedBucketSize: numOrNull(p["shared_address_bucket_size"]),
    orgDomains: strArr(p["domain_evidence"]),
    registryRootDomain: strOrNull(p["registry_root_domain"]),
    matchedAlias: strOrNull(p["matched_alias"]),
    // Which registry-side NAME actually matched (differs from registry_name
    // whenever the hit came through a DBA/brand, not the canonical), and which
    // BRAND — with the brand's OWN licence and OWN phone, never the entity's.
    // Surfacing these is the fix for two live-review findings (2026-07-23):
    // name_similarity silently comparing against the wrong name, and a
    // sibling brand's phone displaying as if it were the matched brand's own.
    matchedRegistryName: strOrNull(p["matched_registry_name"]),
    matchedBrandName: strOrNull(p["matched_brand_name"]),
    matchedBrandLicence: strOrNull(p["matched_brand_licence"]),
    matchedBrandPhone: strOrNull(p["matched_brand_phone"]),
    localities: strArr(p["org_localities"]),
    roleRecords: numOrNull(p["role_records"]),
  };
}
