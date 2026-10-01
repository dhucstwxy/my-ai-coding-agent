import fs from "node:fs";
import path from "node:path";
import { runAgentOnTask } from "./agent-runner.js";
import { loadTestSet, selectTasks } from "./load-test-set.js";
import { computeMetrics } from "./metrics.js";
import { printSummary, writeReport } from "./report.js";
import type {
  EvalCliArgs,
  EvalReport,
  EvalRunContext,
  TaskRunResult,
} from "./types.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_VERIFY_TIMEOUT_MS,
} from "./types.js";
import { runVerify } from "./verify.js";
import { prepareWorkspace } from "./workspace.js";

function parseArgs(argv: string[]): EvalCliArgs {
  // argv 形如 ["eval", "--task", "id"] 或 ["--task", "id"]
  const args = argv[0] === "eval" ? argv.slice(1) : argv;
  let taskId: string | undefined;
  let agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS;
  let verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--task") {
      const v = args[++i];
      if (!v) throw new Error("--task 需要任务 ID");
      taskId = v;
      continue;
    }
    if (a === "--agent-timeout-ms") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error("--agent-timeout-ms 必须为正数");
      }
      agentTimeoutMs = v;
      continue;
    }
    if (a === "--verify-timeout-ms") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error("--verify-timeout-ms 必须为正数");
      }
      verifyTimeoutMs = v;
      continue;
    }
    if (a === "--help" || a === "-h") {
      throw new Error("HELP");
    }
    throw new Error(`未知参数：${a}`);
  }

  return { taskId, agentTimeoutMs, verifyTimeoutMs };
}

function printHelp(): void {
  console.log(`用法：
  mewcode eval [--task <id>] [--agent-timeout-ms <n>] [--verify-timeout-ms <n>]

说明：
  默认跑 tests/eval 全部题目；--task 只跑一题。
  报告写入 tests/eval/runs/<timestamp>/eval-report.json
`);
}

function makeRunDir(evalRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(evalRoot, "runs", stamp);
  fs.mkdirSync(path.join(runDir, "workspaces"), { recursive: true });
  return runDir;
}

/**
 * 评测 CLI 入口。
 * @returns 进程退出码：非法参数/加载失败=1；跑完（含题目失败）=0
 */
export async function runEvalCli(argv: string[]): Promise<number> {
  let args: EvalCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "HELP") {
      printHelp();
      return 0;
    }
    console.error(msg);
    printHelp();
    return 1;
  }

  const repoRoot = process.cwd();
  const evalRoot = path.join(repoRoot, "tests", "eval");
  let tasks;
  try {
    const set = loadTestSet(evalRoot);
    tasks = selectTasks(set, args.taskId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const runDir = makeRunDir(evalRoot);
  const ctx: EvalRunContext = { repoRoot, runDir, evalRoot, args };
  console.log(`评测运行目录：${runDir}`);
  console.log(`题目数：${tasks.length}`);

  const results: TaskRunResult[] = [];
  let providerName: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.log(`[${i + 1}/${tasks.length}] ${task.id} …`);

    let workspacePath = "";
    try {
      const prepared = await prepareWorkspace(ctx, task);
      workspacePath = prepared.workspacePath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  setup 失败：${message}`);
      results.push({
        taskId: task.id,
        category: task.category,
        difficulty: task.difficulty,
        success: false,
        latencyMs: 0,
        steps: 0,
        workspacePath,
        error: `setup_failed: ${message}`,
      });
      continue;
    }

    const promptPath = path.join(
      workspacePath,
      task.promptFile || "PROMPT.md",
    );
    const agent = await runAgentOnTask({
      workspacePath,
      promptPath,
      sessionsDir: path.join(runDir, "sessions", task.id),
      agentTimeoutMs: args.agentTimeoutMs,
      configRoot: repoRoot,
    });
    providerName ??= agent.providerName;
    model ??= agent.model;

    if (agent.error && agent.error !== "agent_timeout") {
      console.log(`  agent：${agent.error}（仍将执行验证）`);
    }

    const verify = await runVerify(
      workspacePath,
      task.verifyCommand,
      args.verifyTimeoutMs,
    );

    const success = verify.exitCode === 0;
    const errorParts: string[] = [];
    if (agent.error) errorParts.push(agent.error);
    if (verify.timedOut) errorParts.push("verify_timeout");
    else if (verify.exitCode !== 0) errorParts.push("verify_failed");

    const result: TaskRunResult = {
      taskId: task.id,
      category: task.category,
      difficulty: task.difficulty,
      success,
      latencyMs: agent.latencyMs,
      steps: agent.steps,
      workspacePath,
      agentStopReason: agent.stopReason,
      verifyExitCode: verify.exitCode,
      error: errorParts.length > 0 ? errorParts.join("; ") : undefined,
    };
    results.push(result);
    console.log(
      `  → ${success ? "PASS" : "FAIL"} steps=${agent.steps} latencyMs=${agent.latencyMs}`,
    );
  }

  const report: EvalReport = {
    version: 1,
    createdAt: new Date().toISOString(),
    providerName,
    model,
    tasks: results,
    metrics: computeMetrics(results),
  };
  const reportPath = writeReport(runDir, report);
  printSummary(report);
  console.log(`报告：${reportPath}`);
  return 0;
}
