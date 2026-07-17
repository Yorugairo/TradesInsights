import Link from "next/link";
import { redirect } from "next/navigation";
import { COUNTIES, PROJECT_STAGES } from "@otn/domain";
import { currentSession } from "../../../lib/auth.js";
import { db } from "../../../lib/db.js";
import { accountByKey, listOpportunities } from "../../../lib/queries.js";
import { Badge, cell, fmtDate, table } from "../../../lib/ui.js";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

type Params = {
  state?: string;
  county?: string;
  stage?: string;
  q?: string;
  campus?: string;
  sort?: string;
  page?: string;
};

function qs(params: Params, overrides: Partial<Record<keyof Params, string | undefined>>): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const parts = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const session = await currentSession();
  if (!session?.accountKey) redirect("/login");
  const account = await accountByKey(db(), session.accountKey);
  if (!account) redirect("/login");
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const { items, total } = await listOpportunities(db(), account.id, {
    ...(params.state ? { state: params.state } : {}),
    ...(params.county ? { county: params.county } : {}),
    ...(params.stage ? { stage: params.stage } : {}),
    ...(params.q ? { q: params.q } : {}),
    ...(params.campus === "1" ? { campusOnly: true } : {}),
    ...(params.sort === "recent" ? { sort: "recent" as const } : {}),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main>
      <h1>Opportunities — {account.name}</h1>
      <p>
        Band:{" "}
        {["all", "priority_review", "weekly_digest", "promoted", "dismissed", "archive"].map((s) => (
          <Link
            key={s}
            href={`/app/opportunities${qs(params, { state: s === "all" ? undefined : s, page: undefined })}`}
            style={{ marginRight: "0.75rem", fontWeight: (params.state ?? "all") === s ? "bold" : "normal" }}
          >
            {s.replace("_", " ")}
          </Link>
        ))}
      </p>

      <form
        method="get"
        data-testid="opportunity-filters"
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", margin: "0.5rem 0 1rem" }}
      >
        {params.state && <input type="hidden" name="state" value={params.state} />}
        <input
          type="search"
          name="q"
          placeholder="Search name, jurisdiction, address"
          defaultValue={params.q ?? ""}
          style={{ minWidth: 260 }}
          data-testid="filter-q"
        />
        <select name="county" defaultValue={params.county ?? ""} data-testid="filter-county">
          <option value="">All counties</option>
          {COUNTIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select name="stage" defaultValue={params.stage ?? ""}>
          <option value="">All stages</option>
          {PROJECT_STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label style={{ whiteSpace: "nowrap" }}>
          <input type="checkbox" name="campus" value="1" defaultChecked={params.campus === "1"} /> active campus
        </label>
        <select name="sort" defaultValue={params.sort ?? "score"}>
          <option value="score">by score</option>
          <option value="recent">recently changed</option>
        </select>
        <button type="submit">Apply</button>
        <Link href="/app/opportunities">reset</Link>
      </form>

      <p data-testid="opportunity-count" style={{ color: "#666" }}>
        {total} matching · page {page} of {pages}
      </p>

      <table style={table} data-testid="opportunities-table">
        <thead>
          <tr>
            <th style={cell}>Project</th>
            <th style={cell}>County</th>
            <th style={cell}>Jurisdiction</th>
            <th style={cell}>Stage</th>
            <th style={cell}>Score</th>
            <th style={cell}>Route</th>
            <th style={cell}>State</th>
            <th style={cell}>Last change</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <td style={cell}>
                <Link href={`/app/opportunities/${o.id}`}>{o.projectName}</Link>{" "}
                {o.campusBlock && <Badge tone="green">campus</Badge>}
              </td>
              <td style={cell}>{o.county}</td>
              <td style={cell}>{o.permittingJurisdiction}</td>
              <td style={cell}>{o.stage}</td>
              <td style={cell}>{o.score ?? "—"}</td>
              <td style={cell}>{o.route ?? "—"}</td>
              <td style={cell}>
                <Badge tone={o.state === "priority_review" ? "green" : o.state === "dismissed" ? "red" : "gray"}>
                  {o.state}
                </Badge>
              </td>
              <td style={cell}>{fmtDate(o.lastMaterialChangeAt)}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td style={cell} colSpan={8}>
                No opportunities match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p>
        {page > 1 && (
          <Link href={`/app/opportunities${qs(params, { page: String(page - 1) })}`} style={{ marginRight: "1rem" }}>
            ← previous
          </Link>
        )}
        {page < pages && <Link href={`/app/opportunities${qs(params, { page: String(page + 1) })}`}>next →</Link>}
      </p>
    </main>
  );
}
