"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { REVIEW_TIER_LABELS, type ReviewTier } from "@otn/resolution";
import { cell } from "../../../../lib/ui.js";

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
}

/** Tier badge palette (green → amber → gray, highest → lowest). */
const TIER_STYLE: Record<ReviewTier, { bg: string; fg: string }> = {
  tier1: { bg: "#e6f4ea", fg: "#137333" },
  tier2: { bg: "#fef7e0", fg: "#a67c00" },
  tier3: { bg: "#f1f3f4", fg: "#5f6368" },
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
  if (e.nameSimilarity !== null) lines.push(`name ${e.nameSimilarity.toFixed(2)}`);
  if (e.registryPhone) {
    const org = e.orgPhones[0] ? `${e.orgPhones[0]} ` : "";
    lines.push(`phone ${org}vs L&I ${e.registryPhone} ${e.phoneAgrees ? "✓" : "✗"}`);
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
  if (e.localities.length) lines.push(`in ${e.localities.slice(0, 3).join(", ")}`);
  if (e.roleRecords) lines.push(`${e.roleRecords} role records`);
  return (
    <small style={{ display: "block", lineHeight: 1.4 }}>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </small>
  );
}

const FOCUS_BG = "#eef6ff";

export function RegistryReviewTable({ rows }: { rows: ReviewRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, RowState>>({});

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

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
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          margin: "0.5rem 0",
          padding: "0.4rem 0.6rem",
          background: "#f6f6f6",
          borderRadius: 4,
        }}
        data-testid="batch-bar"
      >
        <strong>{selected.size} selected</strong>
        <button disabled={busy || selected.size === 0} onClick={() => void runBatch("accept")} data-testid="batch-accept">
          Accept selected
        </button>
        <button disabled={busy || selected.size === 0} onClick={() => void runBatch("reject")} data-testid="batch-reject">
          Reject selected
        </button>
        <span style={{ color: "#ccc" }}>|</span>
        <small style={{ color: "#666" }}>group:</small>
        {(["tier1", "tier2", "tier3"] as ReviewTier[])
          .filter((t) => (tierCounts.get(t) ?? 0) > 0)
          .map((t) => (
            <button key={t} disabled={busy} onClick={() => selectTier(t)} data-testid={`select-${t}`} title={`Select all ${tierCounts.get(t)} ${t} candidates`}>
              {REVIEW_TIER_LABELS[t]} ({tierCounts.get(t)})
            </button>
          ))}
        {progress && <small style={{ color: "#555" }}>{progress}</small>}
        <small style={{ color: "#999", marginLeft: "auto" }}>
          keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> select · <kbd>a</kbd>/<kbd>r</kbd> decide
        </small>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }} data-testid="registry-observations-table">
        <thead>
          <tr>
            <th style={cell}>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                aria-label="select all"
                data-testid="select-all"
              />
            </th>
            <th style={cell}>Trust</th>
            <th style={cell}>Tier</th>
            <th style={cell}>Type</th>
            <th style={cell}>Suggestion</th>
            <th style={cell}>Rule</th>
            <th style={cell}>Evidence</th>
            <th style={cell}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o, idx) => {
            const state = result[o.id];
            const focused = idx === focus;
            return (
              <tr
                key={o.id}
                style={focused ? { background: FOCUS_BG } : undefined}
                onClick={() => setFocus(idx)}
                data-testid="obs-row"
              >
                <td style={cell}>
                  <input
                    type="checkbox"
                    checked={selected.has(o.id)}
                    onChange={() => toggle(o.id)}
                    aria-label={`select ${o.id}`}
                  />
                </td>
                <td style={cell}>
                  <strong>{o.trustScore.toFixed(2)}</strong>
                </td>
                <td style={cell}>
                  <span
                    title={o.tierReason}
                    style={{
                      background: TIER_STYLE[o.tier].bg,
                      color: TIER_STYLE[o.tier].fg,
                      padding: "1px 6px",
                      borderRadius: 10,
                      fontSize: "0.72rem",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {o.tierLabel}
                  </span>
                </td>
                <td style={cell}>{o.observationType.replace(/_/g, " ")}</td>
                <td style={cell}>{o.suggestion}</td>
                <td style={cell}>
                  <code>{o.ruleKey}</code>
                </td>
                <td style={cell}>
                  {o.evidence ? <Evidence e={o.evidence} /> : <small>{o.components}</small>}
                </td>
                <td style={cell}>
                  {state === "accepted" || state === "rejected" || state === "skipped" ? (
                    <small style={{ color: state === "skipped" ? "#a67c00" : "#137333" }}>{state}</small>
                  ) : (
                    <span style={{ whiteSpace: "nowrap" }}>
                      <button disabled={busy} onClick={() => void decideOne(o.id, "accept")} data-testid="obs-accept">
                        Accept
                      </button>{" "}
                      <button disabled={busy} onClick={() => void decideOne(o.id, "reject")} data-testid="obs-reject">
                        Reject
                      </button>
                      {state && typeof state === "object" && (
                        <small style={{ color: "crimson", marginLeft: "0.3rem" }}>{state.error}</small>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td style={cell} colSpan={8}>
                Queue is empty — the nightly pass regenerates it when the registry connection is configured.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
