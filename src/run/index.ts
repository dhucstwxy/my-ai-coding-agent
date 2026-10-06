import fs from "node:fs";
import path from "node:path";
import { runHeadless } from "./runner.js";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type RunCliArgs,
  type RunReport,
} from "./types.js";

function printHelp(): void {
  console.log(`用法：
  mewcode run --prompt <文本>
  mewcode run --prompt-file <路径>
  mewcode run --prompt-file PROMPT.md --workspace <目录> --out result.json

选项：
  --prompt <文本>         直接传入任务说明
  --prompt-file <路径>    从文件读取任务说明（相对 --workspace）
  --workspace <目录>      工作区根目录，默认当前目录
  --out <路径>            写入 result.json；默认 <workspace>/.mewcode/runs/<时间戳>/result.json
  --timeout-ms <n>        超时毫秒，默认 ${DEFAULT_RUN_TIMEOUT_MS}
  -h, --help              显示帮助

退出码：
  0  Agent 正常完成（stopReason=completed）
  1  参数 / 配置 / prompt 错误
  2  Agent 失败、超时或未正常完成

说明：
  无 TUI；权限模式为 allow。密钥可用 MEWCODE_API_KEY 注入。
`);
}

function parseArgs(argv: string[]): RunCliArgs {
  const args = argv[0] === "run" ? argv.slice(1) : argv;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let workspace = process.cwd();
  let outPath: string | undefined;
  let timeoutMs = DEFAULT_RUN_TIMEOUT_MS;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--prompt") {
      const v = args[++i];
      if (!v) throw new Error("--prompt 需要文本");
      prompt = v;
      continue;
    }
    if (a === "--prompt-file") {
      const v = args[++i];
      if (!v) throw new Error("--prompt-file 需要路径");
      promptFile = v;
      continue;
    }
    if (a === "--workspace") {
      const v = args[++i];
      if (!v) throw new Error("--workspace 需要路径");
      workspace = path.resolve(v);
      continue;
    }
    if (a === "--out") {
      const v = args[++i];
      if (!v) throw new Error("--out 需要路径");
      outPath = path.resolve(v);
      continue;
    }
    if (a === "--timeout-ms") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error("--timeout-ms 必须为正数");
      }
      timeoutMs = v;
      continue;
    }
    throw new Error(`未知参数：${a}`);
  }

  return { prompt, promptFile, workspace, outPath, timeoutMs, help };
}

function resolvePrompt(
  args: RunCliArgs,
): { prompt: string; source: "arg" | "file" } {
  if (args.prompt && args.promptFile) {
    throw new Error("不能同时使用 --prompt 与 --prompt-file");
  }
  if (args.prompt) {
    return { prompt: args.prompt, source: "arg" };
  }
  if (args.promptFile) {
    const filePath = path.isAbsolute(args.promptFile)
      ? args.promptFile
      : path.join(args.workspace, args.promptFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`prompt 文件不存在：${filePath}`);
    }
    return {
      prompt: fs.readFileSync(filePath, "utf8"),
      source: "file",
    };
  }
  throw new Error("请提供 --prompt 或 --prompt-file");
}

function defaultOutPath(workspace: string): {
  outPath: string;
  sessionsDir: string;
} {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(workspace, ".mewcode", "runs", stamp);
  fs.mkdirSync(runDir, { recursive: true });
  return {
    outPath: path.join(runDir, "result.json"),
    sessionsDir: path.join(runDir, "sessions"),
  };
}

function writeReport(outPath: string, report: RunReport): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/**
 * 无头 run CLI。
 * @returns 进程退出码
 */
export async function runRunCli(argv: string[]): Promise<number> {
  let args: RunCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    return 1;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  let promptInfo;
  try {
    promptInfo = resolvePrompt(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printHelp();
    return 1;
  }

  const defaults = args.outPath
    ? {
        outPath: args.outPath,
        sessionsDir: path.join(
          path.dirname(args.outPath),
          "sessions",
        ),
      }
    : defaultOutPath(args.workspace);

  const { report, exitCode } = await runHeadless({
    workspace: args.workspace,
    prompt: promptInfo.prompt,
    promptSource: promptInfo.source,
    configRoot: args.workspace,
    sessionsDir: defaults.sessionsDir,
    timeoutMs: args.timeoutMs,
  });

  writeReport(defaults.outPath, report);
  console.log(`报告：${defaults.outPath}`);
  if (report.error) {
    console.error(`错误：${report.error}`);
  } else if (report.finalMessage) {
    console.log("--- 最终回复 ---");
    console.log(report.finalMessage);
  }
  return exitCode;
}
