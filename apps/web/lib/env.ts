import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Next.js only auto-loads .env files from the app directory; this repo keeps
// one .env at the workspace root (same convention as apps/worker).
const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "..", "..", "..", ".env") });
config();

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
