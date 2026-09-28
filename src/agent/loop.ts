import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider } from "../provider/types.js";
import type { ToolDefinition } from "../tools/types.js";
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
import type { HookEngine } from "../hooks/engine.js";
import type { HookSessionState } from "../hooks/state.js";
import type { PermissionGate } from "../permission/gate.js";
import { executeToolBatch, type ToolBatchPolicy } from "./scheduler.js";
import type { RequestSnapshot } from "../agents/types.js";
import type {
  AgentEvent,
  AgentLoopOptions,
  AgentMode,
  StopReason,
} from "./types.js";
import { DEFAULT_AGENT_OPTIONS, isPermissionErrorCode } from "./types.js";

export interface AgentPromptContext {
  customInstructions?: string;
  memoryText?: string;
}

/** 每轮向主循环提供 Skill 提醒、工具视图和模型 */
export interface SkillTurnContext {
  pinnedText(sessionId: string): string;
  catalogText(): string;
  visibleNames(sessionId: string, mode: AgentMode): string[];
  resolveModel(
    sessionId: string,
  ):
    | { provider: ChatProvider; config: ProviderConfig }
    | { error: string };
}

/** 一轮主循环或子循环的运行参数。未传的字段保持原有行为。 */
export interface AgentRunOptions {
  cancel: CancelToken;
  mode: AgentMode;
  /** 工具与提醒使用的会话。独立模式用主会话，存档用临时会话 */
  skillSessionId?: string;
  /** 为真时不再写入 userText。送回续跑时，正文已经先写入会话 */
  skipUserAppend?: boolean;
  /** 子循环使用这段系统提示，不再拼主对话的固定提示 */
  systemOverride?: string;
  /** 子循环使用这份工具定义 */
  toolsOverride?: ToolDefinition[];
  /** 为真时按会话原文发送，不再插入提醒 */
  literalMessages?: boolean;
  /** 为 false 时不覆盖父循环的请求快照 */
  recordSnapshot?: boolean;
  maxIterations?: number;
  skipMemoryUpdate?: boolean;
  /** 为真时不把用量记入上下文估算 */
  skipContextUsage?: boolean;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  toolPolicy?: ToolBatchPolicy;
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
  private skillContext: SkillTurnContext | null = null;
  private hookEngine: HookEngine | null = null;
  private hookState: HookSessionState | null = null;
  private lastSnapshot: RequestSnapshot | null = null;
  private agentCatalogText: () => string = () => "";

  /** 父循环最近一次真正发出的请求。子循环不写这份快照。 */
  getRequestSnapshot(): RequestSnapshot | null {
    if (!this.lastSnapshot) return null;
    return {
      system: this.lastSnapshot.system,
      tools: this.lastSnapshot.tools.map((tool) => ({ ...tool })),
      messages: this.lastSnapshot.messages.map((message) => ({ ...message })),
    };
  }

  setAgentCatalog(read: () => string): void {
    this.agentCatalogText = read;
  }

  setSkillContext(context: SkillTurnContext | null): void {
    this.skillContext = context;
  }

  setHooks(engine: HookEngine, state: HookSessionState): void {
    this.hookEngine = engine;
    this.hookState = state;
  }

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
    opts: AgentRunOptions,
  ): AsyncIterable<AgentEvent> {
    const hookSessionId = opts.skillSessionId ?? sessionId;
    if (this.hookEngine) {
      await this.hookEngine.dispatch({
        event: "turn_start",
        sessionId: hookSessionId,
      });
    }
    try {
      yield* this.executeRun(sessionId, userText, opts);
    } finally {
      if (this.hookEngine) {
        await this.hookEngine.dispatch({
          event: "turn_end",
          sessionId: hookSessionId,
        });
      }
    }
  }

  private async *executeRun(
    sessionId: string,
    userText: string,
    opts: AgentRunOptions,
  ): AsyncIterable<AgentEvent> {
    if (!opts.skipUserAppend) {
      this.store.appendMessage(sessionId, {
        id: randomUUID(),
        role: "user",
        content: userText,
        createdAt: new Date().toISOString(),
      });
    }

    const skillSessionId = opts.skillSessionId ?? sessionId;
    const maxIterations = opts.maxIterations ?? this.options.maxIterations;

    let consecutiveUnknown = 0;
    let consecutiveToolOnly = 0;
    let consecutivePermissionDeny = 0;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (opts.cancel.isCancelled) {
        yield* this.stop(sessionId, "cancelled", "用户已取消当前任务");
        return;
      }

      yield {
        type: "agent_progress",
        iteration,
        maxIterations,
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

      let provider = this.provider;
      let providerConfig = this.providerConfig;
      if (this.skillContext) {
        const resolved = this.skillContext.resolveModel(skillSessionId);
        if ("error" in resolved) {
          yield* this.stop(sessionId, "error", resolved.error);
          return;
        }
        provider = resolved.provider;
        providerConfig = resolved.config;
      }
      const thinking =
        Boolean(providerConfig.thinking) && provider.supportsThinking;
      const tools =
        opts.toolsOverride ??
        (this.skillContext
          ? this.definitionsFor(
              this.skillContext.visibleNames(skillSessionId, opts.mode),
            )
          : filterToolsForMode(this.registry, opts.mode));

      let requestSystem: string;
      let reminderMessages: ChatMessage[];
      try {
        if (opts.literalMessages) {
          requestSystem = opts.systemOverride ?? "";
          const hookPrompt = this.hookState?.prompts(skillSessionId)?.trim() ?? "";
          reminderMessages = hookPrompt
            ? [
                {
                  id: randomUUID(),
                  role: "user" as const,
                  content: wrapReminder(hookPrompt),
                  createdAt: new Date().toISOString(),
                },
              ]
            : [];
        } else {
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
          hookPrompt: this.hookState?.prompts(skillSessionId) ?? "",
          pinnedText: this.skillContext?.pinnedText(skillSessionId),
          catalogText: this.skillContext?.catalogText(),
          agentCatalog: this.agentCatalogText(),
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
        }
      } catch (err) {
        yield* this.stop(
          sessionId,
          "error",
          `系统提示拼装失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      const requestMessages = opts.literalMessages
        ? [...sessionAfter.messages, ...reminderMessages]
        : [...reminderMessages, ...sessionAfter.messages];
      if (opts.recordSnapshot !== false) {
        this.lastSnapshot = {
          system: requestSystem,
          tools: tools.map((tool) => ({ ...tool })),
          messages: requestMessages.map((message) => ({ ...message })),
        };
      }

      let turn;
      try {
        const collector = collectStream(
          provider.streamChat({
            system: requestSystem,
            messages: requestMessages,
            model: providerConfig.model,
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
        opts.onUsage?.(turn.usage.inputTokens ?? 0, turn.usage.outputTokens ?? 0);
        if (!opts.skipContextUsage && turn.usage.inputTokens !== undefined) {
          this.pipeline.noteUsage(
            sessionId,
            turn.usage.inputTokens,
            sessionAfter.messages.length,
          );
        }
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
        if (!opts.skipMemoryUpdate) {
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
        }
        return;
      }

      const batch = executeToolBatch(
        turn.toolCalls,
        this.registry,
        {
          workspaceRoot: this.workspaceRoot,
          timeoutMs: this.options.toolTimeoutMs,
          sessionId: skillSessionId,
        },
        opts.cancel,
        this.gate,
        sessionId,
        this.hookEngine
          ? { engine: this.hookEngine, sessionId: skillSessionId }
          : undefined,
        opts.toolPolicy,
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

      // 无有效正文的纯工具轮（含一两句「我来看看」）：防止探索式空转打满上限
      if (turn.text.trim().length < 40) {
        consecutiveToolOnly += 1;
      } else {
        consecutiveToolOnly = 0;
      }

      const allPermissionDenied =
        batchResult.results.length > 0 &&
        batchResult.results.every(
          (item) =>
            !item.result.ok && isPermissionErrorCode(item.result.errorCode),
        );
      if (allPermissionDenied) {
        consecutivePermissionDeny += 1;
      } else {
        consecutivePermissionDeny = 0;
      }

      if (
        consecutivePermissionDeny >= this.options.maxPermissionDenyIterations
      ) {
        yield* this.stop(
          sessionId,
          "completed",
          `连续 ${consecutivePermissionDeny} 轮工具均被权限拒绝，已停止。可用 /perm allow 临时放宽，或为常用工具写 allow 规则后再试。`,
        );
        return;
      }

      if (consecutiveToolOnly >= this.options.maxToolOnlyIterations) {
        yield* this.stop(
          sessionId,
          "completed",
          `连续 ${consecutiveToolOnly} 轮只有工具调用、没有结论，已停止以免空转。可换更具体的问题，或再说「请根据已有结果直接总结」。`,
        );
        return;
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
      `已达到迭代上限（${maxIterations}），已停止循环`,
    );
  }

  private definitionsFor(names: string[]): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const name of names) {
      const tool = this.registry.get(name);
      if (!tool) continue;
      defs.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    return defs;
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
