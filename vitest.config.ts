import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load a repo-root .env so a local override (e.g. DATABASE_URL on a non-default port
// when a native Postgres already owns 5432 and the Docker container is published on
// 5433) applies to tests too. No-op when .env is absent; dotenv never overrides an
// existing process.env var, so CI (which sets env directly) is unaffected and the
// defaults below still apply.
loadEnv();

// PRODUCTION-SAFETY GUARD (Part E co-location): after cutover the repo .env
// points DATABASE_URL at the HOSTED Supabase DB, but tests truncate/reset data
// (resetSource, deleteTestProjects) and must never do that to production.
// A non-local DATABASE_URL is therefore IGNORED for tests — they fall back to
// the local Docker default below — unless ALLOW_REMOTE_TEST_DB=1 is set
// explicitly. PG_PORT (compose override) keeps the local fallback correct on
// machines where a native Postgres shadows 5432.
// Moved to ./vitest.test-db.ts so vitest.global-setup.ts pre-flights the SAME
// database this injects. When the two disagreed, the pre-flight checked the
// hosted DB (always up) and passed while the local container was stopped.
import {
  testDatabaseUrl,
  testObjectStorageEndpoint,
  usingLocalObjectStorage,
} from "./vitest.test-db.js";

export default defineConfig({
  // apps/web/tsconfig.json sets `"jsx": "preserve"` because Next owns that
  // transform in the app build. Vitest has no Next pipeline behind it, so JSX
  // left un-transformed reaches Node as a syntax error. Compile it here instead
  // — `automatic` matches React 19's runtime and needs no `import React`.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
      "apps/worker/test/**/*.test.ts",
      // apps/web carries .tsx component tests. They render through
      // react-dom/server (every primitive is a server component, so the static
      // markup is the whole output) and need neither jsdom nor a DOM testing
      // library — hence no `environment` override here.
      "apps/web/**/*.test.ts",
      "apps/web/**/*.test.tsx",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Report "the database is down" ONCE and legibly, instead of as 40 failed
    // files with ECONNREFUSED buried in each stack. See vitest.global-setup.ts.
    globalSetup: ["./vitest.global-setup.ts"],
    // Integration files share the fake_source DB fixture (resetSource);
    // parallel files would clear each other's records mid-run.
    fileParallelism: false,
    passWithNoTests: false,
    env: {
      // Local-guarded (see testDatabaseUrl above): non-local DATABASE_URL is
      // ignored for tests. The options param is the search_path contract
      // (insights,public,extensions) — all Insights tables live in the
      // `insights` schema (Part E co-location).
      DATABASE_URL: testDatabaseUrl(),
      // Capture-fed adapters (Olympia/Tumwater) must DEAD-LETTER in tests: an
      // operator's staged genuine-browser captures (.env OTN_CAPTURE_DIR) are a
      // runtime concern and would make fetch() resolve, breaking the gate tests.
      OTN_CAPTURE_DIR: "",
      // Local-guarded like DATABASE_URL: these tests WRITE objects, and the
      // production bucket now holds the only copy of the raw source bodies.
      // When the guard sends us to local MinIO the credentials must go with it —
      // inheriting Supabase keys against a MinIO endpoint just fails obscurely.
      OBJECT_STORAGE_ENDPOINT: testObjectStorageEndpoint(),
      OBJECT_STORAGE_REGION: usingLocalObjectStorage()
        ? "us-east-1"
        : (process.env.OBJECT_STORAGE_REGION ?? "us-east-1"),
      OBJECT_STORAGE_BUCKET:
        process.env.OBJECT_STORAGE_BUCKET ?? "otn-artifacts",
      OBJECT_STORAGE_ACCESS_KEY: usingLocalObjectStorage()
        ? "otn-minio"
        : (process.env.OBJECT_STORAGE_ACCESS_KEY ?? "otn-minio"),
      OBJECT_STORAGE_SECRET_KEY: usingLocalObjectStorage()
        ? "otn-minio-secret"
        : (process.env.OBJECT_STORAGE_SECRET_KEY ?? "otn-minio-secret"),
      // Never carry a Supabase session token into a local MinIO run.
      OBJECT_STORAGE_SESSION_TOKEN: usingLocalObjectStorage()
        ? ""
        : (process.env.OBJECT_STORAGE_SESSION_TOKEN ?? ""),
      SOURCE_USER_AGENT:
        process.env.SOURCE_USER_AGENT ?? "OTNInsightsBot/0.1 (test)",
      // Unit tests stub global fetch and must never route through an egress
      // proxy — blank these so FetchPolicy's proxy branch stays off.
      HTTPS_PROXY: "",
      https_proxy: "",
    },
  },
});
