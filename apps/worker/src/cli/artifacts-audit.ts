import "../load-env.js";
import { createDb, createPool } from "@otn/db";
import { createLogger, S3ObjectStore, s3ConfigFromEnv, sha256Hex } from "@otn/source-sdk";
import { sql } from "drizzle-orm";

/**
 * pnpm artifacts:audit — does every raw artifact the database references still
 * exist, and are its bytes the bytes we recorded?
 *
 * Why this exists: the hosted database is on Supabase, but OBJECT_STORAGE_ENDPOINT
 * still points at http://localhost:9000 — a MinIO container on one laptop. The
 * ledger is durable and replicated; the evidence it points at is not. BUILD_SPEC
 * §5 requires immutable raw storage before parsing, and `source:replay`
 * (packages/source-sdk/src/replay.ts) reads these bodies back — so a missing
 * object is not cosmetic, it silently removes the ability to reproduce a parse.
 *
 * Verification is exact and free because keys are content-addressed:
 * `raw/<sourceKey>/<sha256>`. The sha256 in the key IS the expected digest, so
 * `--deep` can prove the bytes rather than merely proving something is there.
 *
 * Mirror mode is the migration: it copies each object into a SECOND store
 * (TARGET_OBJECT_STORAGE_*) and never writes to or deletes from the source.
 * Content-addressed keys make it idempotent — re-running skips what is already
 * present with the right digest.
 *
 * Usage:
 *   pnpm artifacts:audit                 # presence only (fast)
 *   pnpm artifacts:audit --deep          # download and verify every digest
 *   pnpm artifacts:audit --mirror --deep # also copy to TARGET_OBJECT_STORAGE_*
 *   pnpm artifacts:audit --limit=50
 */
interface Row {
  id: string;
  source_key: string;
  storage_key: string;
  byte_size: number | null;
}

/** The digest embedded in a content-addressed key, or null if not that shape. */
function expectedSha(storageKey: string): string | null {
  const tail = storageKey.split("/").pop() ?? "";
  return /^[0-9a-f]{64}$/.test(tail) ? tail : null;
}

function targetConfigFromEnv() {
  const need = (n: string): string => {
    const v = process.env[n];
    if (!v) throw new Error(`${n} is not set (required for --mirror)`);
    return v;
  };
  const sessionToken = process.env["TARGET_OBJECT_STORAGE_SESSION_TOKEN"];
  return {
    endpoint: need("TARGET_OBJECT_STORAGE_ENDPOINT"),
    region: need("TARGET_OBJECT_STORAGE_REGION"),
    bucket: need("TARGET_OBJECT_STORAGE_BUCKET"),
    accessKeyId: need("TARGET_OBJECT_STORAGE_ACCESS_KEY"),
    secretAccessKey: need("TARGET_OBJECT_STORAGE_SECRET_KEY"),
    // Supabase Storage requires this; MinIO does not. See S3ObjectStoreConfig.
    ...(sessionToken ? { sessionToken } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(`--${n}`);
  const limit = Number(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0);

  const deep = flag("deep");
  const mirror = flag("mirror");
  const logger = createLogger({ app: "artifacts-audit-cli" });

  const source = new S3ObjectStore(s3ConfigFromEnv());
  const target = mirror ? new S3ObjectStore(targetConfigFromEnv()) : null;
  if (target) await target.ensureBucket();

  const pool = createPool();
  const db = createDb(pool);
  const missing: Row[] = [];
  const mismatched: Row[] = [];
  const copied: string[] = [];
  let present = 0;

  try {
    const res = await db.execute(sql`
      SELECT ra.id::text AS id, s.key AS source_key, ra.storage_key, ra.byte_size
      FROM raw_artifacts ra
      JOIN sources s ON s.id = ra.source_id
      ORDER BY ra.retrieved_at DESC
      ${limit > 0 ? sql`LIMIT ${limit}` : sql``}`);
    const rows = res.rows as unknown as Row[];
    logger.info({ artifacts: rows.length, deep, mirror }, "auditing raw artifacts");

    for (const r of rows) {
      let body: Buffer | null = null;
      try {
        if (deep || mirror) {
          body = await source.get(r.storage_key);
        } else if (!(await source.exists(r.storage_key))) {
          missing.push(r);
          continue;
        }
      } catch {
        missing.push(r);
        continue;
      }

      if (body) {
        const want = expectedSha(r.storage_key);
        // A key that is not content-addressed cannot be verified this way; treat
        // it as present rather than silently claiming it was checked.
        if (want && sha256Hex(body) !== want) {
          mismatched.push(r);
          continue;
        }
      }
      present++;

      if (target && body) {
        // putImmutable re-derives the same content-addressed key, so this is
        // idempotent and cannot overwrite different bytes under an existing key.
        const put = await target.putImmutable(r.source_key, body, "application/octet-stream");
        if (!put.alreadyExisted) copied.push(put.storageKey);
      }
    }
  } finally {
    await pool.end();
  }

  logger.info(
    {
      present,
      missing: missing.length,
      mismatched: mismatched.length,
      ...(mirror ? { copiedToTarget: copied.length } : {}),
      missingKeys: missing.slice(0, 10).map((m) => m.storage_key),
      mismatchedKeys: mismatched.slice(0, 10).map((m) => m.storage_key),
    },
    "artifact audit complete",
  );

  // A dangling reference or a digest mismatch is a data-integrity failure, not a
  // warning — the evidence chain for those records is broken.
  if (missing.length > 0 || mismatched.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
