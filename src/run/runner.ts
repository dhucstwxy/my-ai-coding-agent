import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentLoop } from "../agent/loop.js";
import { createCancelToken } from "../agent/cancel.js";
import { DEFAULT_AGENT_OPTIONS } from "../agent/types.js";
import { loadConfig } from "../config/load.js";
import { PermissionGate } from "../permission/gate.js";
import { PermissionModeStore } from "../permission/mode-store.js";
import { SessionGrantStore } from "../permission/session-grants.js";
import { createProvider } from "../provider/factory.js";
import { SessionStore } from "../session/store.js";
import { createDefaultRegistry } from "../tools/create-registry.js";
import type { RunReport, RunToolRecord } from "./types.js";

export interface HeadlessRunOptions {
  workspace: string;
  prompt: string;
  promptSource: "arg" | "file";
  /** 配置加载根目录；默认与 workspace 相同 */
  configRoot?: string;
  sessionsDir: string;
  timeoutMs: number;
  /** 进度日志，默认写 stderr */
  log?: (line: string) => void;
}

export interface HeadlessRunResult {
  report: RunReport;
  exitCode: number;
}

/**
 * 无界面跑一轮 Agent：权限 allow，不挂 MCP/Team/Hooks/TUI。
 */
export async function runHeadless(
  opts: HeadlessRunOptions,
): Promise<HeadlessRunResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const configRoot = opts.configRoot ?? opts.workspace;

  const baseReport = (): Omit<
    RunReport,
    "endedAt" | "exitCode" | "steps" | "latencyMs" | "finalMessage" | "tools" | "error"
  > => ({
    version: 1,
    runId,
    startedAt,
    workspace: opts.workspace,
    prompt: opts.prompt,
    promptSource: opts.promptSource,
  });

  if (!opts.prompt.trim()) {
    return finish(
      {
        ...baseReport(),
        endedAt: new Date().toISOString(),
        exitCode: 1,
        steps: 0,
        latencyMs: 0,
        finalMessage: "",
        tools: [],
        error: "prompt 为空",
      },
      1,
    );
  }

  let loaded;
  try {
    loaded = loadConfig(configRoot);
  } catch (err) {
    return finish(
      {
        ...baseReport(),
        endedAt: new Date().toISOString(),
        exitCode: 1,
        steps: 0,
        latencyMs: Date.now() - startedMs,
        finalMessage: "",
        tools: [],
        error: `配置加载失败：${err instanceof Error ? err.message : String(err)}`,
      },
      1,
    );
  }

  const active = loaded.config.providers.find(
    (p) => p.name === loaded.config.activeProvider,
  );
  if (!active) {
    return finish(
      {
        ...baseReport(),
        endedAt: new Date().toISOString(),
        exitCode: 1,
        steps: 0,
        latencyMs: Date.now() - startedMs,
        finalMessage: "",
        tools: [],
        error: "找不到当前供应商配置",
      },
      1,
    );
  }

  const provider = createProvider(active);
  const registry = createDefaultRegistry();
  const permissionModes = new PermissionModeStore();
  const grants = new SessionGrantStore();
  const gate = new PermissionGate({
    rules: [],
    modeStore: permissionModes,
    grants,
    workspaceRoot: opts.workspace,
    prompter: {
      async ask() {
        return "deny";
      },
    },
  });

  fs.mkdirSync(opts.sessionsDir, { recursive: true });
  const store = new SessionStore(opts.sessionsDir);
  const session = store.create(`run-${runId.slice(0, 8)}`);
  permissionModes.set(session.id, "allow");

  const loop = new AgentLoop(
    store,
    provider,
    active,
    registry,
    opts.workspace,
    gate,
    DEFAULT_AGENT_OPTIONS,
  );

  const cancel = createCancelToken();
  const tools: RunToolRecord[] = [];
  const toolStartedAt = new Map<string, number>();
  let steps = 0;
  let stopReason: string | undefined;
  let runError: string | undefined;
  let finalMessage = "";

  log(`[run] ${runId} workspace=${opts.workspace}`);
  log(`[run] provider=${active.name} model=${active.model}`);

  const timer = setTimeout(() => {
    log(`[run] timeout ${opts.timeoutMs}ms，取消中…`);
    cancel.cancel();
  }, opts.timeoutMs);

  try {
    for await (const event of loop.run(session.id, opts.prompt, {
      cancel,
      mode: "execute",
      skipMemoryUpdate: true,
    })) {
      if (event.type === "text_delta") {
        finalMessage += event.text;
      }
      if (event.type === "agent_progress") {
        if (event.iteration > steps) {
          steps = event.iteration;
          log(`[run] step ${event.iteration}/${event.maxIterations}`);
        }
      }
      if (event.type === "tool_execution_start") {
        toolStartedAt.set(event.id, Date.now());
        log(`[run] tool start ${event.name}`);
      }
      if (event.type === "tool_execution_end") {
        const t0 = toolStartedAt.get(event.id) ?? Date.now();
        const ms = Date.now() - t0;
        tools.push({
          id: event.id,
          name: event.name,
          ok: event.ok,
          ms,
          summary: truncate(event.resultSummary, 200),
        });
        log(`[run] tool end ${event.name} ok=${event.ok} ${ms}ms`);
      }
      if (event.type === "agent_stopped") {
        stopReason = event.reason;
        if (event.reason === "error" || event.reason === "cancelled") {
          runError = event.message;
        }
      }
      if (event.type === "error") {
        runError = event.message;
      }
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - startedMs;
  if (cancel.isCancelled && !runError) {
    runError = "agent_timeout";
    stopReason ??= "cancelled";
  }

  const sessionPath = path.join(opts.sessionsDir, `${session.id}.jsonl`);
  const ok = !runError && stopReason === "completed";
  const exitCode = ok ? 0 : 2;

  const report: RunReport = {
    ...baseReport(),
    endedAt: new Date().toISOString(),
    exitCode,
    providerName: active.name,
    model: active.model,
    steps,
    latencyMs,
    stopReason,
    finalMessage: finalMessage.trim(),
    tools,
    sessionId: session.id,
    sessionPath: fs.existsSync(sessionPath) ? sessionPath : undefined,
    error: runError ?? null,
  };

  log(`[run] done exit=${exitCode} steps=${steps} latencyMs=${latencyMs}`);
  return finish(report, exitCode);
}

function finish(report: RunReport, exitCode: number): HeadlessRunResult {
  return { report, exitCode };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
