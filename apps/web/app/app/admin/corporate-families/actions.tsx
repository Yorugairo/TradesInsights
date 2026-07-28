"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { CorroborationVerdict } from "@otn/resolution";

/**
 * Corporate-family / principal↔person accept — the one interactive control on an
 * otherwise read-only queue. Confirming a pair records ONE entity↔entity
 * `principal_shared` relationship for the nightly registry export; it never binds
 * identity. One click, one claim — there is deliberately no bulk path, because
 * every claim leans on a private individual's name.
 *
 * The corroboration shape is restated locally: a VALUE import from
 * `@otn/resolution` in a "use client" module pulls the server graph (`pg`) into
 * the browser bundle and breaks the build. Only the type is imported.
 */
export interface RelationshipCorroboration {
  points: number;
  verdict: CorroborationVerdict;
  signals: { key: string; label: string; agrees: boolean }[];
  explanation: string;
}

export interface RelationshipClaim {
  /** PROVENANCE anchor; null ⇒ no Insights org bound to either company (disabled). */
  organizationId: string | null;
  registryEntityIdA: string;
  registryEntityIdB: string;
  principalKey: string | null;
  corroboration: RelationshipCorroboration;
  /** Human labels for the confirm() dialog. */
  labelA: string;
  labelB: string;
}

type State = "idle" | "posting" | "confirmed" | { error: string };

async function postRelationship(claim: RelationshipClaim): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch("/api/admin/corporate-families/relationship", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: claim.organizationId,
      registryEntityIdA: claim.registryEntityIdA,
      registryEntityIdB: claim.registryEntityIdB,
      principalKey: claim.principalKey,
      corroboration: claim.corroboration,
    }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: body?.error ?? `failed (${res.status})` };
}

export function ConfirmRelationshipButton({ claim }: { claim: RelationshipClaim }) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");

  const onClick = useCallback(async () => {
    if (!claim.organizationId) return;
    const ok = window.confirm(
      `Confirm that "${claim.labelA}" and "${claim.labelB}" share common control?\n` +
        "This queues an entity↔entity relationship for the nightly registry export. It does not bind identity.",
    );
    if (!ok) return;
    setState("posting");
    const r = await postRelationship(claim);
    if (r.ok) {
      setState("confirmed");
      router.refresh();
    } else {
      setState({ error: r.error });
    }
  }, [claim, router]);

  // No Insights org bound to either company — nothing to anchor the observation
  // on, so the claim cannot be recorded. Disabled with the reason, never hidden.
  if (claim.organizationId === null) {
    return (
      <button disabled title="no Insights organization bound to either company yet" style={DISABLED_STYLE}>
        confirm link
      </button>
    );
  }

  if (state === "confirmed") {
    return <small className="font-semibold text-ok">✓ confirmed — queued for registry export</small>;
  }

  // `name_only` = only the surname/given name links them; enabled but de-emphasized
  // so a reviewer confirms it only with outside knowledge. `contradicted` never
  // reaches here — the parent renders no button for it.
  const deEmphasized = claim.corroboration.verdict === "name_only";
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <button
        disabled={state === "posting"}
        onClick={() => void onClick()}
        title={deEmphasized ? "only the name links these — confirm only with outside knowledge" : "confirm shared control"}
        className={`rounded-sm border border-line-strong bg-surface px-2 py-0.5 text-xs font-semibold text-ink disabled:opacity-50 ${deEmphasized ? "opacity-70" : ""}`}
      >
        {state === "posting" ? "…" : "confirm link"}
      </button>
      {typeof state === "object" && <small className="font-semibold text-bad">{state.error}</small>}
    </span>
  );
}

const DISABLED_STYLE = { opacity: 0.5, cursor: "not-allowed", fontSize: "0.8rem" } as const;
