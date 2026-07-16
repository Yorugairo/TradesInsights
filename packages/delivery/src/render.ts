import type { DigestItem, DigestModel } from "./digest.js";

/** Deterministic digest rendering — same model in, same bytes out. */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function itemHtml(item: DigestItem): string {
  const facts = item.confirmedFacts.length
    ? `<p><strong>Confirmed facts:</strong> ${item.confirmedFacts.map(esc).join(" · ")}</p>`
    : "";
  const inferences = item.inferences.length
    ? `<p><em>${item.inferences.map(esc).join("<br/>")}</em></p>`
    : "";
  const missing = item.missingCriticalFacts.length
    ? `<p><strong>Missing critical facts:</strong> ${item.missingCriticalFacts.map(esc).join(", ")}</p>`
    : "";
  const links = item.sourceLinks
    .map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`)
    .join(" · ");
  return `<li>
    <p><strong>${esc(item.projectName)}</strong> — ${esc(item.stage)} · ${esc(item.county)} / ${esc(item.jurisdiction)} · score ${item.score ?? "—"}</p>
    <p><strong>What changed:</strong> ${esc(item.whatChanged)}</p>
    <p><strong>Why it fits:</strong> ${esc(item.whyItFits)}</p>
    ${facts}${inferences}${missing}
    <p><strong>Next action:</strong> ${esc(item.nextAction)}</p>
    <p>Sources: ${links || "—"}</p>
  </li>`;
}

function section(title: string, items: DigestItem[]): string {
  return `<h2>${esc(title)}</h2>
${items.length === 0 ? "<p>Nothing this week.</p>" : `<ol>${items.map(itemHtml).join("\n")}</ol>`}`;
}

export function digestSubject(model: DigestModel): string {
  return `OTN weekly digest — ${model.accountName} — week ending ${model.periodEnd.toISOString().slice(0, 10)}`;
}

export function renderDigestHtml(model: DigestModel): string {
  const coverage =
    model.sections.coverage.length === 0 &&
    model.suppressed.gateFailed === 0 &&
    model.suppressed.blockedOnVerifier === 0
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
</ul>`;

  return `<h1>${esc(digestSubject(model))}</h1>
<p>Period ${model.periodStart.toISOString().slice(0, 10)} → ${model.periodEnd.toISOString().slice(0, 10)}. Every fact below is sourced; inferences are labeled.</p>
${section("1. Priority new opportunities", model.sections.priorityNew)}
${section("2. Material stage changes", model.sections.stageChanges)}
${section("3. Missing-fact verification queue", model.sections.missingFacts)}
${section("4. Monitoring", model.sections.monitoring)}
<h2>5. Coverage &amp; source health</h2>
${coverage}`;
}
