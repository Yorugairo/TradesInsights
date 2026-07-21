import "../load-env.js";
import { createLogger } from "@otn/source-sdk";
import { runMaintenance } from "../schedules.js";

// pnpm maintenance:run — execute the nightly maintenance chain ONCE, outside
// the pg-boss scheduler: resolution → record updates → developments →
// velocity/campus → geometry → geocode → stage-lag → registry seam
// (link/observations/export; visible skips without REGISTRY_DATABASE_URL) →
// scoring → token cleanup → alerts. This is the runbook Part C3 "run the
// nightly chain once by hand" entry point after source runs land.
async function main() {
  const logger = createLogger({ app: "maintenance-run-cli" });
  await runMaintenance(logger);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
