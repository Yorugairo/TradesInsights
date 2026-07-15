import type { SourceAdapter } from "@otn/source-sdk";
import { FakeSourceAdapter } from "./fake-source.js";

export { FakeSourceAdapter };

const REGISTRY: Record<string, () => SourceAdapter> = {
  fake_source: () => new FakeSourceAdapter(),
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
