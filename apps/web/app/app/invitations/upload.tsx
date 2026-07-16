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
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", margin: "1rem 0" }}>
      <h3 style={{ marginTop: 0 }}>Upload a bid-invitation email (.eml)</h3>
      <p style={{ color: "#666", fontSize: "0.85rem" }}>
        Paste a customer-authorized invitation email. Parsed deterministically; nothing is scraped.
        Re-uploading the same email is idempotent.
      </p>
      <textarea
        data-testid="eml-input"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={6}
        style={{ width: "100%", fontFamily: "monospace" }}
        placeholder="From: ...\nSubject: Invitation to Bid\n\nProject: ...\nBids due: ..."
      />
      <div style={{ marginTop: "0.5rem" }}>
        <button disabled={busy || !raw.trim()} onClick={upload} data-testid="eml-upload-btn">
          Ingest invitation
        </button>
        {msg && <span style={{ marginLeft: "0.5rem" }}>{msg}</span>}
      </div>
    </div>
  );
}
