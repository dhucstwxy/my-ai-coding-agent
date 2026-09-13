#!/usr/bin/env npx tsx
import { runCli } from "./cli.js";

runCli().catch((err) => {
  console.error(
    `启动失败：${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
