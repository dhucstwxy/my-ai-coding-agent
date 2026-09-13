import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider } from "../provider/types.js";
import type { SessionStore } from "../session/store.js";
import type { ToolCallRecord } from "../session/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CancelToken } from "./cancel.js";
import { collectStream } from "./collector.js";
import { filterToolsForMode } from "./plan-mode.js";
import { executeToolBatch } from "./scheduler.js";
import type {
  AgentEvent,
  AgentLoopOptions,
  AgentMode,
  StopReason,
} from "./types.js";
import { DEFAULT_AGENT_OPTIONS } from "./types.js";

export class AgentLoop {
  constructor(
    private readonly store: SessionStore,
    private readonly provider: ChatProvider,
    private readonly providerConfig: ProviderConfig,
    private readonly registry: ToolRegistry,
    private readonly workspaceRoot: string,
    private readonly options: AgentLoopOptions = DEFAULT_AGENT_OPTIONS,
  ) {}

  async *run(
    sessionId: string,
    userText: string,
    opts: { cancel: CancelToken; mode: AgentMode },
  ): AsyncIterable<AgentEvent> {
    this.store.appendMessage(sessionId, {
      id: randomUUID(),
      role: "user",
      content: userText,
      createdAt: new Date().toISOString(),
    });

    const thinking =
      Boolean(this.providerConfig.thinking) && this.provider.supportsThinking;

    let consecutiveUnknown = 0;

    for (let iteration = 1; iteration <= this.options.maxIterations; iteration++) {
      if (opts.cancel.isCancelled) {
        yield* this.stop(sessionId, "cancelled", "用户已取消当前任务");
        return;
      }

      yield {
        type: "agent_progress",
        iteration,
        maxIterations: this.options.maxIterations,
      };

      const session = this.store.get(sessionId);
      if (!session) {
        yield* this.stop(sessionId, "error", `会话不存在：${sessionId}`);
        return;
      }

      const tools = filterToolsForMode(this.registry, opts.mode);

      let turn;
      try {
        const collector = collectStream(
          this.provider.streamChat({
            messages: session.messages,
            model: this.providerConfig.model,
            thinking,
            tools,
          }),
        );
        let step = await collector.next();
        while (!step.done) {
          yield step.value;
          step = await collector.next();
        }
        turn = step.value;
      } catch (err) {
        yield* this.stop(
          sessionId,
          "error",
          `模型请求失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      if (turn.usage) {
        yield {
          type: "token_usage",
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
        };
      }

      if (turn.errorMessage) {
        yield* this.stop(sessionId, "error", turn.errorMessage);
        return;
      }

      if (opts.cancel.isCancelled) {
        yield* this.stop(sessionId, "cancelled", "用户已取消当前任务");
        return;
      }

      // 落盘本轮 assistant（可有工具调用）
      if (turn.text.length > 0 || turn.toolCalls.length > 0) {
        const toolCalls: ToolCallRecord[] | undefined =
          turn.toolCalls.length > 0
            ? turn.toolCalls.map((t) => ({
                id: t.id,
                name: t.name,
                arguments: t.arguments,
              }))
            : undefined;
        this.store.appendMessage(sessionId, {
          id: randomUUID(),
          role: "assistant",
          content: turn.text,
          ...(toolCalls ? { toolCalls } : {}),
          ...(turn.thinkingSummary
            ? { thinkingSummary: turn.thinkingSummary }
            : {}),
          createdAt: new Date().toISOString(),
        });
      }

      if (turn.toolCalls.length === 0) {
        yield* this.stop(sessionId, "completed", "任务完成");
        return;
      }

      const batch = executeToolBatch(
        turn.toolCalls,
        this.registry,
        {
          workspaceRoot: this.workspaceRoot,
          timeoutMs: this.options.toolTimeoutMs,
        },
        opts.cancel,
      );

      let schedulerResult = await batch.next();
      while (!schedulerResult.done) {
        yield schedulerResult.value;
        schedulerResult = await batch.next();
      }
      const batchResult = schedulerResult.value;

      for (const item of batchResult.results) {
        this.store.appendMessage(sessionId, {
          id: randomUUID(),
          role: "tool",
          content: item.result.content,
          toolCallId: item.call.id,
          toolName: item.call.name,
          isError: !item.result.ok,
          createdAt: new Date().toISOString(),
        });
      }

      // 按批次结果顺序维护「连续未知工具」计数
      for (const item of batchResult.results) {
        if (item.unknown) {
          consecutiveUnknown += 1;
          if (consecutiveUnknown >= this.options.unknownToolLimit) {
            yield* this.stop(
              sessionId,
              "unknown_tools",
              `连续 ${this.options.unknownToolLimit} 次调用未知工具，已停止循环`,
            );
            return;
          }
        } else {
          consecutiveUnknown = 0;
        }
      }

      if (opts.cancel.isCancelled) {
        yield* this.stop(sessionId, "cancelled", "用户已取消当前任务");
        return;
      }
    }

    yield* this.stop(
      sessionId,
      "max_iterations",
      `已达到迭代上限（${this.options.maxIterations}），已停止循环`,
    );
  }

  private async *stop(
    _sessionId: string,
    reason: StopReason,
    message: string,
  ): AsyncIterable<AgentEvent> {
    yield { type: "agent_stopped", reason, message };
    yield { type: "done" };
  }
}
