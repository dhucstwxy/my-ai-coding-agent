import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = { timeoutMs: number; retries: number };

const root = join(dirname(fileURLToPath(import.meta.url)));

function readJson(rel: string): AppConfig {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as AppConfig;
}

/** 合并顺序：defaults <- env <- local（后者覆盖前者） */
export function loadConfig(): AppConfig {
  const defaults = readJson("config/defaults.json");
  const env = readJson("config/env.json");
  const local = readJson("config/local.json");
  return { ...defaults, ...env, ...local };
}
