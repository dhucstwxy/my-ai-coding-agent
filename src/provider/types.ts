import type { ChatMessage } from "../session/types.js";
import type { ToolDefinition } from "../tools/types.js";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; summary: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_args_delta"; id: string; delta: string }
  | {
      type: "tool_call_end";
      id: string;
      name: string;
      arguments: Record<string, unknown> | string;
      parseError?: string;
    }
  | {
      type: "tool_execution_start";
      id: string;
      name: string;
      argsSummary: string;
    }
  | {
      type: "tool_execution_end";
      id: string;
      name: string;
      ok: boolean;
      resultSummary: string;
    }
  | { type: "tool_calls_ignored"; names: string[] }
  | {
      type: "token_usage";
      inputTokens?: number;
      outputTokens?: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
      /** false 表示协议未返回缓存字段，禁止伪造 */
      cacheAvailable: boolean;
    }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  thinking?: boolean;
  /** 缺省或空 = 不提供工具 */
  tools?: ToolDefinition[];
  /** 稳定系统提示（可缓存前缀）；优先于 messages 中的 system */
  system?: string;
  /** Anthropic 是否在 tools 上打缓存标记，默认 true */
  cacheTools?: boolean;
}

export interface ChatProvider {
  readonly protocol: "anthropic" | "openai";
  readonly supportsThinking: boolean;
  streamChat(request: ChatRequest): AsyncIterable<StreamEvent>;
}
