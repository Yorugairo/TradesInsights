"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SourceActions({ sourceKey, enabled }: { sourceKey: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const res = await fetch(`/api/admin/sources/${sourceKey}/run`, { method: "POST" });
    const body = (await res.json().catch(() => null)) as { jobId?: string; error?: string } | null;
    setMsg(res.ok ? `queued ${body?.jobId?.slice(0, 8)}` : (body?.error ?? "failed"));
    setBusy(false);
  }

  async function toggle() {
    setBusy(true);
    await fetch(`/api/admin/sources/${sourceKey}/disable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !enabled }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <button disabled={busy} onClick={run}>
        Run
      </button>{" "}
      <button disabled={busy} onClick={toggle}>
        {enabled ? "Disable" : "Enable"}
      </button>
      {msg && <small className="text-ink-muted">{msg}</small>}
    </span>
  );
}
