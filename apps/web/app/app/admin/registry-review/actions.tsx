"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReviewTier } from "@otn/resolution";
import Table, { HeadTr, Td, Th, Tr } from "../../../../components/ui/Table.js";

/** Shared control styling for this queue's dense button rows. */
const BTN =
  "inline-flex items-center rounded-sm border border-line-strong bg-surface px-2 py-0.5 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Registry review — interactive gate. Batch is a CLIENT-SIDE SEQUENTIAL loop
 * over the existing per-id decision endpoint, never a bulk-SQL path: every
 * accept still runs `decideRegistryObservation` one at a time so the rule's
 * accept history, the binding side effects, and the strong-key backfeed all
 * fire exactly as they do for a single decision. Parallelism is deliberately
 * avoided — concurrent accepts can touch the same org row and race.
 */

/** Evidence a reviewer weighs on a name-binding suggestion (null for other types). */
export interface EvidenceView {
  nameSimilarity: number | null;
  orgPhones: string[];
  registryPhone: string | null;
  phoneAgrees: boolean;
  registryGooglePhone: string | null;
  orgAddresses: string[];
  registryAddress: string | null;
  sharedBucketSize: number | null;
  orgDomains: string[];
  registryRootDomain: string | null;
  /** The org name-variant that produced a binding_alias_exact hit (null else) —
   * the reviewer has to see WHICH name matched, since it isn't the org's own. */
  matchedAlias: string | null;
  /** The registry-side name `nameSimilarity` was actually diffed against — null
   * when that's just the canonical (registry_name), so this only appears when
   * it's telling you something extra: the match came through a DBA/brand. */
  matchedRegistryName: string | null;
  /** The specific operating brand this candidate binds to (a multi-brand
   * entity may have several) and that brand's OWN licence — null for a
   * non-name-keyed match (phone/address/domain), which identifies the
   * enterprise, not a specific brand within it. */
  matchedBrandName: string | null;
  matchedBrandLicence: string | null;
  /** The BRAND's own phone, from its OWN L&I record — NOT the entity-level
   * `registryPhone` above. Showing the entity's number as if it belonged to
   * this brand was a real live-review bug (2026-07-23): "Rescue Rooter" and
   * its parent entity "Blue Flame" have two different phone numbers on file. */
  matchedBrandPhone: string | null;
  localities: string[];
  roleRecords: number | null;
}

/** One serialized pending observation, shaped server-side for the client table. */
export interface ReviewRow {
  id: string;
  trustScore: number;
  observationType: string;
  ruleKey: string;
  /** Deterministic confidence tier (classifyReviewTier) — the batch grouping. */
  tier: ReviewTier;
  tierLabel: string;
  tierReason: string;
  suggestion: string;
  evidence: EvidenceView | null;
  components: string;
  /** WA L&I and Google independently agree on this business's phone AND its
   * name — two systems that never consulted each other landing on the same
   * company. The queue's strongest evidence, so it gets its own one-click
   * grouping. Strictly `phone_and_name`: phone agreement alone is usually just
   * how the Google link was created, which makes it circular. */
  googleConfirmed: boolean;
  /** This org holds a `primary_contractor` role on at least one project — it is
   * the party that actually pulled the permit, not an applicant or an
   * incidental mention. Binding one of these is worth more than binding several
   * peripheral orgs, so it gets its own one-click grouping. Computed server-side
   * at render time; see `loadPrimaryContractorOrgIds` for why it is not stamped
   * into the payload. */
  primaryContractor: boolean;
}

/**
 * Tier button labels, restated here rather than imported from `@otn/resolution`.
 * This is a "use client" component, so a VALUE import from that barrel pulls the
 * whole server module graph — including `pg` — into the browser bundle and the
 * build fails on node-only requires. Types are erased at compile time and stay
 * safe to import; `ReviewRow.tierLabel` carries the server's own label for the
 * per-row badge, so these two strings are the only duplication.
 */
const TIER_BUTTON_LABELS: Record<ReviewTier, string> = {
  tier1: "High confidence",
  tier2: "Medium",
  tier3: "Low · inspect",
};

/**
 * Tier badge palette (green → amber → gray, highest → lowest).
 *
 * Outlines, not pastel fills. The previous values (#e6f4ea / #fef7e0 / #f1f3f4)
 * were authored for a white page and rendered as near-white pills with pale
 * text once the register went dark — the same contrast failure `lib/ui`'s Badge
 * had. Status colours are legible as TEXT in both registers; a tinted fill would
 * need a separate foreground per register to stay above AA.
 */
const TIER_CLASS: Record<ReviewTier, string> = {
  tier1: "border-ok text-ok",
  tier2: "border-warn text-warn",
  tier3: "border-line-strong text-ink-muted",
};

type RowState = "accepted" | "rejected" | "skipped" | { error: string };

async function postDecision(
  id: string,
  decision: "accept" | "reject",
  note?: string,
): Promise<{ ok: true } | { ok: false; error: string; alreadyDecided: boolean }> {
  const res = await fetch(`/api/admin/registry-observations/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  const error = body?.error ?? `failed (${res.status})`;
  // The endpoint returns "observation already accepted/rejected" for a row a
  // prior pass (or another reviewer) already decided — a skip, not a failure.
  return { ok: false, error, alreadyDecided: /already/i.test(error) };
}

function ruleMix(rows: ReviewRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.ruleKey, (counts.get(r.ruleKey) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(", ");
}

function Evidence({ e }: { e: EvidenceView }) {
  const lines: string[] = [];
  // Name similarity is diffed against matchedRegistryName when the match came
  // through a DBA/brand — showing WHICH name it's really comparing against, so
  // "0.00" reads as "compared to a different name" instead of "weak match".
  if (e.nameSimilarity !== null) {
    const vs = e.matchedRegistryName ? ` (vs "${e.matchedRegistryName}")` : "";
    lines.push(`name ${e.nameSimilarity.toFixed(2)}${vs}`);
  }
  if (e.matchedBrandName) {
    const lic = e.matchedBrandLicence ? ` · licence ${e.matchedBrandLicence}` : "";
    lines.push(`brand "${e.matchedBrandName}"${lic}`);
  }
  // Brand phone and entity phone are DIFFERENT numbers on a multi-brand
  // entity — never merge these into one line.
  if (e.matchedBrandPhone) lines.push(`brand phone ${e.matchedBrandPhone}`);
  if (e.registryPhone) {
    const org = e.orgPhones[0] ? `${e.orgPhones[0]} ` : "";
    lines.push(`entity phone ${org}vs L&I ${e.registryPhone} ${e.phoneAgrees ? "✓" : "✗"}`);
  }
  if (e.registryGooglePhone) lines.push(`google phone ${e.registryGooglePhone}`);
  if (e.registryAddress) {
    const shared = e.sharedBucketSize && e.sharedBucketSize > 1 ? ` (shared ×${e.sharedBucketSize})` : "";
    lines.push(`addr ${e.registryAddress}${shared}`);
  }
  if (e.registryRootDomain) {
    const org = e.orgDomains[0] ? ` (org ${e.orgDomains[0]})` : "";
    lines.push(`domain ${e.registryRootDomain}${org}`);
  }
  if (e.matchedAlias) lines.push(`matched via alias "${e.matchedAlias}"`);
  if (e.localities.length) lines.push(`in ${e.localities.slice(0, 3).join(", ")}`);
  if (e.roleRecords) lines.push(`${e.roleRecords} role records`);
  return (
    <span className="block text-xs leading-relaxed">
      {lines.map((l, i) => (
        <span key={i} className="block">
          {l}
        </span>
      ))}
    </span>
  );
}

/**
 * Keyboard-focus row highlight.
 *
 * Was `#eef6ff` — a near-white wash that, on the dark register, painted the
 * focused row almost the same colour as its own light text. The row an operator
 * is steering with j/k was the one row they could not read.
 */
const FOCUS_ROW_CLASS = "bg-surface-raised";

export function RegistryReviewTable({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, RowState>>({});

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

  // The queue's strongest evidence, grouped for one-click batch review. Kept
  // separate from the tier buttons because it is a FACT about the entity, not a
  // score band — a reviewer can verify it by opening the Google listing.
  const googleConfirmedRows = useMemo(() => rows.filter((r) => r.googleConfirmed), [rows]);

  // Permit-holding orgs. Orthogonal to the Google grouping above (an org can be
  // both), and to tier — this is about how much the binding is WORTH, not how
  // confident we are in it.
  const primaryContractorRows = useMemo(() => rows.filter((r) => r.primaryContractor), [rows]);

  const tierCounts = useMemo(() => {
    const m = new Map<ReviewTier, number>();
    for (const r of rows) m.set(r.tier, (m.get(r.tier) ?? 0) + 1);
    return m;
  }, [rows]);

  // One-click grouping: select every loaded candidate in a tier, then the
  // existing "Accept selected" batch-approves the whole group.
  const selectTier = useCallback(
    (tier: ReviewTier) => setSelected(new Set(rows.filter((r) => r.tier === tier).map((r) => r.id))),
    [rows],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setRow = (id: string, state: RowState) => setResult((prev) => ({ ...prev, [id]: state }));

  const decideOne = useCallback(
    async (id: string, decision: "accept" | "reject") => {
      const row = rows.find((r) => r.id === id);
      if (decision === "accept" && !window.confirm(`Accept ${row?.ruleKey ?? "observation"}? Binding applies immediately.`)) {
        return;
      }
      setBusy(true);
      const r = await postDecision(id, decision);
      setBusy(false);
      if (r.ok) {
        setRow(id, decision === "accept" ? "accepted" : "rejected");
        router.refresh();
      } else {
        setRow(id, r.alreadyDecided ? "skipped" : { error: r.error });
      }
    },
    [rows, router],
  );

  const runBatch = useCallback(
    async (decision: "accept" | "reject") => {
      if (!selectedRows.length) return;
      const verb = decision === "accept" ? "Accept" : "Reject";
      const tail = decision === "accept" ? "\nBindings apply immediately." : "";
      if (!window.confirm(`${verb} ${selectedRows.length} observation(s)?\nRules: ${ruleMix(selectedRows)}${tail}`)) {
        return;
      }
      setBusy(true);
      let done = 0;
      for (const row of selectedRows) {
        setProgress(`${done}/${selectedRows.length}…`);
        const r = await postDecision(row.id, decision);
        if (r.ok) setRow(row.id, decision === "accept" ? "accepted" : "rejected");
        else setRow(row.id, r.alreadyDecided ? "skipped" : { error: r.error });
        done += 1;
      }
      setProgress(`${done}/${selectedRows.length} done`);
      setBusy(false);
      setSelected(new Set());
      router.refresh();
    },
    [selectedRows, router],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
      if (ev.key === "j") {
        setFocus((f) => Math.min(f + 1, rows.length - 1));
        ev.preventDefault();
      } else if (ev.key === "k") {
        setFocus((f) => Math.max(f - 1, 0));
        ev.preventDefault();
      } else if (ev.key === "x") {
        const r = rows[focus];
        if (r) toggle(r.id);
        ev.preventDefault();
      } else if (ev.key === "a" && !busy) {
        const r = rows[focus];
        if (r) void decideOne(r.id, "accept");
        ev.preventDefault();
      } else if (ev.key === "r" && !busy) {
        const r = rows[focus];
        if (r) void decideOne(r.id, "reject");
        ev.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, focus, busy, toggle, decideOne]);

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <>
      <div
        className="mb-3 flex flex-wrap items-center gap-3 rounded-sm border border-line bg-surface-raised px-3 py-2"
        data-testid="batch-bar"
      >
        <strong className="text-ink">{selected.size} selected</strong>
        <button
          className={BTN}
          disabled={busy || selected.size === 0}
          onClick={() => void runBatch("accept")}
          data-testid="batch-accept"
        >
          Accept selected
        </button>
        <button
          className={BTN}
          disabled={busy || selected.size === 0}
          onClick={() => void runBatch("reject")}
          data-testid="batch-reject"
        >
          Reject selected
        </button>
        <span aria-hidden className="text-line-strong">
          |
        </span>
        <span className="text-xs text-ink-muted">group:</span>
        {(["tier1", "tier2", "tier3"] as ReviewTier[])
          .filter((t) => (tierCounts.get(t) ?? 0) > 0)
          .map((t) => (
            <button
              key={t}
              className={BTN}
              disabled={busy}
              onClick={() => selectTier(t)}
              data-testid={`select-${t}`}
              title={`Select all ${tierCounts.get(t)} ${t} candidates`}
            >
              {TIER_BUTTON_LABELS[t]} ({tierCounts.get(t)})
            </button>
          ))}
        {googleConfirmedRows.length > 0 && (
          <button
            className={BTN}
            disabled={busy}
            onClick={() =>
              setSelected(new Set(googleConfirmedRows.map((r) => r.id)))
            }
            data-testid="select-google-confirmed"
            title="WA L&I and Google independently agree on this business's phone AND its name — the strongest evidence in this queue"
          >
            L&amp;I + Google confirmed ({googleConfirmedRows.length})
          </button>
        )}
        {primaryContractorRows.length > 0 && (
          <button
            className={BTN}
            disabled={busy}
            onClick={() =>
              setSelected(new Set(primaryContractorRows.map((r) => r.id)))
            }
            data-testid="select-primary-contractor"
            title="Holds a primary_contractor role on at least one project — the party that actually pulled the permit, so the binding is worth more"
          >
            Primary contractor ({primaryContractorRows.length})
          </button>
        )}
        {progress && <span className="text-xs text-ink-muted">{progress}</span>}
        <span className="ml-auto text-xs text-ink-subtle">
          keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> select · <kbd>a</kbd>/<kbd>r</kbd>{" "}
          decide
        </span>
      </div>
      <Table
        data-testid="registry-observations-table"
        caption="Pending registry observations"
        head={
          <HeadTr>
            <Th>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                aria-label="select all"
                data-testid="select-all"
              />
            </Th>
            <Th numeric>Trust</Th>
            <Th>Tier</Th>
            <Th>Type</Th>
            <Th>Suggestion</Th>
            <Th>Rule</Th>
            <Th>Evidence</Th>
            <Th>Decision</Th>
          </HeadTr>
        }
      >
          {rows.map((o, idx) => {
            const state = result[o.id];
            const focused = idx === focus;
            return (
              <Tr
                key={o.id}
                className={focused ? FOCUS_ROW_CLASS : ""}
                data-testid="obs-row"
              >
                <Td>
                  <input
                    type="checkbox"
                    checked={selected.has(o.id)}
                    onChange={() => toggle(o.id)}
                    aria-label={`select ${o.id}`}
                  />
                </Td>
                <Td numeric>
                  <strong>{o.trustScore.toFixed(2)}</strong>
                </Td>
                <Td>
                  <span
                    title={o.tierReason}
                    className={`inline-flex whitespace-nowrap rounded-full border px-1.5 py-px text-2xs ${TIER_CLASS[o.tier]}`}
                  >
                    {o.tierLabel}
                  </span>
                </Td>
                <Td>{o.observationType.replace(/_/g, " ")}</Td>
                <Td>{o.suggestion}</Td>
                <Td>
                  <code className="text-ink-muted">{o.ruleKey}</code>
                </Td>
                <Td>
                  {o.evidence ? (
                    <Evidence e={o.evidence} />
                  ) : (
                    <span className="text-xs text-ink-muted">{o.components}</span>
                  )}
                </Td>
                <Td>
                  {state === "accepted" || state === "rejected" || state === "skipped" ? (
                    <span
                      className={`text-xs font-semibold ${state === "skipped" ? "text-warn" : "text-ok"}`}
                    >
                      {state}
                    </span>
                  ) : (
                    <span className="inline-flex gap-1 whitespace-nowrap">
                      <button className={BTN} disabled={busy} onClick={() => void decideOne(o.id, "accept")} data-testid="obs-accept">
                        Accept
                      </button>
                      <button className={BTN} disabled={busy} onClick={() => void decideOne(o.id, "reject")} data-testid="obs-reject">
                        Reject
                      </button>
                      {state && typeof state === "object" && (
                        <span className="text-xs font-semibold text-bad">{state.error}</span>
                      )}
                    </span>
                  )}
                </Td>
              </Tr>
            );
          })}
          {rows.length === 0 && (
            <Tr>
              <Td className="text-ink-muted">
                Queue is empty — the nightly pass regenerates it when the registry connection is configured.
              </Td>
            </Tr>
          )}
      </Table>
    </>
  );
}
