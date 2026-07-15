import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
