"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function InvitationUpload() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function upload() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/app/invitations/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawEml: raw }),
    });
    setBusy(false);
    if (res.ok) {
      const r = (await res.json()) as { deduped: boolean; matchStatus: string; deadlineChanged: boolean };
      setMsg(
        r.deduped
          ? "Already ingested (duplicate) — not re-added."
          : `Ingested · match: ${r.matchStatus}${r.deadlineChanged ? " · deadline changed" : ""}.`,
      );
      setRaw("");
      router.refresh();
    } else {
      setMsg(((await res.json()) as { error?: string }).error ?? "upload failed");
    }
  }

  return (
    <div className="my-4 rounded-lg border border-line bg-surface p-4">
      <h3 className="text-base font-semibold text-ink">Upload a bid-invitation email (.eml)</h3>
      <p className="mt-1 text-sm text-ink-muted">
        Paste a customer-authorized invitation email. Parsed deterministically; nothing is scraped.
        Re-uploading the same email is idempotent.
      </p>
      <textarea
        data-testid="eml-input"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={6}
        className="mt-2 w-full rounded-sm border border-line-strong bg-surface p-2 font-mono text-xs text-ink"
        placeholder="From: ...\nSubject: Invitation to Bid\n\nProject: ...\nBids due: ..."
      />
      <div className="mt-2 flex items-center gap-2">
        <button disabled={busy || !raw.trim()} onClick={upload} data-testid="eml-upload-btn">
          Ingest invitation
        </button>
        {msg && <span className="text-sm text-ink-muted">{msg}</span>}
      </div>
    </div>
  );
}
