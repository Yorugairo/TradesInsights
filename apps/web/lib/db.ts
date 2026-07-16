import "./env.js";
import type pg from "pg";
import { createDb, createPool, type Db } from "@otn/db";

// One pool per process; survives Next.js dev-server module reloads.
const globalStore = globalThis as unknown as { __otnPool?: pg.Pool; __otnDb?: Db };

export function db(): Db {
  if (!globalStore.__otnDb) {
    globalStore.__otnPool = createPool();
    globalStore.__otnDb = createDb(globalStore.__otnPool);
  }
  return globalStore.__otnDb;
}
