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

export interface AgentRunOutcome {
  steps: number;
  latencyMs: number;
  stopReason?: string;
  error?: string;
  providerName?: string;
  model?: string;
}

export interface AgentRunnerOptions {
  workspacePath: string;
  promptPath: string;
  sessionsDir: string;
  agentTimeoutMs: number;
  /** 配置加载用的仓库根（含 .mewcode） */
  configRoot: string;
}

/**
 * 在隔离工作区 headless 跑一轮 Agent（权限 allow 档，不挂 MCP/Team/Hooks）。
 */
export async function runAgentOnTask(
  opts: AgentRunnerOptions,
): Promise<AgentRunOutcome> {
  const prompt = fs.readFileSync(opts.promptPath, "utf8").trim();
  if (!prompt) {
    return {
      steps: 0,
      latencyMs: 0,
      error: "PROMPT.md 为空",
    };
  }

  let loaded;
  try {
    loaded = loadConfig(opts.configRoot);
  } catch (err) {
    return {
      steps: 0,
      latencyMs: 0,
      error: `配置加载失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const active = loaded.config.providers.find(
    (p) => p.name === loaded.config.activeProvider,
  );
  if (!active) {
    return {
      steps: 0,
      latencyMs: 0,
      error: "找不到当前供应商配置",
    };
  }

  const provider = createProvider(active);
  const registry = createDefaultRegistry();
  const permissionModes = new PermissionModeStore();
  const grants = new SessionGrantStore();
  const gate = new PermissionGate({
    rules: [],
    modeStore: permissionModes,
    grants,
    workspaceRoot: opts.workspacePath,
    prompter: {
      async ask() {
        return "deny";
      },
    },
  });

  fs.mkdirSync(opts.sessionsDir, { recursive: true });
  const store = new SessionStore(opts.sessionsDir);
  const session = store.create(`eval-${path.basename(opts.workspacePath)}`);
  permissionModes.set(session.id, "allow");

  const loop = new AgentLoop(
    store,
    provider,
    active,
    registry,
    opts.workspacePath,
    gate,
    DEFAULT_AGENT_OPTIONS,
  );

  const cancel = createCancelToken();
  let steps = 0;
  let stopReason: string | undefined;
  let runError: string | undefined;
  const started = Date.now();

  const timer = setTimeout(() => {
    cancel.cancel();
  }, opts.agentTimeoutMs);

  try {
    for await (const event of loop.run(session.id, prompt, {
      cancel,
      mode: "execute",
      skipMemoryUpdate: true,
    })) {
      if (event.type === "agent_progress") {
        if (event.iteration > steps) steps = event.iteration;
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

  const latencyMs = Date.now() - started;
  if (cancel.isCancelled && !runError) {
    runError = "agent_timeout";
  }

  return {
    steps,
    latencyMs,
    stopReason,
    error: runError,
    providerName: active.name,
    model: active.model,
  };
}
