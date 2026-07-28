"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FieldEntryRow, FieldLinkSummary, FieldRollup } from "@otn/intelligence";

/**
 * Cockpit side of field communication: mint/revoke crew links, review the
 * activity timeline, approve/reject change orders. Client component in the
 * PursuitActions colocated pattern — fetch + router.refresh().
 */
export function FieldSection({
  pursuitId,
  links,
  entries,
  rollup,
}: {
  pursuitId: string;
  links: FieldLinkSummary[];
  entries: FieldEntryRow[];
  rollup: FieldRollup;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The raw URL exists only in this response — shown once, then gone.
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);

  async function mint(form: FormData) {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/app/pursuits/${pursuitId}/field-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: form.get("label") }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(((await res.json()) as { error?: string }).error ?? "mint failed");
      return;
    }
    setMintedUrl(((await res.json()) as { url: string }).url);
    router.refresh();
  }

  async function revoke(linkId: string) {
    setBusy(true);
    await fetch(`/api/app/pursuits/${pursuitId}/field-links`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId }),
    });
    setBusy(false);
    router.refresh();
  }

  async function decide(entryId: string, decision: "approved" | "rejected") {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/app/pursuits/${pursuitId}/field-entries/${entryId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    setBusy(false);
    if (!res.ok) setErr(((await res.json()) as { error?: string }).error ?? "decision failed");
    router.refresh();
  }

  const fmtQty = (e: FieldEntryRow) =>
    e.quantities
      ? [
          e.quantities.boards !== null ? `${e.quantities.boards} boards` : null,
          e.quantities.tapedLf !== null ? `${e.quantities.tapedLf} LF taped` : null,
          e.quantities.crewHours !== null ? `${e.quantities.crewHours} crew-hrs` : null,
        ].filter(Boolean).join(" · ")
      : "";

  return (
    <div className="grid gap-4" data-testid="field-section">
      {rollup.logCount > 0 && (
        <p data-testid="field-rollup">
          Logged to date: <strong>{rollup.boards}</strong> boards · <strong>{rollup.tapedLf}</strong> LF taped ·{" "}
          <strong>{rollup.crewHours}</strong> crew-hours across {rollup.logCount} log
          {rollup.logCount === 1 ? "" : "s"}
          {rollup.approvedExtras > 0 ? (
            <> · approved extras <strong>~${rollup.approvedExtras.toLocaleString("en-US")}</strong></>
          ) : null}
        </p>
      )}

      <div>
        <h3>Crew links</h3>
        <ul>
          {links.map((l) => (
            <li key={l.id}>
              {l.label} · expires {l.expiresAt.slice(0, 10)}
              {l.revokedAt ? <> · <span className="text-bad">revoked</span></> : null}
              {l.lastUsedAt ? ` · last used ${l.lastUsedAt.slice(0, 10)}` : " · never used"}
              {!l.revokedAt && (
                <>
                  {" "}
                  <button disabled={busy} onClick={() => revoke(l.id)}>Revoke</button>
                </>
              )}
            </li>
          ))}
          {links.length === 0 && <li>none — mint one below and text it to the crew</li>}
        </ul>
        <form action={mint} className="flex gap-2">
          <input name="label" placeholder="who is this link for? e.g. Javier" required data-testid="field-link-label" />
          <button disabled={busy} data-testid="field-link-mint">Create link</button>
        </form>
        {mintedUrl && (
          <p data-testid="field-link-url">
            Shown once — copy it now: <code>{mintedUrl}</code>
          </p>
        )}
      </div>

      <div>
        <h3>Activity</h3>
        <ul>
          {entries.map((e) => (
            <li key={e.id} style={{ marginBottom: "0.3rem" }}>
              <em>{e.createdAt.slice(0, 10)}</em>{" "}
              {e.entryType === "change_order" ? (
                <>
                  CO{e.amount !== null ? ` ~$${e.amount.toLocaleString("en-US")}` : ""} — {e.body}
                  {e.submittedName ? ` (signed ${e.submittedName})` : ""}{" "}
                  {e.status === "submitted" ? (
                    <>
                      <button disabled={busy} onClick={() => decide(e.id, "approved")} data-testid="co-decision-approve">
                        Approve
                      </button>{" "}
                      <button disabled={busy} onClick={() => decide(e.id, "rejected")} data-testid="co-decision-reject">
                        Reject
                      </button>
                    </>
                  ) : (
                    <strong>{e.status}</strong>
                  )}
                </>
              ) : (
                <>
                  {e.entryType.replaceAll("_", " ")} — {e.body}
                  {fmtQty(e) ? ` · ${fmtQty(e)}` : ""}
                  {e.viaLabel ? ` (via ${e.viaLabel})` : ""}
                </>
              )}
            </li>
          ))}
          {entries.length === 0 && <li>nothing from the field yet</li>}
        </ul>
      </div>

      {err && <p className="font-semibold text-bad">{err}</p>}
    </div>
  );
}
