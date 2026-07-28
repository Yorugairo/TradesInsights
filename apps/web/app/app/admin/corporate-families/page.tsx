import Link from "next/link";
import { redirect } from "next/navigation";
import { registryPool } from "../../../../lib/registry-db.js";
import {
  corporateFamilyRollup,
  loadBoundOrgIdsByEntity,
  type CorporateFamilyRollupRow,
  type FamilyGroup,
} from "@otn/intelligence";
import {
  corroborateEntities,
  lniVerifyUrl,
  type CorroborationSignal,
  type CorroborationVerdict,
  type PrincipalPersonPair,
  type RegistryIdentityRow,
} from "@otn/resolution";
import DerivedAt from "../../../../components/proof/DerivedAt.js";
import { currentSession } from "../../../../lib/auth.js";
import { db } from "../../../../lib/db.js";
import { familySnapshot } from "../../../../lib/registry-families.js";
import { Badge, cell, fmtDate, fmtMoney, table } from "../../../../lib/ui.js";
import { ConfirmRelationshipButton, type RelationshipClaim } from "./actions.js";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

/**
 * Corporate families — the identity tier ABOVE the legal entity.
 *
 * WA L&I gives us brand (contractor licence) and enterprise (UBI) for free, but
 * common CONTROL sits above both. Grouping on the L&I principal is the only way
 * to see one buying decision-maker behind several companies.
 *
 * PRIVACY (owner decision, 2026-07-23): this page displays PRIVATE INDIVIDUALS.
 * Admin-only under `/app/`, gated by `currentSession()`. Principal names must
 * never reach a public registry page, a pSEO surface, a digest, or any
 * unauthenticated route.
 *
 * NOTHING HERE BINDS. Families are derived at read time and are analytic only.
 */
export default async function CorporateFamiliesPage({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string; weak?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/app/opportunities");

  const params = await searchParams;
  const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const showWeak = params.weak === "1";

  const pool = registryPool();
  if (!pool) return <Unavailable reason="REGISTRY_DATABASE_URL is not set — the registry seam is offline." />;

  /*
    Reads the CACHED derivation instead of pulling the registry identity view
    per request.

    Measured 2026-07-27: `fetchRegistryIdentityRows` returns 72,952 rows and
    costs 5.2s warm / 29-79s cold, `loadPersonCandidates` another 6.4s. That is
    why this page took 109 SECONDS. The derivation on top of those rows is half
    a second — the cost was never the computation, it was shipping the whole
    view across the seam to render fifty rows.

    `derivedAt` is rendered below. Derived-on-a-schedule is the right trade for
    a review queue; presenting it as live would not be.
  */
  const snapshot = await familySnapshot();
  if (!snapshot) {
    return <Unavailable reason="The registry seam is configured but has not produced a snapshot yet." />;
  }
  const { families, dropped, pairs: allPairs, rows } = snapshot;

  const rollups = await corporateFamilyRollup(db(), families, { limit });
  const rollupById = new Map(rollups.map((r) => [r.familyId, r]));

  const newPairs = allPairs.filter((p) => !p.alreadyBound);
  const strongPairs = newPairs.filter((p) => p.verdict === "strong" || p.verdict === "corroborated");
  const weakPairs = newPairs.filter((p) => p.verdict === "name_only" || p.verdict === "contradicted");
  const shownPairs = (showWeak ? newPairs : strongPairs).slice(0, limit);

  // Accept-action support: PROVENANCE anchor org per registry entity (a bound
  // Insights org, else the confirm button is disabled), and a row index so the
  // principal↔person lane can corroborate the two ENTITIES a shared person links.
  const shownFamilies = families.slice(0, limit);
  const anchorEntityIds = [...new Set(shownFamilies.flatMap((f) => f.entityIds))];
  const anchorByEntity = await loadBoundOrgIdsByEntity(db(), anchorEntityIds);
  const byId = new Map(rows.map((r) => [r.entityId, r] as const));

  return (
    <main>
      <p>
        <Link href="/app/admin/cockpit">← cockpit</Link>
        {" · "}
        <Link href="/app/admin/registry-review">← registry review</Link>
      </p>
      <h1>Corporate families — common control above the legal entity</h1>

      <Orientation />

      <p className="font-semibold text-bad">
        <strong>Private individuals.</strong> Principal names appear here because this page is
        admin-only and authenticated. Do not copy them into a digest, an export, or a public page.
      </p>

      <div className="my-2 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-muted">
          {families.length} families · {rollups.length} with Insights activity
        </span>
        <DerivedAt at={snapshot.derivedAt} stale={snapshot.stale} />
        <span>·</span>
        {[50, 100, 300].map((n) => (
          <Link key={n} href={`?limit=${n}${showWeak ? "&weak=1" : ""}`} className={n === limit ? "font-bold text-ink" : "text-ink-muted underline"}>
            limit {n}
          </Link>
        ))}
      </div>

      {dropped.length > 0 && (
        <p className="font-semibold text-bad">
          <strong>{dropped.length} group(s) dropped</strong> for exceeding the size cap (
          {dropped.map((d) => `${d.principalKey}: ${d.entityCount}`).join(", ")}). A group this large
          is an agent that slipped both registry-side filters, not a family — dropped rather than
          truncated so the regression stays visible.
        </p>
      )}

      <h2>1. Families — {Math.min(families.length, limit)} shown</h2>
      <p className="max-w-[70ch] text-sm text-ink-muted">
        <strong>Claim:</strong> these registry companies share an officer, so they are one buying
        decision-maker. <strong>Weakest link</strong> is the fewest agreeing fields across any
        member-to-member pair — judge the family on that, not on its best pair.
      </p>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Principal(s)</th>
            <th style={cell}>Member companies</th>
            <th style={cell}>Weakest link</th>
            <th style={cell}>Insights brands</th>
            <th style={cell}>Projects</th>
            <th style={cell}>Stated value</th>
            <th style={cell}>Latest</th>
          </tr>
        </thead>
        <tbody>
          {shownFamilies.map((f) => (
            <FamilyRow
              key={f.familyId}
              family={f}
              rollup={rollupById.get(f.familyId)}
              rows={rows}
              anchorByEntity={anchorByEntity}
            />
          ))}
          {families.length === 0 && (
            <tr>
              <td style={cell} colSpan={7}>
                No families — the contract view has no <code>principals</code> column yet, or no
                principal spans more than one entity.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>
        2. Principal ↔ person discovery — {shownPairs.length} shown of {newPairs.length}
      </h2>
      <p className="max-w-[70ch] text-sm text-ink-muted">
        <strong>Claim:</strong> this person named on an Insights permit is the officer L&amp;I has on
        file for that registry company — which, if true, adds a company to a family we could not
        otherwise see. Permit data carries no middle name, so the match key is coarse (surname +
        given name) and <strong>collisions are expected</strong>; the evidence column is how you tell
        them apart. Nothing here binds anything.
      </p>
      <div className="my-2 flex flex-wrap gap-3 text-sm">
        <Link href={`?limit=${limit}`} className={showWeak ? "text-ink-muted underline" : "font-bold text-ink"}>
          corroborated only ({strongPairs.length})
        </Link>
        <Link href={`?limit=${limit}&weak=1`} className={showWeak ? "font-bold text-ink" : "text-ink-muted underline"}>
          include name-only &amp; contradicted ({weakPairs.length})
        </Link>
        <span className="text-ink-muted">
          {allPairs.length - newPairs.length} pair(s) merely confirm an existing binding — hidden.
        </span>
      </div>
      <table style={table}>
        <thead>
          <tr>
            <th style={cell}>Insights person</th>
            <th style={cell}>Registry company</th>
            <th style={cell}>Verdict</th>
            <th style={cell}>Why (evidence)</th>
          </tr>
        </thead>
        <tbody>
          {shownPairs.map((p, i) => (
            <PairRow key={`${p.candidate.organizationId}-${p.entity.entityId}-${i}`} pair={p} byId={byId} />
          ))}
          {shownPairs.length === 0 && (
            <tr>
              <td style={cell} colSpan={4}>
                No corroborated matches.{" "}
                {weakPairs.length > 0 && "Weaker ones are hidden — use the toggle above."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

/** What this queue is for, stated before any row — there are several review
 * queues and the tab alone does not say what claim is being judged. */
function Orientation() {
  return (
    <details open className="my-3 rounded-md border border-line bg-surface px-4 py-3">
      <summary className="cursor-pointer font-semibold text-ink">What am I looking at?</summary>
      <div className="mt-2 flex flex-col gap-2 text-sm text-ink-muted">
        <p>
          WA L&amp;I identifies a contractor at two levels: the <strong>UBI</strong> is the legal
          entity, the <strong>contractor licence</strong> is the operating brand. Both are already
          modelled. Neither can see <em>common control</em> — one person owning several separate
          UBIs. This page derives that third tier from the officer L&amp;I records on each licence.
        </p>
        <p>
          <strong>Section 1</strong> asks: are these companies really one owner?{" "}
          <strong>Section 2</strong> asks: is this person on an Insights permit the same human as
          that registry officer?
        </p>
        <p>
          Every claim shows its evidence <em>count</em> — how many independent fields agree beyond
          the name. Zero means only the name matches. A <em>middle-initial conflict</em> means
          L&amp;I itself spells two different people, and is close to decisive against.
        </p>
        <p>
          Links go to L&amp;I&apos;s public verification page for the company and to the source
          permit, so every claim is checkable at source.{" "}
          <strong>Nothing on this page changes any data</strong> — the queue is read-only by design.
        </p>
      </div>
    </details>
  );
}

const VERDICT_TONE: Record<CorroborationVerdict, "green" | "amber" | "red" | "gray"> = {
  strong: "green",
  corroborated: "amber",
  name_only: "gray",
  contradicted: "red",
};
const VERDICT_LABEL: Record<CorroborationVerdict, string> = {
  strong: "well corroborated",
  corroborated: "partly corroborated",
  name_only: "name only",
  contradicted: "contradicted",
};

/** Agreeing signals in black, disagreeing in red with a leading ✗. */
function Signals({ signals }: { signals: CorroborationSignal[] }) {
  if (signals.length === 0) return <small className="text-ink-muted">no other field agrees</small>;
  return (
    <ul className="list-disc pl-4">
      {signals.map((s) => (
        <li key={s.key} className={s.agrees ? "text-ok" : "text-bad"}>
          <small>
            {s.agrees ? "" : "✗ "}
            {s.label}
          </small>
        </li>
      ))}
    </ul>
  );
}

/** Citation: L&I's public verification page. No UBI ⇒ plain text, never a guess. */
function LniLink({
  row,
  children,
}: {
  row: { ubi?: string | null; contractorNumbers?: string[] | null };
  children: string;
}) {
  const href = lniVerifyUrl(row);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function FamilyRow({
  family,
  rollup,
  rows,
  anchorByEntity,
}: {
  family: FamilyGroup;
  rollup: CorporateFamilyRollupRow | undefined;
  rows: RegistryIdentityRow[];
  anchorByEntity: Map<string, string>;
}) {
  const byId = new Map(rows.map((r) => [r.entityId, r]));
  return (
    <tr>
      <td style={cell}>
        <strong>{family.principalNames.join(" · ")}</strong>
        <br />
        <small className="text-ink-muted">
          <code>{family.familyId}</code>
        </small>
      </td>
      <td style={cell}>
        <small>
          {family.entityIds.map((id, i) => {
            const r = byId.get(id);
            return (
              <span key={id}>
                {i > 0 && ", "}
                <LniLink row={r ?? {}}>{r?.canonicalName ?? id}</LniLink>
              </span>
            );
          })}
        </small>
      </td>
      <td style={cell}>
        <Badge tone={family.minPoints === 0 ? "gray" : family.minPoints >= 3 ? "green" : "amber"}>
          {family.minPoints} shared field{family.minPoints === 1 ? "" : "s"}
        </Badge>
        {family.pairs.length > 0 && (
          <details>
            <summary className="cursor-pointer text-ink">
              <small>{family.pairs.length} pair(s)</small>
            </summary>
            {family.pairs.map((p) => {
              // Anchor on entity A's bound Insights org, else B's, else null
              // (button disabled — nothing to record the observation against).
              const anchor = anchorByEntity.get(p.entityAId) ?? anchorByEntity.get(p.entityBId) ?? null;
              return (
                <div key={`${p.entityAId}-${p.entityBId}`} className="mt-1.5">
                  <small>
                    <em>
                      {p.entityAName} ↔ {p.entityBName}
                    </em>
                  </small>
                  <Signals signals={p.corroboration.signals} />
                  <small className="text-ink-muted">{p.corroboration.explanation}</small>
                  {/* No confirm on a contradicted pair — one click must not
                      override a middle-initial conflict L&I itself records. */}
                  {p.corroboration.verdict !== "contradicted" && (
                    <div className="mt-1">
                      <ConfirmRelationshipButton
                        claim={{
                          organizationId: anchor,
                          registryEntityIdA: p.entityAId,
                          registryEntityIdB: p.entityBId,
                          principalKey: family.familyId,
                          corroboration: p.corroboration,
                          labelA: p.entityAName ?? p.entityAId,
                          labelB: p.entityBName ?? p.entityBId,
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </details>
        )}
      </td>
      <td style={cell}>
        {/* No rollup row = no Insights org bound to any member yet. A real state,
            not a zero: the family exists but we have seen none of its work. */}
        {rollup ? (
          <>
            {rollup.brandCount} of {rollup.boundEntityCount} bound
            <br />
            <small>{rollup.orgNames.join(", ")}</small>
          </>
        ) : (
          <small className="text-ink-muted">none bound</small>
        )}
      </td>
      <td style={cell}>
        {rollup ? `${rollup.projects} (${rollup.projects90d} in 90d)` : "—"}
        <br />
        <small className="text-ink-muted">{rollup?.counties.join(", ")}</small>
      </td>
      <td style={cell}>{rollup ? fmtMoney(rollup.statedValuationTotal) : "—"}</td>
      <td style={cell}>
        <small>{fmtDate(rollup?.latestActivityAt)}</small>
      </td>
    </tr>
  );
}

function PairRow({ pair, byId }: { pair: PrincipalPersonPair; byId: Map<string, RegistryIdentityRow> }) {
  const c = pair.candidate;
  // A principal↔person match is a person↔entity claim; it becomes an entity↔entity
  // relationship only when the person's OWN org is bound to a DIFFERENT registry
  // entity — then this person links two companies. We corroborate THOSE TWO
  // entities (not the person) and only offer the button when they don't contradict.
  const otherEntityId = c.registryRef;
  const otherRow = otherEntityId ? byId.get(otherEntityId) : undefined;
  const relCorroboration =
    otherEntityId && otherEntityId !== pair.entity.entityId && otherRow
      ? corroborateEntities(pair.entity.row, otherRow, pair.entity.principalKey, null)
      : null;
  const relClaim: RelationshipClaim | null =
    relCorroboration && otherEntityId && otherRow && relCorroboration.verdict !== "contradicted"
      ? {
          organizationId: c.organizationId,
          registryEntityIdA: pair.entity.entityId,
          registryEntityIdB: otherEntityId,
          principalKey: pair.entity.principalKey,
          corroboration: relCorroboration,
          labelA: pair.entity.entityName ?? pair.entity.entityId,
          labelB: otherRow.canonicalName ?? otherEntityId,
        }
      : null;
  return (
    <tr>
      <td style={cell}>
        <strong>{c.personName}</strong>
        <br />
        <small className="text-ink-muted">
          <Badge tone={c.source === "organization" ? "amber" : "gray"}>{c.source}</Badge>{" "}
          {c.role ?? "role unknown"} · {c.projectCount ?? 0} project(s)
        </small>
        {c.sourceUrl && (
          <>
            <br />
            <small>
              <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener">
                source permit ↗
              </a>
            </small>
          </>
        )}
        {(c.jurisdictions?.length ?? 0) > 0 && (
          <>
            <br />
            <small className="text-ink-muted">{c.jurisdictions!.slice(0, 3).join(", ")}</small>
          </>
        )}
      </td>
      <td style={cell}>
        <LniLink row={pair.entity.row}>{pair.entity.entityName ?? pair.entity.entityId}</LniLink>
        <br />
        <small className="text-ink-muted">
          L&amp;I officer: {pair.entity.principalName} (<code>{pair.entity.principalKey}</code>)
        </small>
        {pair.entity.cityToken && (
          <>
            <br />
            <small className="text-ink-muted">registered in {pair.entity.cityToken}</small>
          </>
        )}
      </td>
      <td style={cell}>
        <Badge tone={VERDICT_TONE[pair.verdict]}>{VERDICT_LABEL[pair.verdict]}</Badge>
        <br />
        <small className="text-ink-muted">
          {pair.points} signal{pair.points === 1 ? "" : "s"} ·{" "}
          {pair.namesakes === 1 ? "unique name" : `${pair.namesakes} namesakes`}
        </small>
      </td>
      <td style={cell}>
        <Signals signals={pair.signals} />
        <small className="text-ink-muted">{pair.explanation}</small>
        {relClaim && (
          <div className="mt-1.5">
            <small className="text-ink-muted">
              links to <strong>{relClaim.labelB}</strong>:{" "}
            </small>
            <ConfirmRelationshipButton claim={relClaim} />
          </div>
        )}
      </td>
    </tr>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <main>
      <h1>Corporate families</h1>
      <p className="font-semibold text-bad">{reason}</p>
    </main>
  );
}
