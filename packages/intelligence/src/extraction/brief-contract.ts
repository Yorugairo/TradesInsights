import { z } from "zod";

/**
 * Contract for the verified decision *brief* — the model-composed narrative
 * layer on top of the deterministic decision memo. The model NEVER introduces
 * information: it may only re-express items from a fixed menu of
 * already-verified facts, labeled inferences, and deterministic context, and
 * every sentence must cite the menu item(s) it draws from. This mirrors the
 * §13 extraction contract's "reject unknown evidence IDs" rule, applied to
 * prose: a sentence citing an unknown ref, or asserting a number/date that
 * does not appear verbatim in a cited menu item, rejects the whole draft — and
 * the surface falls back to the deterministic memo. Prose never becomes the
 * system of record; it is a rendering of verified rows.
 */

/** Bump when the brief prompt or contract semantics change. */
export const BRIEF_PROMPT_VERSION = "1.0.0";

export const briefSegmentSchema = z.object({
  text: z.string().min(1),
  // The model may send a kind, but the authoritative kind is DERIVED from the
  // refs it cites (see deriveKind): a sentence resting on an inference item is
  // labeled inference no matter what the model called it, so it cannot dress
  // an inference up as a confirmed fact.
  kind: z.enum(["fact", "inference", "context"]).optional(),
  refs: z.array(z.string().min(1)).min(1),
});

export const briefDraftSchema = z.object({
  segments: z.array(briefSegmentSchema).min(1),
});

/** A segment after validation, carrying its authoritative derived kind. */
export interface BriefSegment {
  text: string;
  kind: "fact" | "inference" | "context";
  refs: string[];
}
export interface BriefDraft {
  segments: BriefSegment[];
}

/** The authoritative kind of a segment, from the items it cites: anything
 * resting on an inference is an inference (hedged in prose); otherwise a
 * sentence resting only on fact items is a fact, and framing on context items
 * is context. */
export function deriveKind(cited: BriefMenuItem[]): "fact" | "inference" | "context" {
  if (cited.some((c) => c.kind === "inference")) return "inference";
  if (cited.length > 0 && cited.every((c) => c.kind === "fact")) return "fact";
  return "context";
}

/** A menu item the model is allowed to cite. `text` is the exact deterministic
 * string shown to the model — it is also the substantiation source: any number
 * or date the model writes must appear here. */
export interface BriefMenuItem {
  refId: string;
  kind: "fact" | "inference" | "context";
  text: string;
}

export interface BriefViolation {
  kind: "invalid_json" | "schema" | "unknown_ref" | "unsubstantiated_number";
  detail: string;
}

export type BriefValidation =
  | { ok: true; value: BriefDraft }
  | { ok: false; violations: BriefViolation[] };

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fence?.[1] ?? trimmed;
}

/** Currency, multi-digit numbers, and dates — the "hard tokens" a sentence
 * must not invent. Single digits (e.g. "a 4-bed home") are low fabrication
 * risk and ubiquitous in prose, so only numbers with two or more digits are
 * guarded, alongside any $-amount and any date-like token. */
const HARD_TOKEN_RE =
  /\$\s?[\d,]+(?:\.\d+)?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{2,}(?:,\d{3})*(?:\.\d+)?\b/g;

/** Strip $, commas, and whitespace so "$2,584,093" and "2584093" compare
 * equal — the model is told to copy verbatim, but light normalization keeps a
 * kept-verbatim number from tripping on formatting punctuation. */
function normalizeToken(t: string): string {
  return t.replace(/[$,\s]/g, "").toLowerCase();
}

/**
 * Validate a raw brief draft against a menu. Rejects (whole draft) when: JSON
 * is malformed; the shape is wrong; any segment cites a ref outside the menu;
 * or a segment asserts a hard number/date not present in the items it cites.
 * On success, returns segments with their authoritative DERIVED kind (a
 * sentence resting on any inference item is labeled inference — the model
 * cannot dress an inference up as a fact). A rejected draft is never shown —
 * the caller renders the deterministic memo instead.
 */
export function validateBrief(rawText: string, menu: BriefMenuItem[]): BriefValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(rawText));
  } catch (err) {
    return {
      ok: false,
      violations: [{ kind: "invalid_json", detail: err instanceof Error ? err.message : String(err) }],
    };
  }

  const result = briefDraftSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      violations: result.error.issues.map((i) => ({
        kind: "schema" as const,
        detail: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }

  const byRef = new Map(menu.map((m) => [m.refId, m]));
  const violations: BriefViolation[] = [];
  const segments: BriefSegment[] = [];

  for (const [s, seg] of result.data.segments.entries()) {
    const cited: BriefMenuItem[] = [];
    for (const ref of seg.refs) {
      const item = byRef.get(ref);
      if (!item) {
        violations.push({ kind: "unknown_ref", detail: `segment ${s} cites unknown ref ${ref}` });
        continue;
      }
      cited.push(item);
    }
    if (cited.length === 0) continue; // already flagged unknown refs

    const haystack = cited.map((c) => c.text).join(" ");
    const normHaystack = normalizeToken(haystack);
    for (const token of seg.text.match(HARD_TOKEN_RE) ?? []) {
      const raw = token.trim();
      const norm = normalizeToken(raw);
      if (!haystack.includes(raw) && !normHaystack.includes(norm)) {
        violations.push({
          kind: "unsubstantiated_number",
          detail: `segment ${s} asserts "${raw}" which no cited item states`,
        });
      }
    }
    segments.push({ text: seg.text, kind: deriveKind(cited), refs: seg.refs });
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: { segments } };
}
