import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env regardless of which package the script runs from.
const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "..", "..", "..", ".env") });
config(); // also honor a package-local .env / real env vars
