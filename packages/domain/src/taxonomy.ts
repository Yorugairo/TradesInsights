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
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const COUNTIES = ["Thurston", "Pierce", "Lewis", "King"] as const;
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
