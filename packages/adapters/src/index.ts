import type { SourceAdapter } from "@otn/source-sdk";
import { FakeSourceAdapter } from "./fake-source.js";
import { LaceyProjectPagesAdapter } from "./lacey-project-pages.js";
import { LaceyProjectsRestAdapter } from "./lacey-projects-rest.js";

export { FakeSourceAdapter };
export { LaceyProjectsRestAdapter } from "./lacey-projects-rest.js";
export { LaceyProjectPagesAdapter } from "./lacey-project-pages.js";

const REGISTRY: Record<string, () => SourceAdapter> = {
  fake_source: () => new FakeSourceAdapter(),
  lacey_projects_rest: () => new LaceyProjectsRestAdapter(),
  lacey_project_pages: () => new LaceyProjectPagesAdapter(),
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
