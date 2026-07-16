"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const STATES = [
  "unknown", "research_needed", "target", "contacted",
  "active_relationship", "preferred", "incumbent_blocked", "do_not_pursue",
];

export function RelationshipActions({
  organizationId,
  current,
}: {
  organizationId: string;
  current: { relationshipState: string; preferred: boolean; blocked: boolean } | null;
}) {
  const router = useRouter();
  const [state, setState] = useState(current?.relationshipState ?? "unknown");
  const [preferred, setPreferred] = useState(current?.preferred ?? false);
  const [blocked, setBlocked] = useState(current?.blocked ?? false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    await fetch(`/api/app/organizations/${organizationId}/relationship`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relationshipState: state, preferred, blocked }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
      <select data-testid="rel-state" value={state} onChange={(e) => setState(e.target.value)}>
        {STATES.map((s) => (
          <option key={s} value={s}>
            {s.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <label>
        <input type="checkbox" checked={preferred} onChange={(e) => setPreferred(e.target.checked)} /> preferred
      </label>
      <label>
        <input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} /> blocked
      </label>
      <button disabled={busy} onClick={save} data-testid="rel-save">
        Save relationship
      </button>
    </div>
  );
}
