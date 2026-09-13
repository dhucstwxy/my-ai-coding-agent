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
  | { type: "error"; message: string }
  | { type: "done" };

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  thinking?: boolean;
  /** 缺省或空 = 不提供工具 */
  tools?: ToolDefinition[];
}

export interface ChatProvider {
  readonly protocol: "anthropic" | "openai";
  readonly supportsThinking: boolean;
  streamChat(request: ChatRequest): AsyncIterable<StreamEvent>;
}
