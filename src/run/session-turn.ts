import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../agent/loop.js";
import { createCancelToken, type CancelToken } from "../agent/cancel.js";
import { DEFAULT_AGENT_OPTIONS, type AgentEvent } from "../agent/types.js";
import { loadConfig } from "../config/load.js";
import { HookEngine } from "../hooks/engine.js";
import { loadHooks } from "../hooks/load.js";
import { createHookSessions } from "../hooks/session.js";
import { HookSessionState } from "../hooks/state.js";
import { HookFatalError } from "../hooks/types.js";
import { connectMcpServers } from "../mcp/register.js";
import { PermissionGate } from "../permission/gate.js";
import { loadPermissionRules } from "../permission/load.js";
import { PermissionModeStore } from "../permission/mode-store.js";
import { SessionGrantStore } from "../permission/session-grants.js";
import type { PermissionChoice } from "../permission/types.js";
import { createProvider } from "../provider/factory.js";
import type { ChatProvider } from "../provider/types.js";
import type { ProviderConfig } from "../config/types.js";
import { SessionStore } from "../session/store.js";
import { SkillCatalog } from "../skills/catalog.js";
import { createLoadSkillTool } from "../skills/load-tool.js";
import { SkillSession } from "../skills/session.js";
import { visibleToolNames } from "../skills/tools-view.js";
import { SkillFatalError } from "../skills/types.js";
import { createDefaultRegistry } from "../tools/create-registry.js";
import type { HeadlessRunResult } from "./runner.js";
import type { RunReport, RunToolRecord } from "./types.js";

/** 一次审批的展示。pending 只有询问，结束时带上用户的选择。 */
export interface ApprovalNotice {
  approvalId: string;
  status: "pending" | "allowed" | "denied";
  tool: string;
  subject: string;
  argsSummary: string;
  choice?: PermissionChoice;
}

export interface SessionTurnOptions {
  workspace: string;
  prompt: string;
  promptSource?: "arg" | "file";
  sessionsDir: string;
  timeoutMs: number;
  sessionId?: string;
  cancel?: CancelToken;
  resume?: boolean;
  /** 执行进程里跨轮共享。本会话放行记在这里，不写入会话文件。 */
  grants: SessionGrantStore;
  onEvent?: (event: AgentEvent) => void;
  onSession?: (sessionId: string) => void;
  onWarning?: (message: string) => void;
  onApproval?: (notice: ApprovalNotice) => void;
  /** 暂停到用户选择，或取消令牌触发后返回 deny。 */
  awaitChoice: (
    notice: ApprovalNotice,
    signal: CancelToken,
  ) => Promise<PermissionChoice>;
  log?: (line: string) => void;
  /** 测试注入供应商。正式路径不传，仍从工作区配置加载。 */
  provider?: ChatProvider;
  providerConfig?: ProviderConfig;
  /** 测试把用户级配置指到空目录。正式路径用当前用户家目录。 */
  homeDir?: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * 会话里的一轮：默认权限档，挂上技能、MCP 和钩子。
 * 有副作用的工具会停下来等审批。一轮结束就断开 MCP。
 */
export async function runSessionTurn(
  opts: SessionTurnOptions,
): Promise<HeadlessRunResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const warn = (message: string) => {
    try {
      opts.onWarning?.(message);
    } catch (err) {
      log(`[session] 警告回调失败：${messageOf(err)}`);
    }
  };
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const home = opts.homeDir ?? os.homedir();

  const baseReport = (): Omit<
    RunReport,
    "endedAt" | "exitCode" | "steps" | "latencyMs" | "finalMessage" | "tools" | "error"
  > => ({
    version: 1,
    runId,
    startedAt,
    workspace: opts.workspace,
    prompt: opts.prompt,
    promptSource: opts.promptSource ?? "arg",
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

  let active = opts.providerConfig;
  let provider = opts.provider;
  if (!active || !provider) {
    let loaded;
    try {
      loaded = loadConfig(opts.workspace);
    } catch (err) {
      return finish(
        failed(baseReport(), startedMs, `配置加载失败：${messageOf(err)}`),
        1,
      );
    }
    active = loaded.config.providers.find(
      (item) => item.name === loaded.config.activeProvider,
    );
    if (!active) {
      return finish(failed(baseReport(), startedMs, "找不到当前供应商配置"), 1);
    }
    provider = createProvider(active);
  }

  const registry = createDefaultRegistry();
  const skillCatalog = new SkillCatalog(opts.workspace, home);
  const skillSession = new SkillSession();
  registry.register(
    createLoadSkillTool({
      catalog: skillCatalog,
      session: skillSession,
      run: {
        session: skillSession,
        submitToAgent: async () => {},
        runIsolated: async () => "这一轮没有独立技能执行器",
        findModel: (model) => model === active.model,
        recentMessages: () => [],
        appendSummary: () => {},
      },
    }),
  );

  let closeMcp: () => Promise<void> = async () => {};
  try {
    const mcp = await connectMcpServers(opts.workspace, registry, {
      user: path.join(home, ".mewcode", "config.yaml"),
      project: path.join(opts.workspace, ".mewcode", "config.yaml"),
    });
    closeMcp = mcp.close;
    for (const message of mcp.warnings) warn(message);
  } catch (err) {
    warn(`MCP 连接失败：${messageOf(err)}`);
  }

  try {
    skillCatalog.refresh(new Set(registry.list().map((tool) => tool.name)));
    for (const item of skillCatalog.warnings()) {
      warn(`技能加载警告：${item.reason}`);
    }
  } catch (err) {
    const detail =
      err instanceof SkillFatalError ? err.message : messageOf(err);
    warn(`技能加载失败：${detail}`);
  }

  let hookRules: ReturnType<typeof loadHooks> = [];
  try {
    hookRules = loadHooks(opts.workspace, { homeDir: home });
  } catch (err) {
    const detail =
      err instanceof HookFatalError ? err.message : messageOf(err);
    warn(`钩子加载失败：${detail}`);
    hookRules = [];
  }

  const permission = loadPermissionRules(opts.workspace);
  for (const message of permission.warnings) warn(message);

  const permissionModes = new PermissionModeStore();
  const gate = new PermissionGate({
    rules: permission.rules,
    modeStore: permissionModes,
    grants: opts.grants,
    workspaceRoot: opts.workspace,
    prompter: {
      async ask(prompt, signal) {
        if (signal.isCancelled) return "deny";
        const notice: ApprovalNotice = {
          approvalId: randomUUID(),
          status: "pending",
          tool: prompt.tool,
          subject: prompt.subject,
          argsSummary: redactSummary(prompt.argsSummary),
        };
        opts.onApproval?.(notice);
        let choice: PermissionChoice = "deny";
        try {
          choice = await opts.awaitChoice(notice, signal);
        } catch (err) {
          warn(`审批失败：${messageOf(err)}`);
          choice = "deny";
        }
        if (signal.isCancelled) choice = "deny";
        opts.onApproval?.({
          ...notice,
          status: choice === "deny" ? "denied" : "allowed",
          choice,
        });
        return choice;
      },
    },
  });

  fs.mkdirSync(opts.sessionsDir, { recursive: true });
  const store = new SessionStore(opts.sessionsDir);
  const session = opts.sessionId
    ? store.open(opts.sessionId)
    : store.create(`run-${runId.slice(0, 8)}`);
  if (!session) {
    await closeMcp().catch((err: unknown) => {
      warn(`关闭 MCP 失败：${messageOf(err)}`);
    });
    return finish(
      failed(
        { ...baseReport(), providerName: active.name, model: active.model },
        startedMs,
        `会话不存在：${opts.sessionId}`,
      ),
      1,
    );
  }
  permissionModes.set(session.id, "default");
  try {
    opts.onSession?.(session.id);
  } catch (err) {
    log(`[session] onSession 失败：${messageOf(err)}`);
  }

  const hookState = new HookSessionState();
  const hookEngine = new HookEngine(hookRules, hookState, opts.workspace, log);
  const sessionHooks = createHookSessions(hookEngine, hookState);
  store.setOnMessage((id, message) => {
    const event =
      message.role === "user"
        ? "user_message"
        : message.role === "assistant"
          ? "assistant_message"
          : null;
    if (!event) return;
    void hookEngine.dispatch({ event, sessionId: id }).catch((err: unknown) => {
      warn(`钩子执行失败：${messageOf(err)}`);
    });
  });

  const loop = new AgentLoop(
    store,
    provider,
    active,
    registry,
    opts.workspace,
    gate,
    DEFAULT_AGENT_OPTIONS,
  );
  loop.setHooks(hookEngine, hookState);
  loop.setSkillContext({
    pinnedText: (sessionId) => skillSession.pinnedText(sessionId, skillCatalog),
    catalogText: () => skillCatalog.catalogText(),
    visibleNames: (sessionId, mode) =>
      visibleToolNames({
        allNames: registry.list().map((tool) => tool.name),
        planMode: mode,
        active: skillSession.recordsFor(sessionId, skillCatalog),
      }),
    resolveModel: () => ({ provider, config: active }),
  });

  const cancel = opts.cancel ?? createCancelToken();
  const tools: RunToolRecord[] = [];
  const toolStartedAt = new Map<string, number>();
  let steps = 0;
  let stopReason: string | undefined;
  let runError: string | undefined;
  let finalMessage = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log(`[session] timeout ${opts.timeoutMs}ms，取消中…`);
    cancel.cancel();
  }, opts.timeoutMs);

  try {
    await sessionHooks.enter(session.id);
    for await (const event of loop.run(session.id, opts.prompt, {
      cancel,
      mode: "execute",
      skipMemoryUpdate: true,
      skipUserAppend: opts.resume === true,
    })) {
      try {
        opts.onEvent?.(event);
      } catch (err) {
        log(`[session] onEvent 失败：${messageOf(err)}`);
      }
      if (event.type === "text_delta") finalMessage += event.text;
      if (event.type === "agent_progress" && event.iteration > steps) {
        steps = event.iteration;
      }
      if (event.type === "tool_execution_start") {
        toolStartedAt.set(event.id, Date.now());
      }
      if (event.type === "tool_execution_end") {
        const started = toolStartedAt.get(event.id) ?? Date.now();
        tools.push({
          id: event.id,
          name: event.name,
          ok: event.ok,
          ms: Date.now() - started,
          summary: truncate(event.resultSummary, 200),
        });
      }
      if (event.type === "agent_stopped") {
        stopReason = event.reason;
        if (event.reason === "error" || event.reason === "cancelled") {
          runError = event.message;
        }
      }
      if (event.type === "error") runError = event.message;
    }
  } catch (err) {
    runError = messageOf(err);
  } finally {
    clearTimeout(timer);
    await sessionHooks.leave(session.id).catch((err: unknown) => {
      warn(`结束钩子失败：${messageOf(err)}`);
    });
    await closeMcp().catch((err: unknown) => {
      warn(`关闭 MCP 失败：${messageOf(err)}`);
    });
  }

  if (timedOut) {
    runError = "agent_timeout";
    stopReason = "cancelled";
  } else if (cancel.isCancelled && !runError) {
    runError = "已取消";
    stopReason ??= "cancelled";
  }

  const sessionPath = path.join(opts.sessionsDir, `${session.id}.jsonl`);
  const ok = !runError && stopReason === "completed";
  const report: RunReport = {
    ...baseReport(),
    endedAt: new Date().toISOString(),
    exitCode: ok ? 0 : 2,
    providerName: active.name,
    model: active.model,
    steps,
    latencyMs: Date.now() - startedMs,
    stopReason,
    finalMessage: finalMessage.trim(),
    tools,
    sessionId: session.id,
    sessionPath: fs.existsSync(sessionPath) ? sessionPath : undefined,
    error: runError ?? null,
  };
  return finish(report, report.exitCode);
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 审批摘要里不带密钥和连接环境。 */
function redactSummary(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(
      /("(?:api[_-]?key|authorization|token|password|secret)"\s*:\s*")[^"]*"/gi,
      '$1***"',
    );
}
