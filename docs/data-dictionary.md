# Data dictionary

> Maintained as a deliverable: update this file with every schema migration. Authoritative DDL: `packages/db/migrations/`; Drizzle definitions: `packages/db/src/schema.ts`. Last updated: migration `0000_init` (M0, 2026-07-15).

Conventions: UUID primary keys (`gen_random_uuid()`); official identifiers are namespaced *external* IDs, never primary keys; timestamps are `timestamptz`; unknown values are `NULL`, never guessed or zero (spec §8).

## Ingestion

**sources** — one row per configured source (seeded from `config/sources.yaml`).
Key columns: `key` (unique), `authority`, `priority` (P0/P1/lookup/context/test), `landing_url`, `access_url`, `format`, `access_class`, `cadence`, `county`, `permitting_jurisdiction`, `enabled`, `terms_reviewed_at`, `robots_reviewed_at`. Config-only `mitigates: string[]` (D4 — keys this source provides substitute coverage for, e.g. `wa_sepa` → Pierce/Tumwater environmental determinations) is read from config by the alerts CLI, not stored in the table.

**source_runs** — one row per run. `status`: running | succeeded | completed_with_errors | failed. Metrics counters (`discovered/fetched/unchanged/parsed/rejected/duplicate/error_count`), `checkpoint_json` (pagination/high-water mark), `schema_fingerprint` (hash of raw field names — drift detection), `metrics_json` (dead-letter entries: idempotency key, URL, stage, error; plus D1 `invariantViolations` count + `invariantViolationDetails[]` — each `{check, detail, observed, expected, canonicalUrl}` from an adapter's `checkInvariants` self-reconciliation; a non-zero count turns the source red in `evaluateSourceHealth`; plus D2 `fieldFill` — `{field: fill_rate}` over `MONITORED_FILL_FIELDS` for the records this run parsed, compared against the source's previous parsed run so a required field dropping >20% relative turns it red).

**raw_artifacts** — immutable fetched evidence. Never updated or deleted. `storage_key` = `raw/<source_key>/<sha256>` in object storage; `sha256`, `byte_size`, `content_type`, `http_status`, `headers_json`, `retrieved_at`, `source_published_at`, `parser_version`. Unique on (source_id, canonical_url, sha256). `parent_artifact_id` links documents discovered from a landing artifact.

**source_records** — current normalized view of one external record. Unique on (source_id, external_id). `raw_fields_json` (parser input), `normalized_json` (the `NormalizedSourceRecord`), `normalized_fingerprint` (change detection), `first_seen_at`/`last_seen_at`/`source_updated_at`, `status`. Updates rewrite `normalized_json` but the prior raw artifact remains forever.

**evidence_items** — one row per fact-bearing span. `fact_path` (which normalized field), `evidence_text`, `page_or_section`, `source_url`, `authority_grade` (A–D, spec §11), `parser_version`. Append-only.

## Project graph (populated in M2)

**developments** — top-level real-estate efforts. `canonical_name`, `development_type`, `county`, `geometry`.

**projects** — phase/project level. `development_id`, `parent_project_id` (hierarchy), `permitting_jurisdiction` (always retained; King = unincorporated unless stated), `county`, `address_normalized`, `parcel_ids` (jsonb array), `geometry`, `current_stage` (spec §9 enum), `stage_confidence`.

**project_external_ids** — namespaced official IDs: (authority, id_type, external_id) unique.

**project_events** — timeline. `event_type` (spec §9 plus the `cluster_velocity` extension required by §21 M2.6 — one signal per ≥5-permit/90-day development cluster, emitted on the anchor project with the tipping permit record as provenance), `event_date` vs `observed_at`, `prior_stage`/`resulting_stage`, `material_change`, `confirmed`, `confidence`. Facts vs inferences separated by `confirmed` + `confidence` (governing rule).

**organizations / organization_aliases** — canonical entities; `ubi`, `contractor_registration`, `status`, `verified_at` (never show registration status without it). Aliases map raw source spellings.

**project_roles** — org ↔ project with `role`, `source_record_id` provenance, `confirmed`, `confidence`.

## Resolution (M2 — schema extension, migration `0001_resolution`)

Not in the spec §7 table list; required by §10 ("record the resolver version, features, score, merge decision, and evidence; support split/undo — never delete underlying source records") and the §17 review-queue API.

**record_resolutions** — the durable source_record → project link with provenance. `resolver_version`, `matched_rule` (official_id | explicit_reference | parcel_overlap | address_name | proximity_org | development_phase | new_project | review_merge), `features_json` (the extracted match features), `score`, `decision` (auto | review_approved), `status` (active | undone — undo flips status and keeps the history row; source records are never deleted). One *active* resolution per record (partial unique index).

**resolution_reviews** — the human review queue. `candidate_project_id`, `matched_rule`, `features_json`, `score`, `reasons_json` (spec §10 triggers that fired: conflicting_jurisdiction, multiple_parcel_candidates, generic_name, …), `status` (pending | merged | rejected), decision metadata (`decided_at/by`, note).

## Accounts & intelligence (populated in M3)

**account_profiles** — seeded from `config/account-profiles.yaml`. `key` unique; `capabilities_json`, `territory_json`, `exclusions_json` (e.g. Solis closed UBI 604701295), `capacity_json`, `delivery_config_json` (band thresholds).

**account_rules** — versioned rules: (account, rule_type, version) unique; `rule_json`, `effective_at`. Rules are never edited in place — a change is a new version.

**opportunities** — one per (account, project) unique. `current_score`, `score_version`, `route`, `state`, `rationale_json` (component scores — final score is a deterministic calculation).

**opportunity_evidence** — links every delivered claim to an `evidence_items` row with `claim_type`, `confirmed`, `confidence`. Publication gate requires 100% coverage.

**feedback** — relevant / new_to_customer / timely / worth_pursuing booleans + `disposition_reason`, per user.

**sources.account_profile_id** (M4.6 — migration `0003_private_sources`) — non-null marks a *private, account-scoped* source (customer bid inbox): its records, artifacts, and evidence belong to exactly one account and are excluded from the shared project graph (resolver skip) and from every other account's queries.

**artifact_access_log** (M4.6 — migration `0003_private_sources`) — append-only audit of every read of a customer's private invitation artifacts (spec §20): `raw_artifact_id`, owning `account_profile_id`, `accessed_by` (session identity), `purpose`, `created_at`.

**model_runs** (M3.3 — migration `0002_model_runs`) — one row per model invocation *or blocked/rejected attempt* (spec §13): `job_type` (extraction | verification | brief_draft), nullable `project_id`/`account_profile_id`, `provider`, `model`, `prompt_version`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `result_hash` (SHA-256 of raw model output), `result_json` (the Zod-validated facts/inferences/missingCriticalFacts payload — null for rejected runs), `status` (succeeded | rejected | blocked | error), `error`. The monthly budget check sums `cost_usd` over the current UTC month, so every spending call must persist a row. AI is never the system of record: `result_json` feeds the verifier/UI and never overwrites parsed facts.

## Delivery & coverage

**deliveries** — idempotent by unique `idempotency_key`; stores `rendered_content`, period, `status`, `metadata_json` (rules/models used).

**delivery_items** — ordered opportunity/event inclusions per delivery.

**alerts** (M4.7 — migration `0004_alerts`) — operational alerts (spend_budget | source_red | source_stale | delivery_unsent) with `severity`, `message`, `details_json`, unique `idempotency_key` (type:subject:period — scheduled re-evaluation never duplicates), `resolved_at` closes without deleting history.

**coverage_entries** — one per source: `freshness_state` (green/amber/red, updated by the health evaluator), `last_success_at`, `record_types`, `status`.
