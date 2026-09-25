import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider } from "../provider/types.js";
import type { SessionStore } from "../session/store.js";
import type { ChatMessage, ToolCallRecord } from "../session/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  DEFAULT_REINFORCE_EVERY,
  SYSTEM_REMINDER_TAG,
  buildPrompt,
  buildReminders,
  formatTimeLabel,
} from "../prompt/index.js";
import {
  ContextPipeline,
  DEFAULT_CONTEXT_WINDOW,
  type CompactPipelineEvent,
} from "../context/index.js";
import { scheduleMemoryUpdate } from "../memory/index.js";
import {
  buildTimeGapReminderBody,
  needsTimeGapReminder,
} from "../session/restore.js";
import type { CancelToken } from "./cancel.js";
import { collectStream } from "./collector.js";
import { filterToolsForMode } from "./plan-mode.js";
import type { PermissionGate } from "../permission/gate.js";
import { executeToolBatch } from "./scheduler.js";
import type {
  AgentEvent,
  AgentLoopOptions,
  AgentMode,
  StopReason,
} from "./types.js";
import { DEFAULT_AGENT_OPTIONS } from "./types.js";

export interface AgentPromptContext {
  customInstructions?: string;
  memoryText?: string;
}

function wrapReminder(body: string): string {
  return `<${SYSTEM_REMINDER_TAG}>\n${body.trim()}\n</${SYSTEM_REMINDER_TAG}>`;
}

/** 稳定前缀 + 自定义指令 + 记忆（不含环境；环境走 reminder） */
function buildRequestSystem(
  stableSystem: string,
  customInstructions?: string,
  memoryText?: string,
): string {
  const parts = [stableSystem];
  const custom = customInstructions?.trim();
  if (custom) {
    parts.push(`## 自定义指令\n\n${custom}`);
  }
  const mem = memoryText?.trim();
  if (mem) {
    parts.push(`## 长期记忆\n\n${mem}`);
  }
  return parts.join("\n\n");
}

export class AgentLoop {
  readonly pipeline: ContextPipeline;

  constructor(
    private readonly store: SessionStore,
    private readonly provider: ChatProvider,
    private readonly providerConfig: ProviderConfig,
    private readonly registry: ToolRegistry,
    private readonly workspaceRoot: string,
    private readonly gate: PermissionGate,
    private readonly options: AgentLoopOptions = DEFAULT_AGENT_OPTIONS,
    pipeline?: ContextPipeline,
    private readonly promptContext: AgentPromptContext = {},
  ) {
    this.pipeline =
      pipeline ?? new ContextPipeline(store, provider, providerConfig);
  }

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

      const lastMessageAt =
        session.messages.length > 0
          ? session.messages[session.messages.length - 1].createdAt
          : null;

      // 请求前上下文管线
      const compactEvents: CompactPipelineEvent[] = [];
      try {
        await this.pipeline.run({
          sessionId,
          messages: session.messages,
          contextWindow:
            this.providerConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          mode: "auto",
          force: false,
          onEvent: (e) => compactEvents.push(e),
        });
      } catch (err) {
        yield* this.stop(
          sessionId,
          "error",
          `上下文压缩失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      for (const e of compactEvents) {
        yield e;
      }

      const sessionAfter = this.store.get(sessionId);
      if (!sessionAfter) {
        yield* this.stop(sessionId, "error", `会话不存在：${sessionId}`);
        return;
      }

      const tools = filterToolsForMode(this.registry, opts.mode);

      let requestSystem: string;
      let reminderMessages: ChatMessage[];
      try {
        const built = buildPrompt({
          workspaceRoot: this.workspaceRoot,
          now: new Date(),
          platform: process.platform,
          customInstructions: this.promptContext.customInstructions,
          memoryText: this.promptContext.memoryText,
        });
        requestSystem = buildRequestSystem(
          built.stableSystem,
          this.promptContext.customInstructions,
          this.promptContext.memoryText,
        );
        reminderMessages = buildReminders({
          mode: opts.mode,
          iteration,
          reinforceEvery: DEFAULT_REINFORCE_EVERY,
          environment: {
            workspaceRoot: this.workspaceRoot,
            timeLabel: formatTimeLabel(new Date()),
            platform: process.platform,
          },
        }).map((r) => ({
          id: randomUUID(),
          role: "user" as const,
          content: r.content,
          createdAt: new Date().toISOString(),
        }));

        // 时间跨度提醒：用「用户发送前」最后一条之外的历史判断更准；
        // 此处用刚 append 前的 lastMessageAt（排除本轮 user）——上面 lastMessageAt 已含本轮 user。
        // 改为：若消息数>=2，取倒数第二条。
        const priorAt =
          sessionAfter.messages.length >= 2
            ? sessionAfter.messages[sessionAfter.messages.length - 2].createdAt
            : null;
        if (needsTimeGapReminder(priorAt)) {
          reminderMessages.unshift({
            id: randomUUID(),
            role: "user",
            content: wrapReminder(
              buildTimeGapReminderBody(priorAt ?? lastMessageAt ?? ""),
            ),
            createdAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        yield* this.stop(
          sessionId,
          "error",
          `系统提示拼装失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      let turn;
      try {
        const collector = collectStream(
          this.provider.streamChat({
            system: requestSystem,
            messages: [...reminderMessages, ...sessionAfter.messages],
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

      if (turn.usage?.inputTokens !== undefined) {
        this.pipeline.noteUsage(
          sessionId,
          turn.usage.inputTokens,
          sessionAfter.messages.length,
        );
      }

      if (turn.errorMessage) {
        yield* this.stop(sessionId, "error", turn.errorMessage);
        return;
      }

      if (opts.cancel.isCancelled) {
        yield* this.stop(sessionId, "cancelled", "用户已取消当前任务");
        return;
      }

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
        // 先结束主路径，再异步更新记忆
        yield* this.stop(sessionId, "completed", "任务完成");
        const latest = this.store.get(sessionId);
        if (latest) {
          scheduleMemoryUpdate({
            workspaceRoot: this.workspaceRoot,
            sessionId,
            recentMessages: latest.messages,
            provider: this.provider,
            model: this.providerConfig.model,
          });
        }
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
        this.gate,
        sessionId,
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
