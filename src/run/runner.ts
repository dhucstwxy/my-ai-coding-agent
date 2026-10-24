import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentLoop } from "../agent/loop.js";
import { createCancelToken, type CancelToken } from "../agent/cancel.js";
import { DEFAULT_AGENT_OPTIONS, type AgentEvent } from "../agent/types.js";
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
  /** 继续已有会话。不传则新建。只允许安全文件名，避免路径穿越 */
  sessionId?: string;
  /** 外部取消令牌。未传则内部创建；超时也会取消这枚令牌 */
  cancel?: CancelToken;
  /** 每个 Agent 事件（文本增量、工具开始/结束等） */
  onEvent?: (event: AgentEvent) => void;
  /** 会话已打开、尚未进入循环。用于把 sessionId 提前交给服务端 */
  onSession?: (sessionId: string) => void;
  /**
   * 为真时不再把 prompt 写入会话。
   * 服务重启后续跑已提交过的用户消息时使用。
   */
  resume?: boolean;
  /** 进度日志，默认写 stderr */
  log?: (line: string) => void;
}

/** 会话 ID 会拼进文件名，拒绝路径分隔和 `..` */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

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
    return finish(failed(baseReport(), startedMs, "prompt 为空"), 1);
  }

  if (
    opts.sessionId &&
    (!SESSION_ID_PATTERN.test(opts.sessionId) || opts.sessionId.includes(".."))
  ) {
    return finish(failed(baseReport(), startedMs, "sessionId 不合法"), 1);
  }

  if (!fs.existsSync(opts.workspace) || !fs.statSync(opts.workspace).isDirectory()) {
    return finish(
      failed(baseReport(), startedMs, `工作区不存在：${opts.workspace}`),
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
  const session = opts.sessionId
    ? store.open(opts.sessionId)
    : store.create(`run-${runId.slice(0, 8)}`);
  if (!session) {
    return finish(
      failed(
        {
          ...baseReport(),
          providerName: active.name,
          model: active.model,
        },
        startedMs,
        `会话不存在：${opts.sessionId}`,
      ),
      1,
    );
  }
  permissionModes.set(session.id, "allow");
  try {
    opts.onSession?.(session.id);
  } catch (err) {
    log(
      `[run] onSession 失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const loop = new AgentLoop(
    store,
    provider,
    active,
    registry,
    opts.workspace,
    gate,
    DEFAULT_AGENT_OPTIONS,
  );

  const cancel = opts.cancel ?? createCancelToken();
  const tools: RunToolRecord[] = [];
  const toolStartedAt = new Map<string, number>();
  let steps = 0;
  let stopReason: string | undefined;
  let runError: string | undefined;
  let finalMessage = "";

  log(`[run] ${runId} workspace=${opts.workspace}`);
  log(`[run] provider=${active.name} model=${active.model}`);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log(`[run] timeout ${opts.timeoutMs}ms，取消中…`);
    cancel.cancel();
  }, opts.timeoutMs);

  try {
    for await (const event of loop.run(session.id, opts.prompt, {
      cancel,
      mode: "execute",
      skipMemoryUpdate: true,
      skipUserAppend: opts.resume === true,
    })) {
      try {
        opts.onEvent?.(event);
      } catch (err) {
        log(
          `[run] onEvent 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
  if (timedOut) {
    runError = "agent_timeout";
    stopReason = "cancelled";
  } else if (cancel.isCancelled && !runError) {
    runError = "已取消";
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

function failed(
  base: Omit<
    RunReport,
    "endedAt" | "exitCode" | "steps" | "latencyMs" | "finalMessage" | "tools" | "error"
  >,
  startedMs: number,
  error: string,
): RunReport {
  return {
    ...base,
    endedAt: new Date().toISOString(),
    exitCode: 1,
    steps: 0,
    latencyMs: Date.now() - startedMs,
    finalMessage: "",
    tools: [],
    error,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
