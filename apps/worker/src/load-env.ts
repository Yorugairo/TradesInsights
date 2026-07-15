import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env regardless of which directory the worker runs from.
const HERE = dirname(fileURLToPath(import.meta.url));
config({ path: join(HERE, "..", "..", "..", ".env") });
config();
