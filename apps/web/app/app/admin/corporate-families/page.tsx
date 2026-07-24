import Link from "next/link";
import { redirect } from "next/navigation";
import { createRegistryPool } from "@otn/db";
import {
  buildFamilies,
  corporateFamilyRollup,
  loadPersonCandidates,
  type CorporateFamilyRollupRow,
  type FamilyGroup,
} from "@otn/intelligence";
import {
  buildPrincipalPersonIndex,
  fetchRegistryIdentityRows,
  lniVerifyUrl,
  matchPrincipalsToPeople,
  type CorroborationSignal,
  type CorroborationVerdict,
  type PrincipalPersonPair,
  type RegistryIdentityRow,
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

  const pool = createRegistryPool();
  if (!pool) return <Unavailable reason="REGISTRY_DATABASE_URL is not set — the registry seam is offline." />;

  const rows = await fetchRegistryIdentityRows(pool);
  const { families, dropped } = buildFamilies(rows);
  const rollups = await corporateFamilyRollup(db(), families, { limit });
  const rollupById = new Map(rollups.map((r) => [r.familyId, r]));

  const candidates = await loadPersonCandidates(db());
  const allPairs = matchPrincipalsToPeople(candidates, buildPrincipalPersonIndex(rows));
  const newPairs = allPairs.filter((p) => !p.alreadyBound);
  const strongPairs = newPairs.filter((p) => p.verdict === "strong" || p.verdict === "corroborated");
  const weakPairs = newPairs.filter((p) => p.verdict === "name_only" || p.verdict === "contradicted");
  const shownPairs = (showWeak ? newPairs : strongPairs).slice(0, limit);

  return (
    <main style={{ padding: "1rem", maxWidth: 1150 }}>
      <p>
        <Link href="/app/admin/cockpit">← cockpit</Link>
        {" · "}
        <Link href="/app/admin/registry-review">← registry review</Link>
      </p>
      <h1>Corporate families — common control above the legal entity</h1>

      <Orientation />

      <p style={{ color: "#a00" }}>
        <strong>Private individuals.</strong> Principal names appear here because this page is
        admin-only and authenticated. Do not copy them into a digest, an export, or a public page.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", margin: "0.5rem 0" }}>
        <span style={{ color: "#666" }}>
          {families.length} families · {rollups.length} with Insights activity
        </span>
        <span>·</span>
        {[50, 100, 300].map((n) => (
          <Link key={n} href={`?limit=${n}${showWeak ? "&weak=1" : ""}`} style={{ fontWeight: n === limit ? 700 : 400 }}>
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

      <h2>1. Families — {Math.min(families.length, limit)} shown</h2>
      <p style={{ color: "#666", marginTop: 0 }}>
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
          {families.slice(0, limit).map((f) => (
            <FamilyRow key={f.familyId} family={f} rollup={rollupById.get(f.familyId)} rows={rows} />
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
      <p style={{ color: "#666", marginTop: 0 }}>
        <strong>Claim:</strong> this person named on an Insights permit is the officer L&amp;I has on
        file for that registry company — which, if true, adds a company to a family we could not
        otherwise see. Permit data carries no middle name, so the match key is coarse (surname +
        given name) and <strong>collisions are expected</strong>; the evidence column is how you tell
        them apart. Nothing here binds anything.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", margin: "0.5rem 0" }}>
        <Link href={`?limit=${limit}`} style={{ fontWeight: showWeak ? 400 : 700 }}>
          corroborated only ({strongPairs.length})
        </Link>
        <Link href={`?limit=${limit}&weak=1`} style={{ fontWeight: showWeak ? 700 : 400 }}>
          include name-only &amp; contradicted ({weakPairs.length})
        </Link>
        <span style={{ color: "#666" }}>
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
            <PairRow key={`${p.candidate.organizationId}-${p.entity.entityId}-${i}`} pair={p} />
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
    <details open style={{ border: "1px solid #ddd", borderRadius: 6, padding: "0.6rem 0.8rem", margin: "0.75rem 0" }}>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>What am I looking at?</summary>
      <div style={{ color: "#444", fontSize: "0.9rem", marginTop: "0.5rem" }}>
        <p style={{ margin: "0.3rem 0" }}>
          WA L&amp;I identifies a contractor at two levels: the <strong>UBI</strong> is the legal
          entity, the <strong>contractor licence</strong> is the operating brand. Both are already
          modelled. Neither can see <em>common control</em> — one person owning several separate
          UBIs. This page derives that third tier from the officer L&amp;I records on each licence.
        </p>
        <p style={{ margin: "0.3rem 0" }}>
          <strong>Section 1</strong> asks: are these companies really one owner?{" "}
          <strong>Section 2</strong> asks: is this person on an Insights permit the same human as
          that registry officer?
        </p>
        <p style={{ margin: "0.3rem 0" }}>
          Every claim shows its evidence <em>count</em> — how many independent fields agree beyond
          the name. Zero means only the name matches. A <em>middle-initial conflict</em> means
          L&amp;I itself spells two different people, and is close to decisive against.
        </p>
        <p style={{ margin: "0.3rem 0" }}>
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
  if (signals.length === 0) return <small style={{ color: "#666" }}>no other field agrees</small>;
  return (
    <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
      {signals.map((s) => (
        <li key={s.key} style={{ color: s.agrees ? "#111" : "#a00" }}>
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
}: {
  family: FamilyGroup;
  rollup: CorporateFamilyRollupRow | undefined;
  rows: RegistryIdentityRow[];
}) {
  const byId = new Map(rows.map((r) => [r.entityId, r]));
  return (
    <tr>
      <td style={cell}>
        <strong>{family.principalNames.join(" · ")}</strong>
        <br />
        <small style={{ color: "#666" }}>
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
            <summary style={{ cursor: "pointer" }}>
              <small>{family.pairs.length} pair(s)</small>
            </summary>
            {family.pairs.map((p) => (
              <div key={`${p.entityAId}-${p.entityBId}`} style={{ marginTop: "0.35rem" }}>
                <small>
                  <em>
                    {p.entityAName} ↔ {p.entityBName}
                  </em>
                </small>
                <Signals signals={p.corroboration.signals} />
                <small style={{ color: "#555" }}>{p.corroboration.explanation}</small>
              </div>
            ))}
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
          <small style={{ color: "#666" }}>none bound</small>
        )}
      </td>
      <td style={cell}>
        {rollup ? `${rollup.projects} (${rollup.projects90d} in 90d)` : "—"}
        <br />
        <small style={{ color: "#666" }}>{rollup?.counties.join(", ")}</small>
      </td>
      <td style={cell}>{rollup ? fmtMoney(rollup.statedValuationTotal) : "—"}</td>
      <td style={cell}>
        <small>{fmtDate(rollup?.latestActivityAt)}</small>
      </td>
    </tr>
  );
}

function PairRow({ pair }: { pair: PrincipalPersonPair }) {
  const c = pair.candidate;
  return (
    <tr>
      <td style={cell}>
        <strong>{c.personName}</strong>
        <br />
        <small style={{ color: "#666" }}>
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
            <small style={{ color: "#666" }}>{c.jurisdictions!.slice(0, 3).join(", ")}</small>
          </>
        )}
      </td>
      <td style={cell}>
        <LniLink row={pair.entity.row}>{pair.entity.entityName ?? pair.entity.entityId}</LniLink>
        <br />
        <small style={{ color: "#666" }}>
          L&amp;I officer: {pair.entity.principalName} (<code>{pair.entity.principalKey}</code>)
        </small>
        {pair.entity.cityToken && (
          <>
            <br />
            <small style={{ color: "#666" }}>registered in {pair.entity.cityToken}</small>
          </>
        )}
      </td>
      <td style={cell}>
        <Badge tone={VERDICT_TONE[pair.verdict]}>{VERDICT_LABEL[pair.verdict]}</Badge>
        <br />
        <small style={{ color: "#666" }}>
          {pair.points} signal{pair.points === 1 ? "" : "s"} ·{" "}
          {pair.namesakes === 1 ? "unique name" : `${pair.namesakes} namesakes`}
        </small>
      </td>
      <td style={cell}>
        <Signals signals={pair.signals} />
        <small style={{ color: "#555" }}>{pair.explanation}</small>
      </td>
    </tr>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <main style={{ padding: "1rem", maxWidth: 1150 }}>
      <h1>Corporate families</h1>
      <p style={{ color: "#a00" }}>{reason}</p>
    </main>
  );
}
