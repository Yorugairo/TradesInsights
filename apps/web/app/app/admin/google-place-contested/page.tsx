import Link from "next/link";
import { redirect } from "next/navigation";
import { createRegistryPool } from "@otn/db";
import { groupByPlace, loadContestedPlaces, realConflicts } from "@otn/resolution";
import { currentSession } from "../../../../lib/auth.js";
import { Badge, cell, table } from "../../../../lib/ui.js";

export const dynamic = "force-dynamic";

/**
 * Contested Google Place listings — one listing, several businesses claiming it.
 *
 * These were staged deliberately rather than dropped (a conflict the code hides
 * looks identical to a conflict nobody found), but until now they appeared in no
 * view and no UI: `google_place_review_v1` returns zero of them. This page is
 * their first surface.
 *
 * READ-ONLY BY DESIGN. Presenting the conflict is the deliverable. Two companies
 * cannot own one listing and guessing is worse than showing the disagreement, so
 * there is no accept action here — resolution stays on the registry's governed
 * link table, which carries `decision_locked` and supersession that must not be
 * reimplemented behind the seam.
 *
 * A ROW COUNT IS NOT A WORKLOAD. Most rows have no rival claimant at all: they
 * are one company holding several L&I licences on its own listing, mislabelled
 * by a scorer defect that keyed the contested test by licence rather than by
 * entity. They are shown, separated and counted — never hidden and never folded
 * into the conflict number.
 */
export default async function GooglePlaceContestedPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");

  const pool = createRegistryPool();
  if (!pool) {
    return (
      <main>
        <Crumbs />
        <h1>Contested Google listings</h1>
        <p className="font-semibold text-bad">
          REGISTRY_DATABASE_URL is not set — the registry seam is offline.
        </p>
      </main>
    );
  }

  const rows = await loadContestedPlaces(pool);
  const groups = groupByPlace(rows);
  const conflicts = realConflicts(groups);
  const mislabelled = groups.filter((g) => !g.isRealConflict);

  return (
    <main>
      <Crumbs />
      <h1>Contested Google listings — which business owns this listing?</h1>

      <Orientation />

      <p className="max-w-[70ch] text-sm text-ink-muted">
        <strong>{conflicts.length.toLocaleString()}</strong> genuine conflict
        {conflicts.length === 1 ? "" : "s"} to decide, from {rows.length.toLocaleString()} held-back
        link{rows.length === 1 ? "" : "s"} across {groups.length.toLocaleString()} listing
        {groups.length === 1 ? "" : "s"}.
      </p>

      <h2>Genuine conflicts — {conflicts.length.toLocaleString()}</h2>
      {conflicts.length === 0 ? (
        <p className="text-sm text-ink-muted">No listing is claimed by more than one business.</p>
      ) : (
        conflicts.map((g) => (
          <section key={g.googlePlaceId} className="my-4">
            <h3 className="mb-1 text-base font-semibold text-ink">
              {g.scrapedName ?? "(listing has no name)"}{" "}
              <Badge tone="amber">{g.claimants.length} claimants</Badge>
            </h3>
            <p className="mb-2 text-sm text-ink-muted">
              Google listing phone {g.scrapedPhone ?? "—"} · place id <code>{g.googlePlaceId}</code>
              {g.profileUrl && (
                <>
                  {" · "}
                  <a href={g.profileUrl} target="_blank" rel="noopener noreferrer">
                    open listing
                  </a>
                </>
              )}
            </p>
            <table style={table}>
              <thead>
                <tr>
                  <th style={cell}>L&amp;I business</th>
                  <th style={cell}>L&amp;I phone</th>
                  <th style={cell}>Licence</th>
                  <th style={cell}>Entity</th>
                </tr>
              </thead>
              <tbody>
                {g.claimants.map((c) => (
                  <tr key={`${c.entityId}:${c.lniLicenseNumber ?? ""}`}>
                    <td style={cell} className="font-semibold">{c.lniName ?? c.entityName ?? "—"}</td>
                    <td style={cell}>{c.lniPhone ?? "—"}</td>
                    <td style={cell}>
                      <small>{c.lniLicenseNumber ?? "—"}</small>
                    </td>
                    <td style={cell}>
                      <small>
                        <code>{c.entityId}</code>
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}

      <h2>
        Not a conflict — {mislabelled.length.toLocaleString()} listing
        {mislabelled.length === 1 ? "" : "s"}
      </h2>
      <p className="max-w-[70ch] text-sm text-ink-muted">
        One business, several L&amp;I licences, its own listing. These are held back as{" "}
        <code>not_public_pending_review</code> by a scorer defect that counted licences instead of
        businesses. The scorer is fixed, but the fix does not heal rows already written — these are
        counted here, never hidden, until they are re-issued.
      </p>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Listing</th>
            <th style={cell}>Business</th>
            <th style={cell}>Licences held</th>
          </tr>
        </thead>
        <tbody>
          {mislabelled.slice(0, 200).map((g) => (
            <tr key={g.googlePlaceId}>
              <td style={cell}>{g.scrapedName ?? "—"}</td>
              <td style={cell}>{g.claimants[0]?.lniName ?? g.claimants[0]?.entityName ?? "—"}</td>
              <td style={cell}>{g.claimants.length}</td>
            </tr>
          ))}
          {mislabelled.length === 0 && (
            <tr>
              <td style={cell} colSpan={3}>
                None.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {mislabelled.length > 200 && (
        <p className="max-w-[70ch] text-sm text-ink-muted">
          Showing the first 200 of {mislabelled.length.toLocaleString()}.
        </p>
      )}
    </main>
  );
}

function Crumbs() {
  return (
    <p>
      <Link href="/app/admin/cockpit">← cockpit</Link>
      {" · "}
      <Link href="/app/admin/google-place-review">Google Place review</Link>
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
      className="my-3 rounded-md border border-line bg-surface px-4 py-3"
    >
      <summary className="cursor-pointer font-semibold text-ink">What am I looking at?</summary>
      <div className="mt-2 flex flex-col gap-2 text-sm text-ink-muted">
        <p>
          Each section is <strong>one Google Maps listing</strong> that{" "}
          <strong>more than one WA L&amp;I contractor</strong> matched on both phone and name. A
          listing cannot belong to two companies, so at most one claimant is right.
        </p>
        <p>
          Compare each claimant&apos;s L&amp;I name and phone against the listing. A shared phone is
          common between related companies and is weak on its own; the <em>name</em> is the
          independent signal here, which is why these reached this page at all.
        </p>
        <p>
          Nothing is decided here. These links are held back from every public surface until the
          registry resolves them — this page exists so the conflict is visible rather than silently
          pending.
        </p>
      </div>
    </details>
  );
}
