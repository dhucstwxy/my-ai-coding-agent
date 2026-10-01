#!/usr/bin/env npx tsx
import { runCli } from "./cli.js";
import { runEvalCli } from "./eval/index.js";

async function main(): Promise<void> {
  if (process.argv[2] === "eval") {
    const code = await runEvalCli(process.argv.slice(2));
    process.exitCode = code;
    return;
  }
  await runCli();
}

main().catch((err) => {
  console.error(
    `启动失败：${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
