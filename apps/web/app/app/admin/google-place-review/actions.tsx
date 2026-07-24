"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Google Place review — the decide control.
 *
 * A decision does NOT flip the registry queue row here: it records an intent in
 * the partner hand-off table, and the registry's applier performs the guarded
 * update on its own schedule. The success copy says "queued" for exactly that
 * reason — claiming an instant write would be a lie the operator would catch the
 * next time the row still appeared.
 */
export type PlaceResolution = "accepted" | "rejected" | "needs_evidence";

const LABEL: Record<PlaceResolution, string> = {
  accepted: "This is them",
  rejected: "Not them",
  needs_evidence: "Can't tell",
};

const TITLE: Record<PlaceResolution, string> = {
  accepted: "The Google Place belongs to this L&I contractor",
  rejected: "The Google Place is a different business",
  needs_evidence: "Undecidable from what is shown — send back for evidence gathering",
};

type State = "idle" | "posting" | { done: PlaceResolution; already: boolean } | { error: string };

export function DecideButtons({ reviewId }: { reviewId: number }) {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");

  const decide = useCallback(
    async (resolution: PlaceResolution) => {
      setState("posting");
      const res = await fetch(`/api/admin/google-place-review/${reviewId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution }),
      });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; alreadyDecided?: boolean }
        | null;
      if (res.ok) {
        setState({ done: resolution, already: body?.alreadyDecided === true });
        router.refresh();
      } else {
        setState({ error: body?.error ?? `failed (${res.status})` });
      }
    },
    [reviewId, router],
  );

  if (typeof state === "object" && "done" in state) {
    return (
      <small style={{ color: "#137333" }}>
        ✓ {LABEL[state.done]} — {state.already ? "already recorded" : "queued for the registry"}
      </small>
    );
  }

  return (
    <span style={{ whiteSpace: "nowrap" }}>
      {(["accepted", "rejected", "needs_evidence"] as PlaceResolution[]).map((r) => (
        <button
          key={r}
          disabled={state === "posting"}
          onClick={() => void decide(r)}
          title={TITLE[r]}
          style={{ fontSize: "0.8rem", marginRight: "0.25rem" }}
          data-testid={`place-${r}`}
        >
          {LABEL[r]}
        </button>
      ))}
      {typeof state === "object" && "error" in state && (
        <small style={{ color: "crimson", marginLeft: "0.3rem" }}>{state.error}</small>
      )}
    </span>
  );
}
