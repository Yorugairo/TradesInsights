import type { ActionLinks } from "./actions.js";
import type { DigestItem, DigestModel } from "./digest.js";

/** Deterministic digest rendering — same model in, same bytes out (action
 * links, when provided, are part of the input model for that delivery). */

export interface RenderOptions {
  /** P2.3 — one-tap links per opportunityId (issued by deliverDigest). */
  actionLinks?: Map<string, ActionLinks>;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Plain-English humanization (deterministic — no model involved) ───────────
// The DigestModel keeps raw audit values; this layer turns them into words a
// busy owner reads in seconds. Unknown inputs degrade to de-snake-cased text,
// never to fabricated content.

const STAGE_PHRASES: Record<string, string> = {
  concept: "Concept",
  preapplication: "Pre-application",
  entitlement: "In land-use review",
  approved: "Approved",
  construction_documents: "In design",
  permit_applied: "Permit applied",
  permit_issued: "Permit issued",
  bidding_confirmed: "Out to bid",
  construction: "Under construction",
  near_final: "Nearly complete",
  complete: "Complete",
  withdrawn: "Withdrawn",
  unknown: "Status unknown",
};

function humanStage(stage: string): string {
  return STAGE_PHRASES[stage] ?? stage.replace(/_/g, " ");
}

/** "City of Seattle (King Co.)" — or just the jurisdiction when it already
 * names the county ("Unincorporated King County"). */
function humanPlace(county: string, jurisdiction: string): string {
  if (jurisdiction.toLowerCase().includes(county.toLowerCase())) return jurisdiction;
  return `${jurisdiction} (${county} Co.)`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO date prefix → "Jun 3, 2026" — pure string math, no timezone drift. */
function humanDate(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : null;
}

function deSnake(s: string): string {
  const last = s.includes(".") ? s.slice(s.lastIndexOf(".") + 1) : s;
  return last.replace(/_/g, " ");
}

/** One verified (path, value) fact → a phrase. */
function humanFact(f: { path: string; value: unknown }): string {
  const v = f.value;
  if (f.path === "project.valuationUsd" || f.path === "project_valuation") {
    return typeof v === "number" ? `$${v.toLocaleString("en-US")} job value` : `job value ${String(v)}`;
  }
  if (f.path.startsWith("dates.")) {
    const what = deSnake(f.path);
    const d = typeof v === "string" ? humanDate(v) : null;
    return d ? `${what} ${d}` : `${what} on record`;
  }
  if (f.path === "project.stage") return `status “${String(v)}”`;
  if (f.path === "project.parcel") return `parcel ${String(v)}`;
  if (f.path === "project.units" || f.path === "unit_count") return `${String(v)} units`;
  if (f.path === "externalId") return `record ${String(v)}`;
  if (f.path === "project.address") return String(v);
  if (f.path === "project.description") {
    const s = String(v);
    return `“${s.length > 140 ? `${s.slice(0, 140)}…` : s}”`;
  }
  return `${deSnake(f.path)}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
}

/** Missing-critical-fact keys → what the owner still needs to find out. */
const MISSING_PHRASES: Record<string, string> = {
  general_contractor: "who the GC is",
  procurement_status: "whether it's out to bid",
  bid_date: "the bid due date",
  unit_count: "unit count",
  "project.units": "unit count",
  "project.address": "the site address",
  "project.parcel": "the parcel number",
  "project.description": "scope details",
  "roles.developer": "the developer",
  "roles.architect": "the architect",
  "roles.applicant": "the applicant",
  "dates.permit_issued": "the issue date",
  project_valuation: "the job value",
  "project.valuationUsd": "the job value",
};

function humanMissing(key: string): string {
  return MISSING_PHRASES[key] ?? deSnake(key);
}

/** Bid-window status → the bolded lead-in on the 🔨 line. */
const BID_PREFIX: Record<string, string> = {
  confirmed_open: "BID NOW",
  open: "OPEN NOW",
  opens_soon: "Opens soon",
  likely_closed: "Likely passed",
  watch: "Watching",
};

function actionButtons(id: string, opts: RenderOptions): string {
  const links = opts.actionLinks?.get(id);
  if (!links) return "";
  return `<p><a href="${esc(links.pursue)}" style="font-weight:bold">✓ Pursue this</a> &nbsp;·&nbsp; <a href="${esc(links.dismiss)}">✗ Not relevant</a></p>`;
}

function itemHtml(item: DigestItem, opts: RenderOptions = {}): string {
  const facts = item.confirmedFacts.length
    ? `<p><strong>What we know:</strong> ${item.confirmedFacts.map((f) => esc(humanFact(f))).join(" · ")}</p>`
    : "";
  const inferences = item.inferences.length
    ? `<p><em>${item.inferences.map(esc).join("<br/>")}</em></p>`
    : "";
  const missing = item.missingCriticalFacts.length
    ? `<p><strong>Still unknown:</strong> ${item.missingCriticalFacts.map((k) => esc(humanMissing(k))).join(" · ")}</p>`
    : "";
  // Per-trade bid-window inferences (docs/domain-bid-timing.md) — the lines a
  // busy owner acts on. Always typical-sequencing language, never a promise.
  const TRADE_ICON: Record<string, string> = { drywall: "🔨", paint: "🎨" };
  const TRADE_LABEL: Record<string, string> = { drywall: "Drywall bids", paint: "Paint bids" };
  const bidWindow = item.bidWindows
    .map(
      (w) =>
        `<p>${TRADE_ICON[w.trade] ?? "•"} <strong>${TRADE_LABEL[w.trade] ?? w.trade} — ${BID_PREFIX[w.status] ?? "Watching"}:</strong> ${esc(w.note)}</p>`,
    )
    .join("");
  // M3.8 — sources disagree on unit count: show every value with its citation,
  // never a single silently-chosen number.
  const unitConflict = item.unitCountDisagreement
    ? `<p><strong>⚠ Sources disagree on unit count:</strong> ${item.unitCountDisagreement
        .map(
          (v) =>
            `${v.units} units (${v.sources
              .map((s) => (s.url ? `<a href="${esc(s.url)}">${esc(s.label)}</a>` : esc(s.label)))
              .join(", ")})`,
        )
        .join(" vs. ")} — verify before quoting.</p>`
    : "";
  // #1 — active-campus context: one site aggregating many permits is one
  // relationship worth working, not N disconnected leads.
  const campus = item.campus
    ? `<p><strong>Active campus:</strong> one of ${item.campus.projectCount} active projects on parcel block ${esc(item.campus.block)} — one site, one relationship.</p>`
    : "";
  const links = item.sourceLinks
    .map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`)
    .join(" · ");
  return `<li>
    <p><strong>${esc(item.projectName)}</strong><br/>${esc(humanStage(item.stage))} · ${esc(humanPlace(item.county, item.jurisdiction))} · score ${item.score ?? "—"}</p>
    ${bidWindow}<p><strong>What changed:</strong> ${esc(item.whatChanged).replace(/_/g, " ")}</p>
    <p><strong>Why it fits:</strong> ${esc(item.whyItFits)}</p>
    ${campus}${facts}${inferences}${missing}${unitConflict}
    <p><strong>Next step:</strong> ${esc(item.nextAction)}</p>
    ${actionButtons(item.opportunityId, opts)}
    <p>Sources: ${links || "—"}</p>
  </li>`;
}

function section(title: string, items: DigestItem[], opts: RenderOptions = {}): string {
  return `<h2>${esc(title)}</h2>
${items.length === 0 ? "<p>Nothing this week.</p>" : `<ol>${items.map((i) => itemHtml(i, opts)).join("\n")}</ol>`}`;
}

/** P2.2 — the 10-minute top block: winnable now, GCs worth meeting, deadlines,
 * radar. Renders ONLY the parts with content; the full §18 sections follow. */
function topBlock(model: DigestModel, opts: RenderOptions): string {
  const parts: string[] = [];
  if (model.easyWins.length > 0) {
    parts.push(`<h2>⚡ Winnable now (${model.easyWins.length})</h2>
<p>Right stage, right size, a named contact, inside your service area.</p>
<ol>${model.easyWins.map((i) => itemHtml(i, opts)).join("\n")}</ol>`);
  }
  if (model.relationshipPlays.length > 0) {
    parts.push(`<h2>🤝 GCs worth meeting</h2>
<ul>${model.relationshipPlays
      .map(
        (p) =>
          `<li><strong>${esc(p.name)}</strong> — ${p.relevantProjects} projects routed to you (${esc(p.counties.join(", "))}). No relationship on record yet.</li>`,
      )
      .join("\n")}</ul>`);
  }
  if (model.deadlines.length > 0) {
    parts.push(`<h2>⏰ Deadlines from your inbox</h2>
<ul>${model.deadlines
      .map(
        (d) =>
          `<li><strong>${d.bidDueAt.slice(0, 10)}</strong> — ${esc(d.title ?? d.scope ?? "bid invitation")}${d.generalContractor ? ` (${esc(d.generalContractor)})` : ""}</li>`,
      )
      .join("\n")}</ul>`);
  }
  if (model.radar.length > 0) {
    parts.push(`<h2>📡 Radar (early stage)</h2>
<ul>${model.radar
      .map(
        (i) =>
          `<li><strong>${esc(i.projectName)}</strong> — ${esc(humanStage(i.stage))} · ${esc(i.county)} · ${esc(i.whatChanged).replace(/_/g, " ")}</li>`,
      )
      .join("\n")}</ul>`);
  }
  return parts.length > 0 ? `${parts.join("\n")}\n<hr/>\n` : "";
}

export function digestSubject(model: DigestModel): string {
  return `OTN weekly digest — ${model.accountName} — week ending ${model.periodEnd.toISOString().slice(0, 10)}`;
}

export function renderDigestHtml(model: DigestModel, opts: RenderOptions = {}): string {
  const coverage =
    model.sections.coverage.length === 0 &&
    model.suppressed.gateFailed === 0 &&
    model.suppressed.blockedOnVerifier === 0 &&
    model.suppressed.customerSuppressed === 0 &&
    model.reviewQueue.length === 0
      ? "<p>All enabled sources green; nothing suppressed.</p>"
      : `<ul>
${model.sections.coverage
  .map((c) => `<li>Source ${esc(c.sourceKey)} (${esc(c.sourceName)}) is ${esc(c.freshnessState)} — coverage may be degraded.</li>`)
  .join("\n")}
${
  model.suppressed.blockedOnVerifier > 0
    ? `<li>${model.suppressed.blockedOnVerifier} matching opportunit${model.suppressed.blockedOnVerifier === 1 ? "y" : "ies"} withheld pending independent verification (model verification not yet run).</li>`
    : ""
}
${
  model.suppressed.gateFailed > 0
    ? `<li>${model.suppressed.gateFailed} matching opportunit${model.suppressed.gateFailed === 1 ? "y" : "ies"} withheld by the publication gate (incomplete identity, stale, or unsupported facts).</li>`
    : ""
}
${
  model.reviewQueue.length > 0
    ? `<li>${model.reviewQueue.length} verified item${model.reviewQueue.length === 1 ? "" : "s"} held for human review before inclusion (controlled automation).</li>`
    : ""
}
${
  model.suppressed.customerSuppressed > 0
    ? `<li>${model.suppressed.customerSuppressed} matching project${model.suppressed.customerSuppressed === 1 ? "" : "s"} suppressed at your request (project/organization on your suppression list).</li>`
    : ""
}
</ul>`;

  return `<h1>${esc(digestSubject(model))}</h1>
<p>Period ${model.periodStart.toISOString().slice(0, 10)} → ${model.periodEnd.toISOString().slice(0, 10)}. Every fact below is sourced; inferences are labeled.</p>
${topBlock(model, opts)}${section("1. Priority new opportunities", model.sections.priorityNew, opts)}
${section("2. Material stage changes", model.sections.stageChanges, opts)}
${section("3. Missing-fact verification queue", model.sections.missingFacts, opts)}
${section("4. Monitoring", model.sections.monitoring, opts)}
<h2>5. Coverage &amp; source health</h2>
${coverage}`;
}
