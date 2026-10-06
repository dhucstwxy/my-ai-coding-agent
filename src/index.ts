#!/usr/bin/env node
import { runCli } from "./cli.js";
import { runEvalCli } from "./eval/index.js";
import { runRunCli } from "./run/index.js";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "eval") {
    const code = await runEvalCli(process.argv.slice(2));
    process.exitCode = code;
    return;
  }
  if (cmd === "run") {
    const code = await runRunCli(process.argv.slice(2));
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
