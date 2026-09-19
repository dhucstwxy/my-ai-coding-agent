import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider } from "../provider/types.js";
import type { SessionStore } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AgentLoop } from "../agent/loop.js";
import { createCancelToken, type CancelToken } from "../agent/cancel.js";
import { PlanModeStore } from "../agent/plan-mode.js";
import type { AgentEvent, AgentLoopOptions } from "../agent/types.js";
import { DEFAULT_AGENT_OPTIONS } from "../agent/types.js";
import type { PermissionGate } from "../permission/gate.js";
import type { PermissionModeStore } from "../permission/mode-store.js";
import type { PermissionMode, PermissionPrompter } from "../permission/types.js";

/**
 * 对话门面：斜杠命令 + Agent Loop + 取消令牌。
 */
export class ChatService {
  private readonly planModes = new PlanModeStore();
  private readonly loop: AgentLoop;
  private currentCancel: CancelToken | null = null;

  constructor(
    private readonly store: SessionStore,
    provider: ChatProvider,
    providerConfig: ProviderConfig,
    registry: ToolRegistry,
    workspaceRoot: string,
    private readonly gate: PermissionGate,
    private readonly permissionModes: PermissionModeStore,
    options: AgentLoopOptions = DEFAULT_AGENT_OPTIONS,
  ) {
    this.loop = new AgentLoop(
      store,
      provider,
      providerConfig,
      registry,
      workspaceRoot,
      gate,
      options,
    );
  }

  /** 取消当前正在进行的 Agent 循环 */
  cancelCurrent(): void {
    this.currentCancel?.cancel();
  }

  getMode(sessionId: string) {
    return this.planModes.getMode(sessionId);
  }

  getPermissionMode(sessionId: string): PermissionMode {
    return this.permissionModes.get(sessionId);
  }

  /** TUI 挂载后换成真正的确认器。未绑定前闸门会拒绝询问。 */
  attachPrompter(prompter: PermissionPrompter): void {
    this.gate.setPrompter(prompter);
  }

  async *send(
    sessionId: string,
    userText: string,
  ): AsyncIterable<AgentEvent> {
    const trimmed = userText.trim();
    const perm = parsePerm(trimmed);
    if (perm) {
      this.permissionModes.set(sessionId, perm.mode);
      yield { type: "permission_mode_changed", mode: perm.mode };
      const permLabel = permissionLabel(perm.mode);
      if (!perm.rest) {
        yield {
          type: "text_delta",
          text: `已切换为${permLabel}。`,
        };
        yield {
          type: "agent_stopped",
          reason: "completed",
          message: `已切换为${permLabel}`,
        };
        yield { type: "done" };
        return;
      }
      yield* this.runLoop(sessionId, perm.rest);
      return;
    }

    const slash = parseSlash(trimmed);

    if (slash) {
      this.planModes.setMode(sessionId, slash.mode);
      yield { type: "mode_changed", mode: slash.mode };
      const modeLabel = slash.mode === "plan" ? "计划模式" : "执行模式";
      if (!slash.rest) {
        yield {
          type: "text_delta",
          text: `已切换为${modeLabel}。${
            slash.mode === "plan"
              ? "当前仅开放只读工具（read_file / glob_files / grep_search）。"
              : "已恢复全部工具。"
          }`,
        };
        yield {
          type: "agent_stopped",
          reason: "completed",
          message: `已切换为${modeLabel}`,
        };
        yield { type: "done" };
        return;
      }
      // 有任务正文：不把斜杠命令写入用户消息，只写 rest
      yield* this.runLoop(sessionId, slash.rest);
      return;
    }

    yield* this.runLoop(sessionId, trimmed);
  }

  private async *runLoop(
    sessionId: string,
    userText: string,
  ): AsyncIterable<AgentEvent> {
    const cancel = createCancelToken();
    this.currentCancel = cancel;
    const mode = this.planModes.getMode(sessionId);
    try {
      yield* this.loop.run(sessionId, userText, { cancel, mode });
    } finally {
      if (this.currentCancel === cancel) {
        this.currentCancel = null;
      }
    }
  }
}

function parseSlash(
  text: string,
): { mode: "plan" | "execute"; rest: string } | null {
  if (text === "/plan" || text.startsWith("/plan ")) {
    return {
      mode: "plan",
      rest: text === "/plan" ? "" : text.slice("/plan ".length).trim(),
    };
  }
  if (text === "/do" || text.startsWith("/do ")) {
    return {
      mode: "execute",
      rest: text === "/do" ? "" : text.slice("/do ".length).trim(),
    };
  }
  return null;
}

function parsePerm(
  text: string,
): { mode: PermissionMode; rest: string } | null {
  const matched = /^\/perm\s+(strict|default|allow)(?:\s+([\s\S]*))?$/.exec(text);
  if (!matched) return null;
  return {
    mode: matched[1] as PermissionMode,
    rest: (matched[2] ?? "").trim(),
  };
}

function permissionLabel(mode: PermissionMode): string {
  if (mode === "strict") return "严格档";
  if (mode === "allow") return "放行档";
  return "默认档";
}
