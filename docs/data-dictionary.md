# Data dictionary

> Maintained as a deliverable: update this file with every schema migration. Authoritative DDL: `packages/db/migrations/`; Drizzle definitions: `packages/db/src/schema.ts`. Last updated: migration `0000_init` (M0, 2026-07-15).

Conventions: UUID primary keys (`gen_random_uuid()`); official identifiers are namespaced *external* IDs, never primary keys; timestamps are `timestamptz`; unknown values are `NULL`, never guessed or zero (spec §8).

## Ingestion

**sources** — one row per configured source (seeded from `config/sources.yaml`).
Key columns: `key` (unique), `authority`, `priority` (P0/P1/lookup/context/test), `landing_url`, `access_url`, `format`, `access_class`, `cadence`, `county`, `permitting_jurisdiction`, `enabled`, `terms_reviewed_at`, `robots_reviewed_at`. Config-only `mitigates: string[]` (D4 — keys this source provides substitute coverage for, e.g. `wa_sepa` → Pierce/Tumwater environmental determinations) is read from config by the alerts CLI, not stored in the table.

**source_runs** — one row per run. `status`: running | succeeded | completed_with_errors | failed. Metrics counters (`discovered/fetched/unchanged/parsed/rejected/duplicate/error_count`), `checkpoint_json` (pagination/high-water mark), `schema_fingerprint` (hash of raw field names — drift detection), `metrics_json` (dead-letter entries: idempotency key, URL, stage, error; plus D1 `invariantViolations` count + `invariantViolationDetails[]` — each `{check, detail, observed, expected, canonicalUrl}` from an adapter's `checkInvariants` self-reconciliation; a non-zero count turns the source red in `evaluateSourceHealth`; plus D2 `fieldFill` — `{field: fill_rate}` over `MONITORED_FILL_FIELDS` for the records this run parsed, compared against the source's previous parsed run so a required field dropping >20% relative turns it red).

**raw_artifacts** — immutable fetched evidence. Never updated or deleted. `storage_key` = `raw/<source_key>/<sha256>` in object storage; `sha256`, `byte_size`, `content_type`, `http_status`, `headers_json`, `retrieved_at`, `source_published_at`, `parser_version`; `discovery_meta_json` (D5 — migration `0005_replay_meta` — the discovery-time context the parser needs, e.g. `reportMonth`/`inspectionDate`, set once at insert so `replaySource` can re-parse the immutable bytes faithfully after a parser fix). Unique on (source_id, canonical_url, sha256). `parent_artifact_id` links documents discovered from a landing artifact.

**source_records** — current normalized view of one external record. Unique on (source_id, external_id). `raw_fields_json` (parser input), `normalized_json` (the `NormalizedSourceRecord`), `normalized_fingerprint` (change detection), `first_seen_at`/`last_seen_at`/`source_updated_at`, `status`. Updates rewrite `normalized_json` but the prior raw artifact remains forever.

**evidence_items** — one row per fact-bearing span. `fact_path` (which normalized field), `evidence_text`, `page_or_section`, `source_url`, `authority_grade` (A–D, spec §11), `parser_version`. Append-only.

## Project graph (populated in M2)

**developments** — top-level real-estate efforts. `canonical_name`, `development_type`, `county`, `geometry`.

**projects** — phase/project level. `development_id`, `parent_project_id` (hierarchy), `permitting_jurisdiction` (always retained; King = unincorporated unless stated), `county`, `address_normalized`, `parcel_ids` (jsonb array), `geometry`, `current_stage` (spec §9 enum), `stage_confidence`, `geometry_source` + `geocode_meta_json` (migration `0014_geometry_provenance`, #3 — `'source_record'` = a resolved record's own geometry (source data), `'census_geocoder'` = a point inferred from the address by the US Census geocoder under a unique-match + county cross-check guard; the meta records every attempt outcome so reruns skip attempted projects; record geometry always beats a geocoded point), `campus_block` (migration `0013_campus_block`, #1 — derived active-campus membership `'<county>:<parcel-block-prefix>'`, stamped/cleared by `computeCampusVelocity` on every run like `development_id`; a rebuildable derived layer, never source data; prefix lengths per county are calibrated in `PARCEL_BLOCK_PREFIX_BY_COUNTY` — King 6 = the official PIN "major", Lewis 6 = base parcel of the 12-digit number, Thurston 7, default 6).

**project_external_ids** — namespaced official IDs: (authority, id_type, external_id) unique.

**project_events** — timeline. `event_type` (spec §9 plus the `cluster_velocity` extension required by §21 M2.6 — one signal per ≥5-permit/90-day development cluster, emitted on the anchor project with the tipping permit record as provenance; and the `campus_velocity` extension (#3) — one signal per ≥5 DISTINCT-named, NOT development-grouped projects sharing a parcel-block prefix with active permits in the window, i.e. a commercial/institutional campus like SpaceX that cluster_velocity misses), `event_date` vs `observed_at`, `prior_stage`/`resulting_stage`, `material_change`, `confirmed`, `confidence`. Facts vs inferences separated by `confirmed` + `confidence` (governing rule).

**organizations / organization_aliases** — canonical entities; `ubi`, `contractor_registration`, `status`, `verified_at` (never show registration status without it). Aliases map raw source spellings.

**project_roles** — org ↔ project with `role`, `source_record_id` provenance, `confirmed`, `confidence`.

## Resolution (M2 — schema extension, migration `0001_resolution`)

Not in the spec §7 table list; required by §10 ("record the resolver version, features, score, merge decision, and evidence; support split/undo — never delete underlying source records") and the §17 review-queue API.

**record_resolutions** — the durable source_record → project link with provenance. `resolver_version`, `matched_rule` (official_id | explicit_reference | parcel_overlap | address_name | proximity_org | development_phase | new_project | review_merge), `features_json` (the extracted match features), `score`, `decision` (auto | review_approved), `status` (active | undone — undo flips status and keeps the history row; source records are never deleted). One *active* resolution per record (partial unique index). `processed_fingerprint` (migration `0015_record_update_tracking`) tracks which content version of the record has been applied to the graph; `applyRecordUpdates` re-processes a resolution whose record's `normalized_fingerprint` drifted (source republished the row — e.g. an application later issued), advancing stage (never regressing from one record), emitting the stage-change event, and refreshing roles/geometry.

**resolution_reviews** — the human review queue. `candidate_project_id`, `matched_rule`, `features_json`, `score`, `reasons_json` (spec §10 triggers that fired: conflicting_jurisdiction, multiple_parcel_candidates, generic_name, …), `status` (pending | merged | rejected), decision metadata (`decided_at/by`, note).

## Accounts & intelligence (populated in M3)

**account_profiles** — seeded from `config/account-profiles.yaml`. `key` unique; `capabilities_json`, `territory_json`, `exclusions_json` (e.g. Solis closed UBI 604701295), `capacity_json`, `delivery_config_json` (band thresholds).

**account_rules** — versioned rules: (account, rule_type, version) unique; `rule_json`, `effective_at`. Rules are never edited in place — a change is a new version.

**account_capacity_snapshots** (S0 — migration `0006_capacity_snapshots`) — versioned capacity state effective over `[effective_from, effective_to)` (`effective_to` null = current). Columns: `available_crews`, `backlog_state`, `preferred_start_window`, `minimum/ideal/maximum_contract_value`, `maximum_travel_minutes`, `accepts_public_work`, `bonding_limit`, `trade_capacity_json`, `provisional` (placeholder values not yet customer-calibrated — §12.3), `notes`, `created_by`. Scoring reads the snapshot effective at scoring time and folds a deterministic, explained capacity factor into the score (`rationale_json.capacity`); historical windows are never rewritten. Seeded provisional for `solis_interiors` (created_by `system_provisional`).

**opportunities** — one per (account, project) unique. `current_score`, `score_version`, `route`, `state`, `rationale_json` (component scores — final score is a deterministic calculation).

**opportunity_evidence** — links every delivered claim to an `evidence_items` row with `claim_type`, `confirmed`, `confidence`. Publication gate requires 100% coverage.

**opportunity_decision_memos** (S1 — migration `0007_decision_memos`) — versioned decision memos, `(opportunity_id, decision_version)` unique. `content_hash` (SHA-256 over the memo's semantic fields) drives idempotent regenerate — a new version is written only when the assembled content changes. `memo_json` is the full §3 memo (summary/whatChanged/whyItFits/timing/recommendedAction, score+components, facts vs inferences vs missing, procurement state, capacity assessment, verifier status). A deterministic assembly over stored rows — AI is never the system of record; the memo feeds the UI and never overwrites parsed facts.

**feedback** — relevant / new_to_customer / timely / worth_pursuing booleans + `disposition_reason`, per user.

**sources.account_profile_id** (M4.6 — migration `0003_private_sources`) — non-null marks a *private, account-scoped* source (customer bid inbox): its records, artifacts, and evidence belong to exactly one account and are excluded from the shared project graph (resolver skip) and from every other account's queries.

**artifact_access_log** (M4.6 — migration `0003_private_sources`) — append-only audit of every read of a customer's private invitation artifacts (spec §20): `raw_artifact_id`, owning `account_profile_id`, `accessed_by` (session identity), `purpose`, `created_at`.

**model_runs** (M3.3 — migration `0002_model_runs`) — one row per model invocation *or blocked/rejected attempt* (spec §13): `job_type` (extraction | verification | brief_draft), nullable `project_id`/`account_profile_id`, `provider`, `model`, `prompt_version`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `result_hash` (SHA-256 of raw model output), `result_json` (the Zod-validated facts/inferences/missingCriticalFacts payload — null for rejected runs), `status` (succeeded | rejected | blocked | error), `error`. The monthly budget check sums `cost_usd` over the current UTC month, so every spending call must persist a row. AI is never the system of record: `result_json` feeds the verifier/UI and never overwrites parsed facts.

## Outcome / ROI + trust controls (S5 — migration `0012_roi_trust`)

Every metric reproduces from stored events; no manually edited aggregates.

**opportunity_outcomes** — human-recorded outcomes: `outcome_type`, `influenced_by_otn` (attributable revenue counts only when a human sets this true), `attributable_value`, `outcome_at`, `reason_code`.

**roi_events** — account-scoped ROI event log: `event_type`, `estimated_value`, `metadata_json`, `occurred_at`.

**research_time_entries** — `minutes_saved_estimate`, `estimation_method` — the research-time-saved metric sums these (never a guessed aggregate).

**account_suppressions** — `target_type` (project/organization), `target_id`, `expires_at`. `suppressedProjectIds()` resolves direct + transitive (via a suppressed org's roles) suppressions; digest assembly filters candidates against this set BEFORE building any item (§9). `roiScorecard()` in `packages/delivery` reproduces the §8 metrics; the urgent-alert whitelist (`URGENT_ALERT_CATEGORIES`, 5 categories) lives in `packages/intelligence/src/trust.ts`.

**claim_corrections** — append-only corrections: `evidence_item_id`, `opportunity_id`, `correction_type`, `prior_value_json`, `corrected_value_json`, `reason`, `source_record_id`. A correction is a new row — evidence and prior corrections are never mutated (§9).

## GC relationship intelligence (S4 — migration `0011_relationships`)

Account-specific, kept strictly distinct from the shared graph's public `project_roles`.

**account_organization_relationships** — `(account_profile_id, organization_id)` unique. `relationship_state` (unknown / research_needed / target / contacted / active_relationship / preferred / incumbent_blocked / do_not_pursue), `preferred`, `blocked`, `relationship_owner_user_id`, `first/last_contact_at`, `notes`, `updated_at`. `blocked` or `do_not_pursue`/`incumbent_blocked` suppress that account's alerts (§9).

**organization_contacts** — account-scoped contacts with provenance: `source_type` (`public_business` vs `customer_supplied`) and `customer_verified` keep a public listing distinct from a verified relationship contact. `name`, `role`, `email`, `phone`, `source_record_id`, `last_verified_at`.

**relationship_interactions** — `relationship_id`, `interaction_type`, `occurred_at`, `project_id`, `pursuit_id`, `summary`, `created_by`. Ties relationship activity to projects/pursuits.

## Invitation ingestion (S3 — migration `0010_bid_invitations`)

Extends M4.6. Provider-agnostic intake of customer-authorized bid invitations (.eml upload, inbound-email webhook, CSV) — never scrapes portals/credentials. All rows account-scoped private evidence.

**inbound_messages** — one row per ingested message; `(account_profile_id, provider, provider_message_id)` unique → a duplicate forward is ingested once. `sender`, `recipients_json`, `subject`, `received_at`, `raw_artifact_id`, `processing_status`.

**bid_invitations** — the structured invitation: `project_id` (nullable — linked only to a project the account already sees), `gc_organization_id`, `estimator_name/email`, `invitation_status` (invited only when the message carries an explicit solicitation — a forward is not a bid), `bid_due_at`, `job_walk_at`, `scope_summary`, `match_status` (matched/review/unmatched — ambiguous → review), `confidence`, `updated_at`.

**bid_invitation_events** — append-only account-scoped timeline: `invitation_received`, `deadline_changed` (metadata preserves both prior + revised deadlines, `verified:false` until a human confirms — deadline alerts gate on this), `addendum`. Deadline changes never overwrite history and never write to the shared project timeline (isolation boundary).

**bid_documents** — attached bid documents: `document_type`, `access_class` (private_authorized), `extraction_status`.

## Pursuit workflow (S2 — migration `0008_pursuits`)

**pursuits** — one operational pursuit per `(account_profile_id, opportunity_id)` (unique). `state` (spec §4 pipeline: discovered → qualified → relationship_target → bid_confirmed → bid_decision_pending → estimating → submitted → won/lost/no_bid → follow_up → archived), `owner_user_id` (every active pursuit has an owner), `priority`, `next_action_at`, `closed_at`, `estimated/submitted/outcome_contract_value`, `updated_at` (migration `0009_pursuit_updated_at`). Transitions are validated + audited server-side; states estimating/submitted/won/lost/no_bid can never be entered by an AI/system actor.

**pursuit_transitions** — append-only audit of every state change: `from_state`, `to_state`, `actor_type` (human/ai/system), `actor_id`, `reason`, `metadata_json`. The state history is never mutated.

**pursuit_tasks** — workflow tasks with a validated `task_type` (verify_gc, verify_bid_status, identify_estimator_contact, check_account_relationship, review_capacity, review_public_work_eligibility, attend_job_walk, bid_no_bid_decision, follow_up_after_submission), `owner_user_id`, `due_at`, `status`.

**pursuit_notes** — `author_user_id`, `body`, `visibility`.

## Delivery & coverage

**deliveries** — idempotent by unique `idempotency_key`; stores `rendered_content`, period, `status`, `metadata_json` (rules/models used).

**delivery_items** — ordered opportunity/event inclusions per delivery.

**alerts** (M4.7 — migration `0004_alerts`) — operational alerts (spend_budget | source_red | source_stale | delivery_unsent) with `severity`, `message`, `details_json`, unique `idempotency_key` (type:subject:period — scheduled re-evaluation never duplicates), `resolved_at` closes without deleting history.

**coverage_entries** — one per source: `freshness_state` (green/amber/red, updated by the health evaluator), `last_success_at`, `record_types`, `status`.

## Product phase P2/P3 (migrations `0017_action_tokens`, `0018_stage_lag_stats`, `0019_action_token_check`)

**action_tokens** (P2.3) — single-use one-tap email actions. `token_hash` (SHA-256 only — the raw token never lands in the DB), `account_profile_id` + `opportunity_id` + `action` (pursue | dismiss; DB CHECK), `delivery_id`, `expires_at`, `used_at` (atomic single-claim UPDATE). Security posture (review 2026-07-17): GET renders a confirmation page WITHOUT consuming (mail-scanner prefetch is harmless); only the confirm POST consumes and applies the effect through the audited UI paths; responses are no-store/no-referrer; per-IP rate limit on the endpoint. Rows are inert after use; retention cleanup is a noted follow-up.

**stage_lag_stats** (P3.1) — historical applied→issued lags per (county, permit_class): `n`, `p25/median/p75_days`, `computed_at`. Recomputed nightly (DELETE+INSERT — a pure function of stored records; samples are records stating BOTH dates on the same row). Surfaced in decision memos only when `n ≥ 20` and always labeled an inference from past lags, never a promise.

**account_profiles.delivery_config_json.easy_win** (P2.1) — per-account "winnable now" cut: `home_lon/lat`, `radius_km`, `max_age_days`, `min/max_valuation_usd`. Solis values are PROVISIONAL until the calibration session; absent home disables the geo check honestly.

**organizations.registry_ref** (P1.4, migration `0016`) — One Trade Network registry join point; set only by authorized import.
