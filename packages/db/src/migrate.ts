import "./env.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client.js";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main() {
  const pool = createPool();
  const db = createDb(pool);
  await migrate(db, { migrationsFolder });
  await pool.end();
  console.log(JSON.stringify({ msg: "migrations applied", migrationsFolder }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
