import type { ChatMessage } from "../session/types.js";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; summary: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  thinking?: boolean;
}

export interface ChatProvider {
  readonly protocol: "anthropic" | "openai";
  readonly supportsThinking: boolean;
  streamChat(request: ChatRequest): AsyncIterable<StreamEvent>;
}
