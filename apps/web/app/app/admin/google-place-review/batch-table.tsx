"use client";

/**
 * Google Place review — the batch surface.
 *
 * The queue shipped with per-row buttons only, which is fine for a handful of
 * rows and unusable for 201: an operator scanning a screen of listings where the
 * address obviously matches had to click each one.
 *
 * Mirrors `RegistryReviewTable` (registry-review/actions.tsx) deliberately —
 * select-many, one grouping shortcut, a sequential batch loop, j/k/x movement —
 * so the two review surfaces behave the same way under the hands.
 *
 * The batch loop is CLIENT-SIDE and SEQUENTIAL on purpose. Each decision is its
 * own idempotent POST (`ON CONFLICT (dedupe_key) DO NOTHING` registry-side), so a
 * failure part-way leaves every earlier row decided and every later row
 * untouched — a state an operator can look at and understand. A single
 * server-side bulk endpoint would be one round-trip faster and would fail as an
 * opaque all-or-nothing.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
// TYPE-ONLY import. A value import from @otn/resolution drags `pg` into the
// client bundle and breaks the build.
import type { GooglePlaceReviewRow } from "@otn/resolution";
import { Badge, cell, table } from "../../../../lib/ui.js";
import { LABEL, TITLE, type PlaceResolution } from "./actions.js";

const RESOLUTIONS: PlaceResolution[] = ["accepted", "rejected", "needs_evidence"];
const FOCUS_BG = "#eef6ff";

/**
 * Does the Google address contain the L&I address? The strongest signal on this
 * queue (a different phone is common and weak; a different address usually means
 * a different business), so it is the one grouping worth a one-click select.
 */
export function addressAgrees(row: GooglePlaceReviewRow): boolean {
  return row.lni.address !== null && row.google.address !== null
    ? row.google.address.toLowerCase().includes(row.lni.address.toLowerCase())
    : false;
}

type RowState = PlaceResolution | "already" | { error: string } | undefined;

async function postDecision(
  reviewId: number,
  resolution: PlaceResolution,
): Promise<{ ok: boolean; already: boolean; error?: string }> {
  const res = await fetch(`/api/admin/google-place-review/${reviewId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolution }),
  });
  const body = (await res.json().catch(() => null)) as
    | { error?: string; alreadyDecided?: boolean }
    | null;
  if (res.ok) return { ok: true, already: body?.alreadyDecided === true };
  return { ok: false, already: false, error: body?.error ?? `failed (${res.status})` };
}

export function PlaceReviewTable({ rows }: { rows: GooglePlaceReviewRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<Record<number, RowState>>({});

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.reviewId)),
    [rows, selected],
  );
  const addressMatches = useMemo(() => rows.filter(addressAgrees), [rows]);

  const toggle = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setRow = (id: number, state: RowState) => setResult((prev) => ({ ...prev, [id]: state }));

  const decideOne = useCallback(
    async (id: number, resolution: PlaceResolution) => {
      setBusy(true);
      const r = await postDecision(id, resolution);
      setBusy(false);
      if (r.ok) {
        setRow(id, r.already ? "already" : resolution);
        router.refresh();
      } else {
        setRow(id, { error: r.error ?? "failed" });
      }
    },
    [router],
  );

  const runBatch = useCallback(
    async (resolution: PlaceResolution) => {
      if (selectedRows.length === 0) return;
      // The confirm names how many of the selection the address actually backs —
      // the number an operator would want to know before accepting in bulk.
      const backed = selectedRows.filter(addressAgrees).length;
      const message =
        `${LABEL[resolution]} — ${selectedRows.length} listing(s)?\n` +
        `${backed} of them have a matching address.\n` +
        `Queued for the registry, which applies decisions itself.`;
      if (!window.confirm(message)) return;

      setBusy(true);
      let done = 0;
      for (const row of selectedRows) {
        setProgress(`${done}/${selectedRows.length}…`);
        const r = await postDecision(row.reviewId, resolution);
        setRow(row.reviewId, r.ok ? (r.already ? "already" : resolution) : { error: r.error ?? "failed" });
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
        if (r) toggle(r.reviewId);
        ev.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, focus, toggle]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.reviewId));

  return (
    <>
      <div style={barStyle} data-testid="place-batch-bar">
        <label style={{ fontSize: "0.85rem" }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.reviewId)))
            }
          />{" "}
          all {rows.length}
        </label>
        {addressMatches.length > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set(addressMatches.map((r) => r.reviewId)))}
            title="The address is the strongest signal on this queue"
            style={{ fontSize: "0.8rem" }}
          >
            select {addressMatches.length} address matches
          </button>
        )}
        <strong style={{ fontSize: "0.85rem" }}>{selectedRows.length} selected</strong>
        {RESOLUTIONS.map((r) => (
          <button
            key={r}
            type="button"
            disabled={busy || selectedRows.length === 0}
            onClick={() => void runBatch(r)}
            title={TITLE[r]}
            data-testid={`place-batch-${r}`}
            style={{ fontSize: "0.8rem" }}
          >
            {LABEL[r]} selected
          </button>
        ))}
        {progress && <small style={{ color: "#666" }}>{progress}</small>}
        <small style={{ color: "#888", marginLeft: "auto" }}>j/k move · x select</small>
      </div>

      <table style={table} data-testid="google-place-table">
        <thead>
          <tr>
            <th style={cell} aria-label="select" />
            <th style={cell}>L&amp;I contractor</th>
            <th style={cell}>Google listing</th>
            <th style={cell}>Why it&apos;s here</th>
            <th style={cell}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <PlaceRow
              key={row.reviewId}
              row={row}
              focused={i === focus}
              checked={selected.has(row.reviewId)}
              onToggle={() => toggle(row.reviewId)}
              state={result[row.reviewId]}
              busy={busy}
              onDecide={decideOne}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={cell} colSpan={5}>
                No actionable rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

const barStyle = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
  flexWrap: "wrap" as const,
  margin: "0.5rem 0",
  padding: "0.4rem 0.6rem",
  background: "#f6f6f6",
  borderRadius: 4,
  position: "sticky" as const,
  top: 0,
  zIndex: 1,
};

function PlaceRow({
  row,
  focused,
  checked,
  onToggle,
  state,
  busy,
  onDecide,
}: {
  row: GooglePlaceReviewRow;
  focused: boolean;
  checked: boolean;
  onToggle: () => void;
  state: RowState;
  busy: boolean;
  onDecide: (id: number, resolution: PlaceResolution) => Promise<void>;
}) {
  const sameAddress = addressAgrees(row);
  return (
    <tr style={focused ? { background: FOCUS_BG } : undefined}>
      <td style={cell}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label="select row" />
      </td>
      <td style={cell}>
        <strong>{row.lni.businessName ?? row.entityName ?? "—"}</strong>
        <br />
        <small style={{ color: "#666" }}>
          {row.lni.licenseNumber ?? "no licence"}
          {row.lni.licenseType ? ` · ${row.lni.licenseType}` : ""}
          {row.ubi ? ` · UBI ${row.ubi}` : ""}
        </small>
        <br />
        <small>
          {row.lni.address ?? "—"}
          {row.lni.city ? `, ${row.lni.city}` : ""} {row.lni.zip ?? ""}
        </small>
        <br />
        <small style={{ color: "#666" }}>{row.lni.phone ?? "no phone"}</small>
      </td>
      <td style={cell}>
        <strong>{row.google.name ?? "—"}</strong>
        {row.google.rating !== null && (
          <small style={{ color: "#666" }}>
            {" "}
            ★ {row.google.rating}
            {row.google.reviewCount !== null ? ` (${row.google.reviewCount.toLocaleString()})` : ""}
          </small>
        )}
        <br />
        <small style={{ color: sameAddress ? "#137333" : "#a00" }}>
          {row.google.address ?? "—"} {sameAddress ? "✓ same address" : ""}
        </small>
        <br />
        <small style={{ color: "#666" }}>{row.google.phone ?? "no phone"}</small>
        {row.google.category ? (
          <small style={{ color: "#666" }}> · {row.google.category}</small>
        ) : null}
        <br />
        <small>
          {row.google.mapsUrl && (
            <a href={row.google.mapsUrl} target="_blank" rel="noreferrer noopener">
              maps ↗
            </a>
          )}
          {row.google.website && (
            <>
              {row.google.mapsUrl ? " · " : ""}
              <a href={row.google.website} target="_blank" rel="noreferrer noopener">
                website ↗
              </a>
            </>
          )}
        </small>
      </td>
      <td style={cell}>
        <Badge tone="amber">{row.reason}</Badge>
        <br />
        <small style={{ color: "#666" }}>
          {row.match.status ?? "?"}
          {row.match.confidence !== null ? ` · confidence ${row.match.confidence}` : ""}
        </small>
        {row.match.conflictFlags.length > 0 && (
          <>
            <br />
            <small style={{ color: "#a00" }}>{row.match.conflictFlags.join(", ")}</small>
          </>
        )}
      </td>
      <td style={cell}>
        {state === undefined ? (
          <span style={{ whiteSpace: "nowrap" }}>
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                type="button"
                disabled={busy}
                onClick={() => void onDecide(row.reviewId, r)}
                title={TITLE[r]}
                data-testid={`place-${r}`}
                style={{ fontSize: "0.8rem", marginRight: "0.25rem" }}
              >
                {LABEL[r]}
              </button>
            ))}
          </span>
        ) : typeof state === "object" ? (
          <small style={{ color: "crimson" }}>{state.error}</small>
        ) : state === "already" ? (
          <small style={{ color: "#666" }}>already recorded</small>
        ) : (
          <small style={{ color: "#137333" }}>✓ {LABEL[state]} — queued</small>
        )}
      </td>
    </tr>
  );
}
