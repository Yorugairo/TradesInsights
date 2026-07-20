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
import { PiercePermitsArcgisAdapter } from "./pierce-permits-arcgis.js";
import { PiercePalsContractorAdapter } from "./pierce-pals-contractor.js";
import { PuyallupPermitsArcgisAdapter } from "./puyallup-permits-arcgis.js";
import { CentraliaPermitReportsAdapter } from "./centralia-permit-reports.js";
import { OlympiaSmartgovReportsAdapter } from "./olympia-smartgov-reports.js";
import { TumwaterSepaAdapter } from "./tumwater-sepa.js";
import { SeattleSourceCanaryAdapter } from "./seattle-source-canary.js";
import { TacomaPermitsArcgisAdapter } from "./tacoma-permits-arcgis.js";
import { TacomaSolicitationsAdapter } from "./tacoma-solicitations.js";
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
  pierce_permits_arcgis: () => new PiercePermitsArcgisAdapter(),
  pierce_pals_contractor: () => new PiercePalsContractorAdapter(),
  puyallup_permits_arcgis: () => new PuyallupPermitsArcgisAdapter(),
  centralia_permit_reports: () => new CentraliaPermitReportsAdapter(),
  olympia_smartgov_reports: () => new OlympiaSmartgovReportsAdapter(),
  tumwater_sepa: () => new TumwaterSepaAdapter(),
  tacoma_permits_arcgis: () => new TacomaPermitsArcgisAdapter(),
  tacoma_solicitations: () => new TacomaSolicitationsAdapter(),
};
export { PiercePermitsArcgisAdapter } from "./pierce-permits-arcgis.js";
export { PiercePalsContractorAdapter } from "./pierce-pals-contractor.js";
export { PuyallupPermitsArcgisAdapter } from "./puyallup-permits-arcgis.js";
export { CentraliaPermitReportsAdapter } from "./centralia-permit-reports.js";
export { OlympiaSmartgovReportsAdapter } from "./olympia-smartgov-reports.js";
export { TumwaterSepaAdapter } from "./tumwater-sepa.js";
export { TacomaPermitsArcgisAdapter } from "./tacoma-permits-arcgis.js";
export { TacomaSolicitationsAdapter } from "./tacoma-solicitations.js";

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
