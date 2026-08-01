# Trades Insights Mobile — Drywall Skin

## Problem

Drywall and interiors subcontractors run their business from a truck and a job
site, but every tool OTN Insights has built for them assumes a desk. The takeoff
estimator, the pursuit pipeline, the GC relationship history and the weekly
digest all exist and all require a laptop and a connection. Meanwhile the work
that generates the data — measuring a space, logging a day's production, catching
a change order before it becomes a dispute — happens in a building core with no
signal. The cost of leaving this unsolved is that the intelligence product stays
a reporting tool for the owner rather than an operating system for the crew, and
the field data that would make the estimates accurate is never captured.

## Evidence

- **Concrete (design decisions already taken under this constraint):** the field
  surface was built with multi-use tokens and no login precisely because crews
  cannot be expected to hold accounts — the constraint was understood and
  designed around before this PRD.
- **Concrete:** `TAKEOFF_ASSEMBLIES` ships ten interiors-specific assemblies
  (hang & finish Level 4, Level-5 skim, metal stud framing, ACT grid, batt
  insulation, fire-rated/shaftwall, paint walls/ceilings, doors & frames, scope
  allowance) — the estimator was authored against a real drywall scope, not a
  generic one.
- **Concrete:** unit costs in that model are owner-assumed placeholders that have
  never been calibrated against actual job costs.
- **Assumption — needs validation via design-partner interview:** that the
  owner-estimator wants these seven surfaces in one place rather than two or
  three tools they already tolerate.
- **Assumption — needs validation via field observation:** the frequency and
  duration of no-signal conditions on real drywall sites, which determines how
  aggressive the offline requirement must be.

## Users

- **Primary — the owner-estimator.** Runs a specialty interiors sub (design
  partner: Solis Interiors). Bids work, maintains GC relationships, decides what
  to chase. Triggered by: a bid invitation, a GC call, a weekly planning pass.
  Currently served by the desktop cockpit and the emailed digest.
- **Secondary — the field lead.** Runs a crew on one or more active jobs. Logs
  production, raises change orders, needs today's scope and yesterday's numbers.
  Has no account and should never need one. Triggered by: start of shift, end of
  shift, an unexpected condition on site.
- **Not for (v1):** general contractors, owners/developers, homeowners, and
  trades outside drywall/interiors. Each would change the vocabulary, the
  assemblies, and the trust model.

## Hypothesis

We believe **a mobile app that works offline and unifies estimating, field
capture, jobs and relationships** will **move OTN Insights from a reporting tool
into the daily operating surface of a drywall sub** for **owner-estimators and
their field leads**.

We'll know we're right when **the design partner logs production from the field
on the majority of active job-days without prompting, and at least one estimate
is produced from field-captured measurements rather than permit evidence alone.**

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| Field-day capture rate | ≥60% of active job-days have a daily log within 14 days of rollout | `field_entries` per job-day vs. scheduled job-days |
| Offline resilience | 100% of entries created offline reach the server after reconnect; zero silent losses | Outbox reconciliation audit |
| Estimate provenance | ≥1 estimate stamped from field-measured input in the first month | `takeoff_sheets` source discriminator |
| Cost-book calibration | Unit costs edited by the owner at least once | Cost-book revision count |
| Time to log a day | TBD — needs a desktop baseline first | In-app instrumentation |

Targets beyond the first two are **provisional** — there is no comparable
feature in this product to benchmark against, and setting confident numbers
before the design-partner interview would be invention.

## Scope

**MVP — the minimum that tests the hypothesis:** an installable mobile shell
with the digest as its home, plus offline-first field capture (daily logs,
quantities, photos, change orders) for the field lead. This is the smallest slice
that puts the app in a crew's hands on a real site and proves the offline
architecture, which every later phase depends on.

**Out of scope**

- **Native app-store builds** — a web-installable app reaches both platforms
  without store review; revisit only if background sync or camera limits prove
  blocking.
- **Any trade other than drywall/interiors** — assemblies and vocabulary are the
  product, not a theme; a second trade is a second calibration exercise.
- **GC-facing or homeowner-facing surfaces** — different trust model entirely.
- **Invoicing, payroll, and accounting integration** — adjacent business, and each
  is a compliance surface of its own.
- **Publishing the corporate-family graph anywhere** — proprietary, and the
  subject of a standing policy.

## Delivery Milestones

<!-- Business outcomes, not engineering tasks. /plan turns each into a plan. -->
<!-- Status: pending | in-progress | complete -->

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 0 | Decisions + offline spike | A written decision record, and proof on a real phone in a real no-signal building that capture → reconnect → sync works | **partial** — decisions + code + e2e done; **real-device protocol still outstanding** | `.claude/PRPs/plans/completed/mobile-shell-and-offline-spike.plan.md` |
| 1 | Mobile shell + digest home | The owner can install the app and read their week on a phone | complete | `.claude/PRPs/plans/completed/mobile-shell-and-offline-spike.plan.md` |
| 2 | Field crew app (offline-first) | A crew logs a day's production from a job site with no signal | pending | — |
| 3 | Jobs + schedule | Won pursuits and manually created jobs both appear on a schedule with crew and dates | pending | — |
| 4 | Field estimator | An on-site measurement produces a rough-order-of-magnitude number from an editable cost book | pending | — |
| 5 | Relationships + pursuit on mobile | A GC conversation is logged from a truck and changes relationship state | pending | — |

## Open Questions

- [ ] **Blocking (design partner):** how often are crews genuinely without signal,
      and for how long? Determines whether "offline" means a queue or a full
      local replica.
- [ ] **Blocking (owner):** does a job always correspond to one physical site, or
      can one job span buildings/phases? Determines the job↔schedule cardinality.
- [ ] **Blocking (owner):** who may edit unit costs — owner only, or estimators
      too? Cost changes move quoted numbers.
- [ ] **Non-blocking (design):** does the field lead see money at all, or only
      quantities? Current field surface is deliberately quantity-only.
- [ ] **Non-blocking (owner):** should manually created jobs be able to become
      pursuits retroactively, or is the flow strictly one-way?
- [ ] **Non-blocking (data):** how many historical jobs exist with known actual
      costs, to calibrate the cost book against?

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Offline treated as a later concern | High if not milestone 0 | Rewrite of the client | Spike before any UI is built |
| **The ingestion pipeline is idle** — the scheduled fleet dies on a missing secret, so opportunity/digest surfaces have nothing to show | Certain today | App demos empty | Owner sets the GitHub Actions secrets before milestone 1; note that field capture and the estimator work regardless, since they run on customer-entered data |
| Uncalibrated unit costs reach a customer-facing number | Med | Commercial — a bad quote | ROM framing plus an in-app editable cost book; calibration before milestone 4 |
| Job entity overloaded onto pursuit | Resolved | — | Decided: a distinct job entity, creatable from a won pursuit **or manually** |
| Two estimators diverge into two prices | Med | Trust | One estimate model, two input modes |
| Seven surfaces attempted at once | High | Nothing ships | Milestones are independently shippable |
| iOS web-app limits (background sync, push) | Known | Med | Established in the milestone-0 spike, not assumed |

---
*Status: DRAFT — requirements only. Implementation planning pending via /plan.*
