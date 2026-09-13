import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider } from "../provider/types.js";
import type { SessionStore } from "../session/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AgentLoop } from "../agent/loop.js";
import { createCancelToken, type CancelToken } from "../agent/cancel.js";
import { PlanModeStore } from "../agent/plan-mode.js";
import type { AgentEvent, AgentLoopOptions } from "../agent/types.js";
import { DEFAULT_AGENT_OPTIONS } from "../agent/types.js";

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
    options: AgentLoopOptions = DEFAULT_AGENT_OPTIONS,
  ) {
    this.loop = new AgentLoop(
      store,
      provider,
      providerConfig,
      registry,
      workspaceRoot,
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

  async *send(
    sessionId: string,
    userText: string,
  ): AsyncIterable<AgentEvent> {
    const trimmed = userText.trim();
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
