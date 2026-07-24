/**
 * Google Place review — the decision vocabulary, shared by the batch table and
 * the API route.
 *
 * A decision does NOT flip the registry queue row: it records an intent in the
 * partner hand-off table, and the registry's applier performs the guarded update
 * on its own schedule. Every label here says "queued" downstream for exactly
 * that reason — claiming an instant write would be a lie the operator would
 * catch the next time the row still appeared.
 *
 * No "use client" directive: these are plain constants, so either a server or a
 * client component may import them.
 */
export type PlaceResolution = "accepted" | "rejected" | "needs_evidence";

export const LABEL: Record<PlaceResolution, string> = {
  accepted: "This is them",
  rejected: "Not them",
  needs_evidence: "Can't tell",
};

export const TITLE: Record<PlaceResolution, string> = {
  accepted: "The Google Place belongs to this L&I contractor",
  rejected: "The Google Place is a different business",
  needs_evidence: "Undecidable from what is shown — send back for evidence gathering",
};
