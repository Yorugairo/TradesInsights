import type { SourceAdapter } from "@otn/source-sdk";
import { FakeSourceAdapter } from "./fake-source.js";
import { KingPermitReportsAdapter } from "./king-permit-reports.js";
import { KingPublicNoticesAdapter } from "./king-public-notices.js";
import { LaceyProjectPagesAdapter } from "./lacey-project-pages.js";
import { LaceyProjectsRestAdapter } from "./lacey-projects-rest.js";
import { LewisCurrentPlanningAdapter } from "./lewis-current-planning.js";
import { LewisIssuedPermitsAdapter } from "./lewis-issued-permits.js";
import { LewisSourceCanaryAdapter } from "./lewis-source-canary.js";

export { FakeSourceAdapter };
export { LaceyProjectsRestAdapter } from "./lacey-projects-rest.js";
export { LaceyProjectPagesAdapter } from "./lacey-project-pages.js";
export { LewisCurrentPlanningAdapter } from "./lewis-current-planning.js";
export { LewisIssuedPermitsAdapter } from "./lewis-issued-permits.js";
export { LewisSourceCanaryAdapter } from "./lewis-source-canary.js";
export { KingPublicNoticesAdapter } from "./king-public-notices.js";
export { KingPermitReportsAdapter } from "./king-permit-reports.js";

const REGISTRY: Record<string, () => SourceAdapter> = {
  fake_source: () => new FakeSourceAdapter(),
  lacey_projects_rest: () => new LaceyProjectsRestAdapter(),
  lacey_project_pages: () => new LaceyProjectPagesAdapter(),
  lewis_current_planning: () => new LewisCurrentPlanningAdapter(),
  lewis_issued_permits: () => new LewisIssuedPermitsAdapter(),
  lewis_source_canary: () => new LewisSourceCanaryAdapter(),
  king_public_notices: () => new KingPublicNoticesAdapter(),
  king_permit_reports: () => new KingPermitReportsAdapter(),
};

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
