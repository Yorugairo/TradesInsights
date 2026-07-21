import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load a repo-root .env so a local override (e.g. DATABASE_URL on a non-default port
// when a native Postgres already owns 5432 and the Docker container is published on
// 5433) applies to tests too. No-op when .env is absent; dotenv never overrides an
// existing process.env var, so CI (which sets env directly) is unaffected and the
// defaults below still apply.
loadEnv();

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
      "apps/worker/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration files share the fake_source DB fixture (resetSource);
    // parallel files would clear each other's records mid-run.
    fileParallelism: false,
    passWithNoTests: false,
    env: {
      // Defaults match docker-compose; real env vars override.
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://otn:otn@localhost:5432/otn",
      OBJECT_STORAGE_ENDPOINT:
        process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000",
      OBJECT_STORAGE_REGION: process.env.OBJECT_STORAGE_REGION ?? "us-east-1",
      OBJECT_STORAGE_BUCKET:
        process.env.OBJECT_STORAGE_BUCKET ?? "otn-artifacts",
      OBJECT_STORAGE_ACCESS_KEY:
        process.env.OBJECT_STORAGE_ACCESS_KEY ?? "otn-minio",
      OBJECT_STORAGE_SECRET_KEY:
        process.env.OBJECT_STORAGE_SECRET_KEY ?? "otn-minio-secret",
      SOURCE_USER_AGENT:
        process.env.SOURCE_USER_AGENT ?? "OTNInsightsBot/0.1 (test)",
      // Unit tests stub global fetch and must never route through an egress
      // proxy — blank these so FetchPolicy's proxy branch stays off.
      HTTPS_PROXY: "",
      https_proxy: "",
    },
  },
});
