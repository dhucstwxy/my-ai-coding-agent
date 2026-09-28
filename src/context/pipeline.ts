import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider } from "../provider/types.js";
import type { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../session/types.js";
import { autoCompact } from "./auto.js";
import {
  AUTO_RESERVE_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  MANUAL_RESERVE_TOKENS,
} from "./constants.js";
import {
  createEstimateState,
  estimateWithAnchor,
  updateAnchor,
  type TokenEstimateState,
} from "./estimate.js";
import { microCompact } from "./micro.js";
import { CompactStateStore } from "./state.js";

export type CompactLayer = "micro" | "auto";
export type CompactTrigger = "auto" | "manual";

export type CompactPipelineEvent =
  | {
      type: "compact_start";
      layer: CompactLayer;
      trigger: CompactTrigger;
    }
  | {
      type: "compact_done";
      layer: CompactLayer;
      spilledCount?: number;
      removedMessageCount?: number;
      keptMessageCount?: number;
    }
  | {
      type: "compact_failed";
      layer: "auto";
      error: string;
      consecutiveFailures: number;
    }
  | { type: "compact_circuit_open" };

export interface PipelineRunOptions {
  sessionId: string;
  messages: ChatMessage[];
  contextWindow?: number;
  mode: "auto" | "manual";
  userNote?: string;
  /** 手动 /compact 时为 true：未过阈值也执行重量压缩 */
  force: boolean;
  onEvent?: (e: CompactPipelineEvent) => void;
}

export interface PipelineRunResult {
  messages: ChatMessage[];
  micro: { spilledCount: number; changed: boolean };
  auto?: {
    attempted: boolean;
    succeeded?: boolean;
    error?: string;
    circuitOpen?: boolean;
  };
}

export class ContextPipeline {
  private readonly compactState = new CompactStateStore();
  private readonly estimateBySession = new Map<string, TokenEstimateState>();
  private onCompact?: (sessionId: string) => Promise<void> | void;

  /** 压缩开始时调用。未设置则行为与原来相同。 */
  setOnCompact(handler: (sessionId: string) => Promise<void> | void): void {
    this.onCompact = handler;
  }

  constructor(
    private readonly store: SessionStore,
    private readonly provider: ChatProvider,
    private readonly providerConfig: ProviderConfig,
  ) {}

  getEstimateState(sessionId: string): TokenEstimateState {
    let s = this.estimateBySession.get(sessionId);
    if (!s) {
      s = createEstimateState();
      this.estimateBySession.set(sessionId, s);
    }
    return s;
  }

  /** 模型返回 usage 后更新锚点 */
  noteUsage(sessionId: string, inputTokens: number, messageCount: number): void {
    updateAnchor(this.getEstimateState(sessionId), inputTokens, messageCount);
  }

  resetSession(sessionId: string): void {
    this.compactState.reset(sessionId);
    this.estimateBySession.delete(sessionId);
  }

  /** 重量压缩是否已熔断 */
  isCompactCircuitOpen(sessionId: string): boolean {
    return this.compactState.isAutoDisabled(sessionId);
  }

  async run(opts: PipelineRunOptions): Promise<PipelineRunResult> {
    const emit = opts.onEvent ?? (() => {});
    const window =
      opts.contextWindow ??
      this.providerConfig.contextWindow ??
      DEFAULT_CONTEXT_WINDOW;
    const trigger: CompactTrigger = opts.mode === "manual" ? "manual" : "auto";

    // —— 轻量预防（仅在真正有落盘时提示，避免每轮都刷「正在压缩」）——
    const micro = microCompact(opts.messages, {
      sessionId: opts.sessionId,
      store: this.store,
    });
    let messages = micro.messages;
    if (micro.changed) {
      await this.notifyCompact(emit, opts.sessionId, "micro", trigger);
      this.store.replaceMessages(opts.sessionId, messages);
      // 历史变短/内容变化后重置锚点
      const est = this.getEstimateState(opts.sessionId);
      est.anchorInputTokens = null;
      est.anchorMessageCount = 0;
      emit({
        type: "compact_done",
        layer: "micro",
        spilledCount: micro.spilledCount,
      });
    }

    const result: PipelineRunResult = {
      messages,
      micro: { spilledCount: micro.spilledCount, changed: micro.changed },
    };

    // —— 重量兜底 ——
    const autoDisabled = this.compactState.isAutoDisabled(opts.sessionId);
    // 自动模式且已熔断 → 跳过；手动 force 仍尝试
    if (autoDisabled && !(opts.mode === "manual" && opts.force)) {
      result.auto = { attempted: false, circuitOpen: true };
      return result;
    }

    const reserve =
      opts.mode === "manual" ? MANUAL_RESERVE_TOKENS : AUTO_RESERVE_TOKENS;
    const estState = this.getEstimateState(opts.sessionId);
    const { tokens, resetAnchor } = estimateWithAnchor(messages, estState);
    if (resetAnchor) {
      estState.anchorInputTokens = null;
      estState.anchorMessageCount = 0;
    }

    const overBudget = tokens > window - reserve;
    if (!opts.force && !overBudget) {
      result.auto = { attempted: false };
      return result;
    }

    await this.notifyCompact(emit, opts.sessionId, "auto", trigger);
    const thinking =
      Boolean(this.providerConfig.thinking) && this.provider.supportsThinking;
    const autoResult = await autoCompact({
      messages,
      provider: this.provider,
      model: this.providerConfig.model,
      thinking,
      userNote: opts.userNote,
    });

    if (!autoResult.ok) {
      // 「无需压缩」不算熔断失败
      const skipCircuit = autoResult.error.includes("无需压缩");
      if (skipCircuit) {
        emit({
          type: "compact_failed",
          layer: "auto",
          error: autoResult.error,
          consecutiveFailures: 0,
        });
        result.auto = {
          attempted: true,
          succeeded: false,
          error: autoResult.error,
        };
        return result;
      }
      const { consecutive, circuitOpen } = this.compactState.recordFailure(
        opts.sessionId,
      );
      emit({
        type: "compact_failed",
        layer: "auto",
        error: autoResult.error,
        consecutiveFailures: consecutive,
      });
      if (circuitOpen) {
        emit({ type: "compact_circuit_open" });
      }
      result.auto = {
        attempted: true,
        succeeded: false,
        error: autoResult.error,
        circuitOpen,
      };
      return result;
    }

    this.store.replaceMessages(opts.sessionId, autoResult.messages);
    this.compactState.recordSuccess(opts.sessionId);
    // 压缩后重置锚点
    estState.anchorInputTokens = null;
    estState.anchorMessageCount = 0;
    emit({
      type: "compact_done",
      layer: "auto",
      removedMessageCount: autoResult.removedCount,
      keptMessageCount: autoResult.keptCount,
    });
    result.messages = autoResult.messages;
    result.auto = { attempted: true, succeeded: true };
    return result;
  }

  private async notifyCompact(
    emit: (event: CompactPipelineEvent) => void,
    sessionId: string,
    layer: CompactLayer,
    trigger: CompactTrigger,
  ): Promise<void> {
    emit({ type: "compact_start", layer, trigger });
    if (!this.onCompact) return;
    try {
      await this.onCompact(sessionId);
    } catch (err) {
      console.error(
        `[hook] compact 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
