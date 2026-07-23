import { z } from "zod";

// Spec §9 — project stages, in lifecycle order.
export const PROJECT_STAGES = [
  "concept",
  "preapplication",
  "entitlement",
  "approved",
  "construction_documents",
  "permit_applied",
  "permit_issued",
  "bidding_confirmed",
  "construction",
  "near_final",
  "complete",
  "withdrawn",
  "unknown",
] as const;

export const ProjectStageSchema = z.enum(PROJECT_STAGES);
export type ProjectStage = z.infer<typeof ProjectStageSchema>;

// Spec §9 — event taxonomy.
export const EVENT_TYPES = [
  "project_first_seen",
  "application_submitted",
  "notice_published",
  "sepa_determination",
  "revision_submitted",
  "decision_issued",
  "plat_approved",
  "permit_applied",
  "permit_issued",
  "solicitation_published",
  "bid_addendum",
  "bid_deadline_changed",
  "award_published",
  "inspection_activity",
  "stage_changed",
  "record_corrected",
  "record_withdrawn",
  // Extension beyond the spec §9 list, required by spec §21 M2.6: a permit
  // cluster on one development is one opportunity plus a velocity signal,
  // not N leads. Divergence recorded in docs/STATUS.md + architecture.md.
  "cluster_velocity",
  // M2.6 depth (#3): concentrated permit activity across DISTINCT-named
  // projects that share a parcel block but are NOT name-grouped into a
  // development (a campus/portfolio like SpaceX SE02–SE06). cluster_velocity
  // covers same-development clusters; this covers the campus case it misses.
  "campus_velocity",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

// Puget Sound densification (Wave 3): the four pilot counties plus the western/
// eastern WA counties whose CLEAN permit sources are onboarded in this wave
// (Snohomish, Kitsap, Clark, Spokane). Additive — existing county behavior and
// the frozen §12.3 scorer are untouched; scoring is county-string-tolerant, so
// records in the new counties validate and flow through the scorer normally.
// RESOLVED 2026-07-23 (scoring v1.10.0): each of these counties now has an
// explicit Solis DISTANCE band (`SOLIS_GEOGRAPHY_BANDS` in
// packages/intelligence/src/scoring.ts) — Kitsap 0.5, Snohomish 0.4, Clark 0.3,
// Spokane 0.15 — so they no longer outrank King's calibrated 0.6 on geography.
// The four pilot counties are unchanged, keeping the frozen eval byte-identical.
export const COUNTIES = [
  "Thurston",
  "Pierce",
  "Lewis",
  "King",
  "Snohomish",
  "Kitsap",
  "Clark",
  "Spokane",
] as const;
export const CountySchema = z.enum(COUNTIES);
export type County = z.infer<typeof CountySchema>;

// Spec §11 — evidence authority grades.
export const AUTHORITY_GRADES = ["A", "B", "C", "D"] as const;
export const AuthorityGradeSchema = z.enum(AUTHORITY_GRADES);
export type AuthorityGrade = z.infer<typeof AuthorityGradeSchema>;

// Spec §14 — source health states.
export const SOURCE_HEALTH_STATES = ["green", "amber", "red"] as const;
export const SourceHealthStateSchema = z.enum(SOURCE_HEALTH_STATES);
export type SourceHealthState = z.infer<typeof SourceHealthStateSchema>;
