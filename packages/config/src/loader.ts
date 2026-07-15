import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  SourcesFileSchema,
  type SourceConfig,
  type SourcesFile,
} from "./sources-config.js";
import {
  AccountProfilesFileSchema,
  type AccountProfilesFile,
} from "./account-config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = join(HERE, "..", "..", "..", "config");

export function loadSourcesConfig(configDir = DEFAULT_CONFIG_DIR): SourcesFile {
  const raw = readFileSync(join(configDir, "sources.yaml"), "utf8");
  return SourcesFileSchema.parse(parse(raw));
}

export function loadAccountProfiles(
  configDir = DEFAULT_CONFIG_DIR,
): AccountProfilesFile {
  const raw = readFileSync(join(configDir, "account-profiles.yaml"), "utf8");
  return AccountProfilesFileSchema.parse(parse(raw));
}

export function getSourceConfig(
  key: string,
  configDir = DEFAULT_CONFIG_DIR,
): SourceConfig {
  const file = loadSourcesConfig(configDir);
  const source = file.sources.find((s) => s.key === key);
  if (!source) throw new Error(`unknown source key: ${key}`);
  return source;
}
