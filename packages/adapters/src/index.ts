import type { SourceAdapter } from "@otn/source-sdk";
import { CustomerBidInboxAdapter } from "./customer-bid-inbox.js";
import { FakeSourceAdapter } from "./fake-source.js";
import { KingPermitReportsAdapter } from "./king-permit-reports.js";
import { KingPublicNoticesAdapter } from "./king-public-notices.js";
import { LaceyProjectPagesAdapter } from "./lacey-project-pages.js";
import { LaceyPermitReportsAdapter } from "./lacey-permit-reports.js";
import { LaceyProjectsRestAdapter } from "./lacey-projects-rest.js";
import { LewisCurrentPlanningAdapter } from "./lewis-current-planning.js";
import { LewisInspectionsAdapter } from "./lewis-inspections.js";
import { LewisIssuedPermitsAdapter } from "./lewis-issued-permits.js";
import { LewisSourceCanaryAdapter } from "./lewis-source-canary.js";
import {
  SEATTLE_BUILDING_CONFIG,
  SEATTLE_LAND_USE_CONFIG,
  SeattleSocrataAdapter,
} from "./seattle-socrata.js";
import { ArcgisPermitsAdapter, BELLEVUE_CONFIG, SPOKANE_CONFIG } from "./arcgis-permits.js";
import { SocrataPermitsAdapter, EVERETT_CONFIG, AUBURN_CONFIG } from "./socrata-permits.js";
import { PiercePermitsArcgisAdapter } from "./pierce-permits-arcgis.js";
import { PiercePalsContractorAdapter } from "./pierce-pals-contractor.js";
import { PuyallupPermitsArcgisAdapter } from "./puyallup-permits-arcgis.js";
import { CentraliaPermitReportsAdapter } from "./centralia-permit-reports.js";
import { OlympiaSmartgovReportsAdapter } from "./olympia-smartgov-reports.js";
import { SeattleDesignReviewAdapter } from "./seattle-design-review.js";
import { ThurstonHearingExaminerAdapter } from "./thurston-hearing-examiner.js";
import { ThurstonLandUseRezoneAdapter } from "./thurston-land-use-rezone.js";
import { TumwaterSepaAdapter } from "./tumwater-sepa.js";
import { SeattleSourceCanaryAdapter } from "./seattle-source-canary.js";
import { TacomaPermitsArcgisAdapter } from "./tacoma-permits-arcgis.js";
import { OmwbeBidOpportunitiesAdapter } from "./omwbe-bid-opportunities.js";
import { TacomaSolicitationsAdapter } from "./tacoma-solicitations.js";
import { WebsBidCalendarAdapter } from "./webs-bid-calendar.js";
import { ThurstonActiveNoticesAdapter } from "./thurston-active-notices.js";
import { TumwaterDevelopmentArcgisAdapter } from "./tumwater-arcgis.js";
import { TumwaterDevelopmentReviewAdapter } from "./tumwater-development-review.js";
import { WaSepaAdapter } from "./wa-sepa.js";

export { FakeSourceAdapter };
export { CustomerBidInboxAdapter } from "./customer-bid-inbox.js";
export { LaceyProjectsRestAdapter } from "./lacey-projects-rest.js";
export { LaceyProjectPagesAdapter } from "./lacey-project-pages.js";
export { LaceyPermitReportsAdapter } from "./lacey-permit-reports.js";
export { LewisCurrentPlanningAdapter } from "./lewis-current-planning.js";
export { LewisIssuedPermitsAdapter } from "./lewis-issued-permits.js";
export { LewisSourceCanaryAdapter } from "./lewis-source-canary.js";
export { LewisInspectionsAdapter } from "./lewis-inspections.js";
export { KingPublicNoticesAdapter } from "./king-public-notices.js";
export { KingPermitReportsAdapter } from "./king-permit-reports.js";
export {
  SeattleSocrataAdapter,
  SEATTLE_BUILDING_CONFIG,
  SEATTLE_LAND_USE_CONFIG,
} from "./seattle-socrata.js";
export { SeattleSourceCanaryAdapter } from "./seattle-source-canary.js";
export { WaSepaAdapter } from "./wa-sepa.js";
export { ThurstonActiveNoticesAdapter } from "./thurston-active-notices.js";
export { TumwaterDevelopmentArcgisAdapter } from "./tumwater-arcgis.js";
export { TumwaterDevelopmentReviewAdapter } from "./tumwater-development-review.js";

const REGISTRY: Record<string, () => SourceAdapter> = {
  fake_source: () => new FakeSourceAdapter(),
  customer_bid_inbox_solis: () => new CustomerBidInboxAdapter("customer_bid_inbox_solis", "solis_interiors"),
  lacey_projects_rest: () => new LaceyProjectsRestAdapter(),
  lacey_permit_reports: () => new LaceyPermitReportsAdapter(),
  lacey_project_pages: () => new LaceyProjectPagesAdapter(),
  lewis_current_planning: () => new LewisCurrentPlanningAdapter(),
  lewis_issued_permits: () => new LewisIssuedPermitsAdapter(),
  lewis_inspections: () => new LewisInspectionsAdapter(),
  lewis_source_canary: () => new LewisSourceCanaryAdapter(),
  king_public_notices: () => new KingPublicNoticesAdapter(),
  king_permit_reports: () => new KingPermitReportsAdapter(),
  seattle_building_permits: () => new SeattleSocrataAdapter(SEATTLE_BUILDING_CONFIG),
  seattle_land_use_permits: () => new SeattleSocrataAdapter(SEATTLE_LAND_USE_CONFIG),
  seattle_source_canary: () => new SeattleSourceCanaryAdapter(),
  wa_sepa: () => new WaSepaAdapter(),
  thurston_active_notices: () => new ThurstonActiveNoticesAdapter(),
  tumwater_development_arcgis: () => new TumwaterDevelopmentArcgisAdapter(),
  tumwater_development_review: () => new TumwaterDevelopmentReviewAdapter(),
  // Wave3 — generic config-driven ArcGIS cities (arcgis-permits.ts).
  bellevue_permits_arcgis: () => new ArcgisPermitsAdapter(BELLEVUE_CONFIG),
  spokane_permits_arcgis: () => new ArcgisPermitsAdapter(SPOKANE_CONFIG),
  // Wave3 — generic config-driven Socrata cities (socrata-permits.ts). Everett
  // is live (Snohomish); Auburn is enabled:false in config/sources.yaml — its
  // schema + parser are verified but the dataset ETL is frozen at 2025-02, so a
  // live run would immediately go stale-RED (one-flag flip if it resumes).
  everett_permits_socrata: () => new SocrataPermitsAdapter(EVERETT_CONFIG),
  auburn_permits_socrata: () => new SocrataPermitsAdapter(AUBURN_CONFIG),
  pierce_permits_arcgis: () => new PiercePermitsArcgisAdapter(),
  pierce_pals_contractor: () => new PiercePalsContractorAdapter(),
  puyallup_permits_arcgis: () => new PuyallupPermitsArcgisAdapter(),
  centralia_permit_reports: () => new CentraliaPermitReportsAdapter(),
  olympia_smartgov_reports: () => new OlympiaSmartgovReportsAdapter(),
  // WS-G verify-first scaffolds — DISABLED in config/sources.yaml (enabled:false),
  // registered so the parser + fixtures are testable and the source is ready to
  // activate once the verify-first checklist passes. Never scheduled while disabled.
  seattle_design_review: () => new SeattleDesignReviewAdapter(),
  thurston_hearing_examiner: () => new ThurstonHearingExaminerAdapter(),
  thurston_land_use_rezone: () => new ThurstonLandUseRezoneAdapter(),
  tumwater_sepa: () => new TumwaterSepaAdapter(),
  tacoma_permits_arcgis: () => new TacomaPermitsArcgisAdapter(),
  tacoma_solicitations: () => new TacomaSolicitationsAdapter(),
  omwbe_bid_opportunities: () => new OmwbeBidOpportunitiesAdapter(),
  webs_bid_calendar: () => new WebsBidCalendarAdapter(),
};
export { ArcgisPermitsAdapter, BELLEVUE_CONFIG, SPOKANE_CONFIG } from "./arcgis-permits.js";
export { SocrataPermitsAdapter, EVERETT_CONFIG, AUBURN_CONFIG } from "./socrata-permits.js";
export { PiercePermitsArcgisAdapter } from "./pierce-permits-arcgis.js";
export { PiercePalsContractorAdapter } from "./pierce-pals-contractor.js";
export { PuyallupPermitsArcgisAdapter } from "./puyallup-permits-arcgis.js";
export { CentraliaPermitReportsAdapter } from "./centralia-permit-reports.js";
export { OlympiaSmartgovReportsAdapter } from "./olympia-smartgov-reports.js";
export { SeattleDesignReviewAdapter } from "./seattle-design-review.js";
export { ThurstonHearingExaminerAdapter } from "./thurston-hearing-examiner.js";
export { ThurstonLandUseRezoneAdapter } from "./thurston-land-use-rezone.js";
export { TumwaterSepaAdapter } from "./tumwater-sepa.js";
export { TacomaPermitsArcgisAdapter } from "./tacoma-permits-arcgis.js";
export { TacomaSolicitationsAdapter } from "./tacoma-solicitations.js";
export { OmwbeBidOpportunitiesAdapter } from "./omwbe-bid-opportunities.js";
export { WebsBidCalendarAdapter } from "./webs-bid-calendar.js";

export function getAdapter(key: string): SourceAdapter {
  const factory = REGISTRY[key];
  if (!factory) {
    throw new Error(
      `no adapter registered for source key "${key}" — known: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return factory();
}

export function registeredAdapterKeys(): string[] {
  return Object.keys(REGISTRY);
}
