import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryObjectStore, createLogger, type RunContext } from "@otn/source-sdk";

export const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..",
  "fixtures",
);

export interface TestRunContext extends RunContext {
  /** Checkpoint captured by setCheckpoint, for assertions. */
  savedCheckpoint: Record<string, unknown> | null;
}

/** Offline RunContext for parser/discovery tests — no DB, no network side effects. */
export function testContext(
  sourceKey: string,
  overrides?: Partial<Pick<RunContext, "checkpoint" | "backfill">>,
): TestRunContext {
  const ctx: TestRunContext = {
    sourceKey,
    sourceRunId: "test-run",
    traceId: "test-trace",
    logger: createLogger({ app: "adapter-test" }).child({}, { level: "silent" }),
    userAgent: "OTNInsightsBot/0.1 (test)",
    fixturesDir: FIXTURES_DIR,
    objectStore: new MemoryObjectStore(),
    checkpoint: overrides?.checkpoint ?? null,
    savedCheckpoint: null,
    setCheckpoint(cp) {
      ctx.savedCheckpoint = cp;
    },
    backfill: overrides?.backfill ?? null,
  };
  return ctx;
}
