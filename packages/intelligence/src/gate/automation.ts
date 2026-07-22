import type { ModelExtraction } from "../extraction/contract.js";
import type { VerifierResult } from "./verifier-contract.js";
import type { GateResult } from "./gate.js";

/**
 * M4.3/M4.4 — controlled automation policy. An item may be auto-included in
 * a customer digest ONLY when the full §15 gate passes, the independent
 * verifier supported every fact, every fact is high-confidence, nothing
 * critical is missing, and the item is not in a high-risk category. High-risk
 * items (spec §15 pilot list: deadlines, high-value, ambiguous routing,
 * contact data, externally actionable claims) ALWAYS require a human — the
 * only override is an explicit human decision already recorded on the
 * opportunity (state = promoted).
 */

export const AUTOMATION_POLICY_VERSION = "1.1.0";

/** Facts below this confidence are not "high confidence" (spec §21 M4.3). */
export const AUTO_INCLUDE_CONFIDENCE_MIN = 0.9;
/** Valuation at/above this is a high-value project → human review (M4.4). */
export const HIGH_VALUE_REVIEW_USD = 5_000_000;

const CONTACT_FACT = /contact|phone|email|estimator/i;
const DEADLINE_FACT = /bid_date|deadline|due_date|proposal/i;
const ACTIONABLE_TEXT = /\b(bids? due|proposals? due|invitation to bid|request for (proposals?|qualifications?)|pre-?bid)\b/i;

export interface InclusionInput {
  gate: GateResult;
  extraction: ModelExtraction | null;
  verification: { status: string; result: VerifierResult | null } | null;
  route: string | null;
  /** Opportunity state — "promoted" is a recorded human decision. */
  state: string;
  maxValuation: number | null;
  stage: string;
  text: string;
  /** Phase 1 flywheel — the project's public sources state the same numeric
   * fact MATERIALLY differently (corroboration pass). The digest never picks
   * a winner between conflicting stated facts, so a human decides. */
  hasFactContradiction?: boolean;
}

export interface InclusionDecision {
  mode: "auto" | "review_required";
  /** Why the item was withheld from automation (empty when auto). */
  reasons: string[];
  policyVersion: string;
}

/** Spec §15 pilot high-risk categories — deterministic, always human (M4.4). */
export function highRiskReasons(input: InclusionInput): string[] {
  const reasons: string[] = [];
  const facts = input.extraction?.facts ?? [];
  if (facts.some((f) => DEADLINE_FACT.test(f.path)) || ACTIONABLE_TEXT.test(input.text)) {
    reasons.push("deadline_or_actionable_claim");
  }
  if ((input.maxValuation ?? 0) >= HIGH_VALUE_REVIEW_USD) reasons.push("high_value_project");
  if (input.route === "joint_review" || input.route === "gc_relationship_radar") {
    reasons.push("ambiguous_routing");
  }
  if (facts.some((f) => CONTACT_FACT.test(f.path))) reasons.push("contact_data");
  if (input.stage === "bidding_confirmed") reasons.push("externally_actionable_bid_state");
  return reasons;
}

export function decideInclusion(input: InclusionInput): InclusionDecision {
  const reasons: string[] = [];

  if (input.gate.status !== "pass") {
    // Callers should have filtered already; belt and braces.
    return {
      mode: "review_required",
      reasons: [`gate_${input.gate.status}`],
      policyVersion: AUTOMATION_POLICY_VERSION,
    };
  }

  const highRisk = highRiskReasons(input);
  // High-risk categories always require a human (M4.4) — a recorded human
  // decision (promoted) satisfies that requirement.
  if (highRisk.length > 0 && input.state !== "promoted") reasons.push(...highRisk);

  if (input.state !== "promoted") {
    // M4.3: independently verified, high-confidence, nothing critical missing.
    if (!input.extraction) {
      reasons.push("no_model_extraction");
    } else {
      if (input.extraction.facts.some((f) => f.confidence < AUTO_INCLUDE_CONFIDENCE_MIN)) {
        reasons.push("low_confidence_fact");
      }
      if (input.extraction.missingCriticalFacts.length > 0) {
        reasons.push("missing_critical_facts");
      }
    }
    if (
      !input.verification ||
      input.verification.status !== "succeeded" ||
      !input.verification.result ||
      input.verification.result.verdicts.some((v) => !v.supported)
    ) {
      reasons.push("not_independently_verified");
    }
    // Conflicting stated facts (v1.1.0): auto-inclusion would require silently
    // preferring one source's number over another's — that is a human call.
    if (input.hasFactContradiction) reasons.push("fact_contradiction");
  }

  return {
    mode: reasons.length === 0 ? "auto" : "review_required",
    reasons,
    policyVersion: AUTOMATION_POLICY_VERSION,
  };
}
