"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FieldRollup, TakeoffSheet } from "@otn/intelligence";

/**
 * Editable worksheet over the takeoff API. PursuitActions pattern: fetch +
 * router.refresh(); totals always re-render from the server response rather
 * than being recomputed client-side, so the sheet and the stamp can never
 * disagree.
 */

const ASSEMBLY_OPTIONS = [
  "hang_finish", "level5_skim", "metal_stud_framing", "act_grid", "insulation",
  "fire_rated_assembly", "paint_walls", "paint_ceilings", "doors_frames", "scope_allowance",
];

/** ~sqft covered by one 4×8 board — the variance bridge from boards logged in
 * the field to sqft estimated on the sheet. An estimate, like everything here. */
const SQFT_PER_BOARD = 32;

export function SheetEditor({
  pursuitId,
  sheet,
  rollup,
}: {
  pursuitId: string;
  sheet: TakeoffSheet;
  rollup: FieldRollup;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function call(path: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setErr(null);
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "request failed");
      return false;
    }
    router.refresh();
    return true;
  }

  const base = `/api/app/pursuits/${pursuitId}/takeoff`;
  const patchLine = (lineId: string, patch: Record<string, unknown>) =>
    call(`${base}/lines`, "PATCH", { lineId, ...patch });

  function exportCsv() {
    const rows = [
      ["assembly", "description", "qty", "unit", "unit_cost", "line_total", "source", "provenance"],
      ...sheet.lines.map((l) => [
        l.assemblyKey, l.description, String(l.qty), l.unit, String(l.unitCost),
        String(Math.round(l.qty * l.unitCost * 100) / 100), l.source, l.provenance ?? "",
      ]),
      [], ["subtotal", String(sheet.totals.subtotal)], ["overhead", String(sheet.totals.overhead)],
      ["margin", String(sheet.totals.margin)], ["bid_price_estimate", String(sheet.totals.bidPrice)],
    ];
    const csv = rows
      .map((r) => r.map((c) => (/[",\n]/.test(c ?? "") ? `"${(c ?? "").replaceAll('"', '""')}"` : (c ?? ""))).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `takeoff-${pursuitId.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // The A6 loop: what the field has logged against what the sheet estimated.
  const hangLine = sheet.lines.find((l) => l.assemblyKey === "hang_finish");
  const loggedSqft = rollup.boards * SQFT_PER_BOARD;

  return (
    <div className="grid gap-4" data-testid="sheet-editor">
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="sheet-status">status: {sheet.status}</span>
        <label>
          waste %{" "}
          <input
            className="w-16"
            defaultValue={sheet.wastePct}
            onBlur={(e) => Number(e.target.value) !== sheet.wastePct && call(base, "PATCH", { wastePct: Number(e.target.value) })}
          />
        </label>
        <label>
          overhead %{" "}
          <input
            className="w-16"
            defaultValue={sheet.overheadPct}
            onBlur={(e) => Number(e.target.value) !== sheet.overheadPct && call(base, "PATCH", { overheadPct: Number(e.target.value) })}
          />
        </label>
        <label>
          margin %{" "}
          <input
            className="w-16"
            defaultValue={sheet.marginPct}
            onBlur={(e) => Number(e.target.value) !== sheet.marginPct && call(base, "PATCH", { marginPct: Number(e.target.value) })}
          />
        </label>
        <button disabled={busy} onClick={() => call(base, "POST", { action: "rederive" })} data-testid="rederive-btn">
          Re-derive (your edited lines are kept)
        </button>
        <button disabled={busy} onClick={exportCsv}>Export CSV</button>
        <button
          disabled={busy}
          onClick={() => call(base, "PATCH", { status: sheet.status === "draft" ? "final" : "draft" })}
        >
          {sheet.status === "draft" ? "Mark final" : "Reopen draft"}
        </button>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }} data-testid="takeoff-lines">
        <thead>
          <tr>
            <th>Assembly</th><th>Qty</th><th>Unit</th><th>Unit cost $</th><th>Line total</th><th>Source</th><th></th>
          </tr>
        </thead>
        <tbody>
          {sheet.lines.map((l) => (
            <tr key={l.id}>
              <td title={l.provenance ?? undefined}>
                {l.description}
                {l.provenance ? <span style={{ opacity: 0.6 }}> · {l.provenance}</span> : null}
              </td>
              <td>
                <input
                  className="w-24"
                  defaultValue={l.qty}
                  data-testid={`line-qty-${l.assemblyKey}`}
                  onBlur={(e) => Number(e.target.value) !== l.qty && patchLine(l.id, { qty: Number(e.target.value) })}
                />
              </td>
              <td>{l.unit}</td>
              <td>
                <input
                  className="w-24"
                  defaultValue={l.unitCost}
                  onBlur={(e) => Number(e.target.value) !== l.unitCost && patchLine(l.id, { unitCost: Number(e.target.value) })}
                />
              </td>
              <td>~${(Math.round(l.qty * l.unitCost * 100) / 100).toLocaleString("en-US")}</td>
              <td>{l.source}</td>
              <td>
                <button disabled={busy} onClick={() => call(`${base}/lines`, "DELETE", { lineId: l.id })}>×</button>
              </td>
            </tr>
          ))}
          {sheet.lines.length === 0 && (
            <tr><td colSpan={7}>no lines — the evidence yielded nothing; add lines below</td></tr>
          )}
        </tbody>
      </table>

      <form
        action={async (form: FormData) => {
          await call(`${base}/lines`, "POST", {
            assemblyKey: form.get("assemblyKey"),
            qty: Number(form.get("qty") ?? 0),
          });
        }}
        className="flex flex-wrap gap-2"
      >
        <select name="assemblyKey" data-testid="add-line-assembly">
          {ASSEMBLY_OPTIONS.map((k) => (
            <option key={k} value={k}>{k.replaceAll("_", " ")}</option>
          ))}
        </select>
        <input name="qty" placeholder="qty" required className="w-24" data-testid="add-line-qty" />
        <button disabled={busy} data-testid="add-line-btn">Add line</button>
      </form>

      <p data-testid="takeoff-totals">
        subtotal ~${sheet.totals.subtotal.toLocaleString("en-US")} · overhead ~$
        {sheet.totals.overhead.toLocaleString("en-US")} · margin ~${sheet.totals.margin.toLocaleString("en-US")} ·{" "}
        <strong>bid price ~${sheet.totals.bidPrice.toLocaleString("en-US")}</strong> (estimate)
      </p>

      {rollup.logCount > 0 && hangLine && (
        <p data-testid="takeoff-variance">
          Field check: crew has logged <strong>{rollup.boards}</strong> boards (~
          {loggedSqft.toLocaleString("en-US")} sqft at {SQFT_PER_BOARD} sqft/board) against{" "}
          <strong>{hangLine.qty.toLocaleString("en-US")}</strong> {hangLine.unit} estimated —{" "}
          {hangLine.qty > 0 ? `${Math.round((loggedSqft / hangLine.qty) * 100)}% of the estimate` : "no baseline"} ·{" "}
          {rollup.crewHours} crew-hours
          {rollup.approvedExtras > 0 ? ` · approved extras ~$${rollup.approvedExtras.toLocaleString("en-US")}` : ""}
        </p>
      )}

      <button
        disabled={busy}
        onClick={async () => {
          if (await call(base, "PATCH", { action: "stamp-estimate" })) router.push(`/app/pursuits/${pursuitId}`);
        }}
        data-testid="stamp-estimate-btn"
      >
        Use bid price as the pursuit&apos;s estimated value
      </button>

      {err && <p className="font-semibold text-bad" data-testid="takeoff-error">{err}</p>}
    </div>
  );
}
