# Implementation Report: CRM upgrade — takeoff scaffold + field communication

## Summary

Built the v1 of both systems deck appendix A5 promised as concepts, wired into the existing
pursuit CRM. **Takeoff**: an editable assembly worksheet derived deterministically from permit
evidence (the same text substrate the scorer reads), with provenance on every derived line,
`~` labelling on every figure, and a one-click stamp into `pursuits.estimated_contract_value`.
**Field**: multi-use hashed crew links (`/field/{token}`, no session — the link is the
credential) carrying daily logs and change orders back into the pursuit; COs queue for owner
approval in the cockpit, are decidable exactly once, and email the owner through an
idempotent `field_notify` deliveries row. The A6 loop closes on the worksheet: boards logged
in the field render as a variance line against the estimated hang/finish quantity.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | XL, two shippable phases | XL — Phase A shippable alone at its checkpoint, as designed |
| Confidence | 8/10 single-pass | Held: one pass + three small deviations, no rework |
| Files | ~24 | 21 (B7 photos not built; one extra service function) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| A1 | migration 0038 + drizzle defs | ✅ | 4 tables, additive, CHECKs inline; journal idx 38 |
| A2/A3 | `takeoff.ts` catalog/extraction/services | ✅ | + `getTakeoffSheet` read-only variant (deviation 3) |
| A4 | takeoff routes | ✅ | sheet id never taken from the request — resolved via owned pursuit |
| A5 | takeoff unit tests | ✅ | 11 tests |
| A6 | worksheet UI + pursuit-detail card | ✅ | card peeks (no create); the takeoff page IS the create act |
| A7 | e2e checkpoint | ✅ | derive→edit→stamp + isolation-404 |
| B1 | `field.ts` links/entries/decisions | ✅ | constant-shape verify failure; no oracle |
| B2 | `/field/{token}` + entries POST | ✅ | plain HTML forms, 303 back with `?ok=1`; api/action hardening |
| B3 | cockpit field section + routes | ✅ | raw URL rendered exactly once at mint |
| B4 | CO owner notification | ✅ | idempotency key `field-co:{entryId}`; send failure never fails the POST |
| B5 | field unit tests | ✅ | 10 tests |
| B6 | variance rollup + close-out | ✅ | boards×32 sqft vs estimated qty on the sheet |
| B7 | photos (OPTIONAL) | ⏭ not built | as scoped — storage decision (bucket vs bytea, EXIF-GPS policy) is owner-gated |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static analysis | ✅ | `pnpm typecheck` clean, all packages |
| Unit tests | ✅ | 21 new (11 takeoff + 10 field); full suite green |
| e2e | ✅ | 33/33 — 29 pre-existing untouched + 4 new in `field-takeoff.spec.ts` |
| Eval gates | ✅ | `pnpm eval:run` byte-identical — no scoring path touched |
| Build | ✅ | via `next` typecheck + e2e webServer boot |

## Files Changed

| File | Action |
|---|---|
| `packages/db/migrations/0038_takeoff_field.sql` + `meta/_journal.json` | CREATE / UPDATE |
| `packages/db/src/schema.ts` | UPDATE (+4 tables) |
| `packages/intelligence/src/takeoff.ts`, `field.ts`, `index.ts` | CREATE ×2 / UPDATE |
| `packages/delivery/src/field-notify.ts`, `index.ts` | CREATE / UPDATE |
| `apps/web/app/api/app/pursuits/[id]/takeoff/route.ts`, `takeoff/lines/route.ts` | CREATE |
| `apps/web/app/api/app/pursuits/[id]/field-links/route.ts`, `field-entries/[entryId]/decision/route.ts` | CREATE |
| `apps/web/app/api/field/[token]/entries/route.ts` | CREATE |
| `apps/web/app/field/[token]/page.tsx` | CREATE |
| `apps/web/app/app/pursuits/[id]/page.tsx` | UPDATE (takeoff card + field section, sequential reads) |
| `apps/web/app/app/pursuits/[id]/field-section.tsx` | CREATE |
| `apps/web/app/app/pursuits/[id]/takeoff/page.tsx`, `takeoff/sheet-editor.tsx` | CREATE |
| `apps/worker/test/takeoff.test.ts`, `field.test.ts` | CREATE |
| `apps/web/e2e/field-takeoff.spec.ts` | CREATE (existing specs untouched) |
| `apps/web/e2e/global-setup.ts` | UPDATE (wipe list: 4 new pursuit-child tables) |
| `docs/STATUS.md` | UPDATE |

## Deviations from Plan

See plan history v2: (1) e2e sandbox needed `db:setup:e2e` re-run + wipe-list additions;
(2) spec navigates by pathname because minted URLs deliberately carry `APP_BASE_URL`;
(3) added read-only `getTakeoffSheet` so viewing a pursuit never creates a sheet.

## Issues Encountered

The only real failure class was environmental: the new tables existing in `otn` (vitest DB,
migrated by `testDb()`) but not `otn_e2e` until `db:setup:e2e` re-ran. Everything else passed
first run after typecheck fixes (one import depth, one form-action return type).

## Follow-ups (not blocking)

- **Calibrate the numbers with Solis**: `TAKEOFF_ASSEMBLIES` default unit costs and
  `VALUATION_SHARE` (0.18 TI / 0.10 default) are owner-assumed placeholders, labelled as such
  in code and UI. Same discipline as `owner_assumed` in account-profiles.yaml: they leave
  placeholder status only when the customer speaks to them.
- **Deploy note**: set `APP_BASE_URL` on hosted so minted field links carry the public origin.
- **Hosted migrate**: apply 0038 to the hosted DB at the next deploy window (local + e2e
  applied; hosted apply follows the existing runbook step).
- **B7 photos**: decide storage (Supabase bucket) + EXIF-GPS policy with the owner, then it
  slots into `field_entries` (column-ready).

## Next Steps
- [x] Validation battery
- [ ] `/code-review` if desired
- [ ] Hosted migration apply at deploy
