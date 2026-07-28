// Proof primitive, Insights-specific: how strongly is this claim corroborated?
//
// Reads the Phase-1 corroboration jsonb (lib/queries.ts:223) — distinct source
// count, lifecycle stage depth, and recorded contradictions — and renders it as
// a segmented meter.
//
// THE RULE THIS COMPONENT EXISTS TO ENFORCE. `null` corroboration means the
// question has never been asked. It does NOT mean "zero sources". A meter that
// renders both as an empty bar tells the operator something false, and it is the
// exact mistake the fleet work hit twice: an orphaned run's missing counter read
// as a measured zero and the whole fleet looked healthy. Unknown therefore gets
// its own visual state — dashed, labelled, impossible to mistake for a low score.
//
// Never feed this fabricated values.

/**
 * Shape of `project.corroboration`, fixed by the writer at
 * `packages/resolution/src/corroboration.ts:96-100`.
 *
 * `sourceCount` is a count, not a list. This type first mirrored an incorrect
 * declaration in `lib/queries.ts` that named a `sources: string[]` field nothing
 * has ever written — with the effect that this component reported "Not assessed"
 * for every project that HAD been assessed. Measured against production: 500 of
 * 500 rows carried a real corroboration record and 0 rendered as measured. The
 * component built to stop unknown reading as zero was making measured read as
 * unknown, which is the same lie pointing the other way.
 */
export type CorroborationInput =
  | {
      sourceCount?: number;
      stageDepth?: number;
      contradictions?: { field: string; values: unknown[]; recordIds: string[] }[];
      derivedAt?: string;
    }
  | null
  | undefined;

export type ConfidenceState =
  | { kind: "unknown" }
  | {
      kind: "measured";
      sourceCount: number;
      stageDepth: number | null;
      contradictionCount: number;
      level: "none" | "single" | "corroborated" | "strong";
    };

/**
 * Three segments, because the meaningful jumps are 1 → 2 → 3+: one source is a
 * claim, two independent sources is corroboration, three is a pattern. A
 * finer-grained scale would imply a precision the underlying count does not have.
 */
export const CONFIDENCE_SEGMENTS = 3;

export function confidenceState(input: CorroborationInput): ConfidenceState {
  if (!input) return { kind: "unknown" };
  // The jsonb exists but carries no count: the corroboration pass has not written
  // this dimension. Still unknown — an absent key is not a measured zero.
  if (typeof input.sourceCount !== "number") return { kind: "unknown" };

  const sourceCount = input.sourceCount;
  return {
    kind: "measured",
    sourceCount,
    stageDepth: typeof input.stageDepth === "number" ? input.stageDepth : null,
    contradictionCount: input.contradictions?.length ?? 0,
    level:
      sourceCount >= 3
        ? "strong"
        : sourceCount === 2
          ? "corroborated"
          : sourceCount === 1
            ? "single"
            : "none",
  };
}

const LEVEL_LABELS: Record<string, string> = {
  none: "No sources recorded",
  single: "Single source",
  corroborated: "Corroborated",
  strong: "Strongly corroborated",
};

export default function ConfidenceMeter({
  corroboration,
  compact = false,
}: {
  corroboration: CorroborationInput;
  compact?: boolean;
}) {
  const state = confidenceState(corroboration);

  if (state.kind === "unknown") {
    return (
      <div className="flex flex-col gap-1" data-confidence="unknown">
        <div
          className="flex gap-1"
          role="img"
          aria-label="Corroboration not assessed — no corroboration record exists for this opportunity"
        >
          {Array.from({ length: CONFIDENCE_SEGMENTS }, (_, i) => (
            // Dashed, not empty. An empty solid segment is how "we did not
            // measure" gets misread as "we measured, and it was low".
            <span
              key={i}
              className="h-1.5 w-8 rounded-full border border-dashed border-line-strong"
            />
          ))}
        </div>
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-subtle">
          Not assessed
        </span>
        {!compact && (
          <span className="text-xs text-ink-subtle">
            No corroboration record — this is unknown, not zero.
          </span>
        )}
      </div>
    );
  }

  const filled = Math.min(state.sourceCount, CONFIDENCE_SEGMENTS);

  return (
    <div className="flex flex-col gap-1" data-confidence={state.level}>
      <div
        className="flex gap-1"
        role="img"
        aria-label={`Seen in ${state.sourceCount} independent ${
          state.sourceCount === 1 ? "source" : "sources"
        }`}
      >
        {Array.from({ length: CONFIDENCE_SEGMENTS }, (_, i) => (
          <span
            key={i}
            className={[
              "h-1.5 w-8 rounded-full border",
              i < filled ? "border-accent bg-accent" : "border-line-strong bg-track",
            ].join(" ")}
          />
        ))}
      </div>
      <span className="text-2xs uppercase tracking-[0.08em] text-ink-muted">
        {LEVEL_LABELS[state.level]}
      </span>
      {!compact && (
        <span className="text-xs text-ink-muted">
          {state.sourceCount} independent {state.sourceCount === 1 ? "source" : "sources"}
          {state.stageDepth !== null && state.stageDepth > 0
            ? ` · ${state.stageDepth} lifecycle ${state.stageDepth === 1 ? "stage" : "stages"}`
            : ""}
        </span>
      )}
      {state.contradictionCount > 0 && (
        // Contradictions are shown, never resolved for the operator — the same
        // discipline the corroboration panel already applies to the values.
        <span className="text-xs font-semibold text-bad">
          {state.contradictionCount} conflicting{" "}
          {state.contradictionCount === 1 ? "statement" : "statements"} on record
        </span>
      )}
    </div>
  );
}
