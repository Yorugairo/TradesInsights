# Implementation Report: Connect captured-but-unused source data into the OTN Insights ↔ L&I registry bridge

## Summary
Executed the 6-workstream registry-bridge PRP. **5 of 6 workstreams shipped** (WS1–WS4 + WS6), each as its own committed + pushed commit on `claude/tmux-install-320aiz`. **WS5 (Centralia unit-count matrix) was deliberately deferred** — the data showed a naive extraction would fabricate dwelling counts, violating the governing "never guess" rule; it is handed off with full recovered geometry.

## Assessment vs Reality
| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | XL (6 workstreams) | XL — 5 implemented, 1 deferred |
| Confidence | 7/10 single-pass | Matched: WS1–WS4/WS6 clean; WS5 correctly identified as unsafe-to-rush |
| Files Changed | ~12 source + ~8 test | 12 source + 10 test across 5 commits |
| Tests | representative unit set | +34 unit tests; 199 green across touched packages |

## Tasks Completed
| WS | Task | Status | Commit | Notes |
|---|---|---|---|---|
| WS1 | Address matcher (`binding_address_match`) | ✅ Complete | `36e6964` | `addressMatchKey`, `loadOrganizationAddresses`, pure `buildRegistryAddressIndex`/`matchOrgByAddress`; registry `registered_address` read; never auto-binds |
| WS2 | wa_sepa applicant contact + site geo | ✅ Complete | `ef6f930` | `applicantcontactinfo` → business-gated address/phone; site parcels/geo; `leadagencyfilenumber` → externalRef |
| WS3 | King split + Seattle contractor/decisiondate | ✅ Complete | `f7cfcd1` | `splitNameAddress` (business-gated); `contractorcompanyname` org; land-use `decisiondate` bug fixed (config-keyed) |
| WS4 | Pierce/Tacoma cluster keys | ✅ Complete (deviated) | `23a3ba4` | See Deviations — promoted as project/record cluster keys, NOT party sourceEntityIds |
| WS5 | Centralia unit-count matrix | ⛔ **Deferred** | — | See Deviations — spawned follow-up task with geometry |
| WS6 | Thurston lots + dates + business org | ✅ Complete | `c5687fb` | `lotsFromText`, `noticeDateFields` (hearing→null), business-gated project org |

## Validation Results
| Level | Status | Notes |
|---|---|---|
| Static Analysis (typecheck) | ✅ Pass | `@otn/resolution`, `@otn/adapters`, `@otn/worker` all clean per workstream |
| Unit Tests | ✅ Pass | +34 new; full touched-package sweep **199/199** green (25 files) |
| Build | ✅ Pass | typecheck is the build gate for these packages |
| Integration | N/A | worker DB-integration tests not run here (no DB); RegistryIdentityRow constructors updated so they compile |
| Edge Cases | ✅ Pass | person-vs-business gating, address collisions dropped, malformed contact → name-only, PO-box distinct key, future-hearing → null date |

## Deviations from Plan
1. **WS4 — semantic correction (the plan's own gotcha, confirmed by data).** The plan tentatively wired Pierce `projectId` / Tacoma `globalid_1` into `organizations[].sourceEntityId` (a PARTY clustering key). The fixtures proved neither is a party key: Pierce `projectId` is **shared across permits** (451 rows → 333 ids) = a PROJECT cluster key, and Pierce has no party data at all (`organizations: []`); Tacoma `globalid_1` is **unique per record** (1000/1000) = a stable RECORD id (attaching it to the applicant would give every permit a distinct key and *break* name clustering). Both were promoted as `externalRef` evidence + namespaced rawFields (`pierce_pals_project:N`, `tacoma_accela:GUID`) for the M2 project/velocity layer, and **no fake org was fabricated** (honoring "NOT Building: no fake orgs").
2. **WS5 — deferred, not shipped.** The Centralia far-right grid is a full permit-TYPE matrix (Reroof/Plumbing/Mechanical/Demo/New-Commercial/… plus the dwelling columns), columns only 9–11pt apart. A blanket "sum the far-right digits → units" would count reroofs/demos as dwellings. Probing the New-SFR column surfaced an anomalous `3` mark and the plan's stated "Century Communities SFR" example was not cleanly locatable on the header-bearing page. Shipping a units extractor without per-category printed-total reconciliation would fabricate counts — a direct governance violation. Centralia `units` stays `null` (honest current behavior). Full recovered column map + blockers handed to a spawned follow-up task.

## Files Changed
| File | Action | WS |
|---|---|---|
| `packages/resolution/src/registry-link.ts` | UPDATE | WS1 |
| `packages/resolution/src/identifiers.ts` | UPDATE | WS1 |
| `packages/resolution/src/registry-observations.ts` | UPDATE | WS1 |
| `packages/resolution/src/{registry-link,identifiers,registry-observations}.test.ts` | UPDATE | WS1 |
| `apps/worker/test/{registry-link,registry-observations}.test.ts` | UPDATE | WS1 (row constructors) |
| `packages/adapters/src/wa-sepa.ts` (+test) | UPDATE | WS2 |
| `packages/adapters/src/king-permit-reports.ts` (+test) | UPDATE | WS3a |
| `packages/adapters/src/seattle-socrata.ts` + `seattle.test.ts` | UPDATE | WS3b/c |
| `packages/adapters/src/pierce-permits-arcgis.ts` (+test) | UPDATE | WS4 |
| `packages/adapters/src/tacoma-permits-arcgis.ts` (+test) | UPDATE | WS4 |
| `packages/adapters/src/thurston-active-notices.ts` (+test) | UPDATE | WS6 |

## Tests Written
| Area | New tests | Coverage |
|---|---|---|
| `identifiers.test.ts` | 5 | `addressMatchKey` (fold, zip-from-end, PO-box distinct, null) |
| `registry-observations.test.ts` | 4 | `buildRegistryAddressIndex`/`matchOrgByAddress` (match, collision-drop, foreign-name gate, no-zip skip) |
| `wa-sepa.test.ts` | 2 | golden geo/contact + business/person/garbled inline |
| `king-permit-reports.test.ts` | 2 | `splitNameAddress` unit + golden business/homeowner |
| `seattle.test.ts` | 3 | contractor org, land-use decisiondate stage, building regression |
| `pierce`/`tacoma` `.test.ts` | 2 | project cluster shared / record id unique + no party key |
| `thurston-active-notices.test.ts` | 5 | lots/acres/date fns + homeowner-null + inline business path |

## Next Steps
- [ ] WS5 follow-up (spawned task): Centralia units with per-category reconciliation.
- [ ] Shadow resolver run to observe `binding_address_match` candidates for known no-phone owners (WS1 manual-validation checkbox).
- [ ] `/code-review` on the branch before merge to `release/staging`.
