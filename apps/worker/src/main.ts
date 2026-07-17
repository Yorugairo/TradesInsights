import { createLogger } from "@otn/source-sdk";
import { createBoss, registerWorkers } from "./jobs.js";
import { registerSchedules } from "./schedules.js";
import { modelAvailability } from "./env.js";

async function main() {
  const logger = createLogger({ app: "worker" });
  const models = modelAvailability();
  if (!models.available) {
    logger.warn({ modelJobs: "blocked" }, models.reason);
  }
  const boss = await createBoss();
  await registerWorkers(boss, logger);
  // #4 — reconcile cron schedules (per-source cadence, nightly maintenance,
  // weekly digest drafts) from config at every boot.
  await registerSchedules(boss, logger);
  logger.info("worker started — listening for jobs and schedules");

  const shutdown = async () => {
    logger.info("shutting down");
    await boss.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
