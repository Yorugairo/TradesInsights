# Code Review: Registry-bridge data-connection (WS1–WS4/WS6 + Tumwater task #3)

**Reviewed**: 2026-07-19
**Author**: Claude (this session)
**Branch**: `claude/tmux-install-320aiz` (range `d528a67..HEAD`, 7 commits)
**Base**: no `release/trades-staging` trunk exists locally — reviewed the committed session range
**Mode**: Local review of committed changes (no GitHub PR; handoff is via `origin` branch)
**Decision**: ✅ **APPROVE with comments** — no CRITICAL/HIGH; 3 MEDIUM, 2 LOW

## Summary
Additive source-data promotion + a human-gated registry address-match rule. The governance-critical invariant (the new `binding_address_match` **never auto-binds**) is correctly enforced, no source fields are fabricated, and person-vs-business PII gating is present on every promoting path. Findings are maintainability/semantic, not safety. The one issue worth resolving **before enabling** the Tumwater source is a duplicate source identity in `config/sources.yaml`.

## Governance verification (the reason this review exists)
| Constraint | Verdict | Evidence |
|---|---|---|
| `binding_address_match` never auto-accepts | ✅ PASS | ruleKey `binding_address_match` carries `observationType: "binding_name_match"` (`registry-observations.ts:354`); auto-accept gate excludes that type (`:491`). Human accept binds via `name_review_confirmed` (`:612`). |
| Never fabricate unknowns (unknown = null) | ✅ PASS | Seattle `units` null when absent; Tumwater/Thurston `normalizedStage` stays `unknown` (outcome is in unfetched PDFs); Pierce/Tacoma emit **no** fake orgs. |
| Homeowner PII gated out | ⚠️ mostly | Address/phone promoted only behind `isBusinessName`/`isBusinessOrAgency`; names still emitted. See MEDIUM-2 (classifier breadth). |
| No auth/CAPTCHA bypass | ✅ PASS | `tumwater_planning_notices.fetch()` dead-letters against the Akamai gate by design; parser runs over the in-region genuine-visitor capture. |
| Address match can't produce false binds | ✅ PASS | `buildRegistryAddressIndex` drops non-unique keys to null (`:109`); `matchOrgByAddress` name-gated ≥0.3 (`:130`); weak matches fall below `MIN_QUEUE_TRUST` and never even queue. |

## Findings

### CRITICAL
None.

### HIGH
None.

### MEDIUM
**M1 — Duplicate Tumwater source identity in config (`config/sources.yaml`).**
The new adapter is keyed `tumwater_planning_notices` (`:266`), but a pre-existing stub `tumwater_sepa` (`:384`) already represents the **same real-world surface** — identical `landing_url` (`.../notice-of-applications-sepa-determinations`). Consequences:
- Two config entries for one source (new one P1, existing stub P0), plus the adapter key ≠ fixture dir (`fixtures/tumwater_sepa/`) ≠ config stub name.
- The substitute-coverage map (`wa_sepa.mitigates` → `tumwater_sepa`, per `docs/STATUS.md:17`) points at the **old** key, so once `tumwater_planning_notices` is enabled the `source_red` escalation won't recognize it as a covered dependency, and `tumwater_sepa` stays a phantom "mitigated" stub forever.
**Fix (pick one) before enabling:** rename adapter+config+fixture to `tumwater_sepa` (matches the stub, mitigation map, and fixture dir), *or* keep `tumwater_planning_notices`, delete the `tumwater_sepa` stub, and repoint `mitigates` + docs. One canonical key. Low risk today — the source is `enabled: false`.

**M2 — Business classifier can misgate an individual → promote a home address (`king-permit-reports.ts:48`, `wa-sepa.ts` `BUSINESS_OR_AGENCY_RE`, `thurston-active-notices.ts:77`).**
The keyword regexes include `\bCO\b` and `\bTRUST\b`. `TRUST` in particular is a common **homeownership** vehicle ("SMITH FAMILY TRUST"), whose mailing address is typically the residence — exactly the PII the person-vs-business gate exists to keep out. Likelihood is low (permit *owner* records, and the address is already in the public record's raw fields), but this is the precise failure mode the gate guards. **Fix:** drop/​tighten `CO` (`CO\.` only) and reconsider `TRUST`, or document the accepted residual risk in the adapter.

**M3 — Seattle land-use `normalizedStage: "approved"` is inferred from a decision *date*, not an outcome (`seattle-socrata.ts:80`).**
Land-use now keys `issued` off `decisiondate` (the real bug fix — correct). But `stageFor: issued ? "approved" : "entitlement"` marks any dated decision "approved", while sibling notice adapters deliberately stay `unknown` because approve-vs-deny isn't visible. If `decisiondate` is also populated on **denials**, those rows are mislabeled "approved". **Fix:** confirm `decisiondate` is approval-only; if not, cross-check `statuscurrent` (already retained in `statusRaw`) before asserting "approved". Plan-sanctioned and matches the building-permit pattern, so not blocking.

### LOW
**L1 — Misleading evidence factPath for acreage (`thurston-active-notices.ts:255`).** Acreage evidence is attached with `factPath: "squareFeet"` (text `"4.5 acres"`) while `record.squareFeet` stays null. Acres ≠ sq ft; an auditor reading evidence by factPath is pointed at the wrong (null) field. Use a neutral factPath (e.g. `description`) or omit.

**L2 — Staged-but-unparsed fixture (`fixtures/tumwater_development_review/drc-agendas.index.json`).** Committed golden capture for a source with no adapter yet. This is legitimate (step 4 of the 9-step activation checklist) and documented as pending in `docs/source-policy.md` / `docs/STATUS.md`; noted only so it isn't forgotten.

## Validation Results
| Check | Result | Notes |
|---|---|---|
| Type check | ✅ Pass | `@otn/resolution`, `@otn/adapters`, `@otn/worker` — all clean (`tsc --noEmit`) |
| Tests | ✅ Pass | `vitest run` adapters + resolution: **188/188** (23 files) |
| Worker DB-integration | ⏭️ Skipped | No DB in this environment; `RegistryIdentityRow` constructors updated so they compile (unchanged from report) |
| Lint | ⏭️ N/A | No package-level lint script; typecheck is the gate |
| Secrets / SQL injection | ✅ Pass | drizzle `sql` tagged-template parameterization throughout; no string-concatenated queries; no hardcoded secrets |

## Files Reviewed (in full)
- **WS1** `registry-observations.ts`, `identifiers.ts`, `registry-link.ts` (+ tests)
- **WS2** `wa-sepa.ts` (+ test) · **WS3** `king-permit-reports.ts`, `seattle-socrata.ts` (+ tests)
- **WS4** `pierce-permits-arcgis.ts`, `tacoma-permits-arcgis.ts` (+ tests) · **WS6** `thurston-active-notices.ts` (+ test)
- **Task #3** `tumwater-planning-notices.ts` (+ test), `index.ts`, `config/sources.yaml`, both new fixtures

## Recommendation
Merge is fine. All findings below were addressed the same day — see Resolution.

## Resolution (applied 2026-07-19)
- **M1 ✅** Adopted the existing `tumwater_sepa` identity: `TumwaterSepaAdapter` (key `tumwater_sepa`), file renamed `tumwater-planning-notices.{ts,test.ts}` → `tumwater-sepa.{ts,test.ts}`; the duplicate `tumwater_planning_notices` config entry removed and the pre-existing `tumwater_sepa` stub enriched. The `wa_sepa.mitigates` map and `fixtures/tumwater_sepa/` now agree with the live adapter key.
- **M2 ✅** Dropped bare `CO` and `TRUST` from the business classifiers in `king-permit-reports.ts`, `wa-sepa.ts`, `thurston-active-notices.ts`; added a PII-gate regression test (family trust → name only, no promoted address/phone).
- **M3 ✅** Seattle land-use flags a decision date paired with a withdrawn/denied `statuscurrent` as adverse → stage `withdrawn`/`unknown` (never `approved`), `issueDate` null; added a regression test. The one decided fixture row (`3044068-LU`, status "Published") correctly stays `approved`.
- **L1 ✅** Thurston acreage evidence retargeted `factPath: "squareFeet"` → `"description"`.
- **L2 ✅ tracked** Spawned a follow-up task to build the `tumwater_development_review` DRC-agendas adapter against the captured fixture (so it isn't left staged-but-unparsed).

Post-fix validation: `@otn/adapters` typecheck clean; adapters + config tests **145/145** (incl. 2 new regression tests). None of the fixes touched `@otn/resolution` (188/188 from the review sweep stands).
