import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    // Default matches docker-compose + the search_path contract: unqualified
    // DDL in migrations lands in `insights` (first schema in the path).
    url:
      process.env.DATABASE_URL ??
      "postgres://otn:otn@localhost:5432/otn?options=-csearch_path%3Dinsights%2Cpublic%2Cextensions",
  },
});
