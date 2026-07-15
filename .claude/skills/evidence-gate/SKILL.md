---
name: evidence-gate
description: Evidence rules, the AI extraction contract, and the opportunity publication gate. Use when working in packages/intelligence or packages/delivery, writing model prompts/validators, scoring or routing opportunities, building the verifier, or deciding whether anything may appear in a digest or alert.
---

# Evidence and publication gate

Full rules: `docs/BUILD_SPEC.md` §11–§15 and §18. Governing rule: **no claim without a source**. AI interprets captured evidence; it is never the system of record.

## Authority grades

- **A** — official government record, official solicitation, or authorized original invitation.
- **B** — official company/project/architect/GC page.
- **C** — credible secondary corroboration; **never sufficient alone**.
- **D** — unverified aggregation; discovery only, **never customer-publishable**.

Every delivered fact requires: an evidence row + original source URL, source/record ID where available, retrieved time, page/section/row or evidence span, and `confirmed = true`.

Always label as **inference** (never fact): likely trade fit, likely procurement window, unconfirmed organization role, plausible scope inferred from description.

The verifier rejects unsupported: exact scope, bid state, organization role, value, unit/lot count, deadline, or contact. Never show cached contractor registration status without `verified_at`.

## AI contract (spec §13)

Deterministic parsing and filtering first. Models only for ambiguous extraction, classification, evidence mapping, brief drafting, and independent verification. Required output shape (Zod-validated):

```json
{
  "facts": [{ "path": "project.units", "value": 78, "evidenceId": "uuid", "confirmed": true, "confidence": 0.99 }],
  "inferences": [{ "type": "trade_fit", "value": "...", "evidenceIds": ["uuid"], "confidence": 0.72, "reason": "..." }],
  "missingCriticalFacts": ["general_contractor", "procurement_status"]
}
```

- Reject unknown evidence IDs.
- Store provider, model, prompt version, token use, cost, latency, result hash.
- Enforce per-job and monthly spend limits (`LLM_MONTHLY_BUDGET_USD`).
- The app boots without model keys; model-dependent jobs show a blocked/skipped state.
- Final scores are deterministic calculations over stored components — model prose never sets a score.

## Publication gate (all must hold before a digest/alert)

1. Source is healthy (not red; red-only support suppresses delivery).
2. Project identity, geography, stage, and event date exist.
3. At least one **A-grade** source supports the core event.
4. Every fact has evidence; inferences separately labeled.
5. No unresolved identity contradiction.
6. Record is active/current for the relevant trade timing.
7. Account score clears threshold (80–100 priority; 65–79 weekly digest; <65 archive).
8. Independent verifier passes.

Pilot: human review required for deadlines, high-value projects, ambiguous routing, contact data, and any externally actionable claim.

## Digest rules (spec §18)

Weekly sections: priority new opportunities; material stage changes; missing-fact verification queue; monitoring items; coverage/source-health caveat. Each item: project/stage, what changed, why it fits, confirmed facts, inference/caveat, next action, source links. Delivery is **idempotent** (store rendered content, recipient, status, rules/models used, item IDs, idempotency key). Never label an unchanged repeated project as new.

Quality gates: unsupported facts **0**; duplicates <3%; expired <2%; working source links ≥98%; priority precision ≥90% before automation.
