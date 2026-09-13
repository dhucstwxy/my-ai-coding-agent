import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider, StreamEvent } from "../provider/types.js";
import type { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../session/types.js";

export class ChatService {
  constructor(
    private readonly store: SessionStore,
    private readonly provider: ChatProvider,
    private readonly providerConfig: ProviderConfig,
  ) {}

  async *send(
    sessionId: string,
    userText: string,
  ): AsyncIterable<StreamEvent> {
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: userText,
      createdAt: new Date().toISOString(),
    };
    this.store.appendMessage(sessionId, userMessage);

    const session = this.store.get(sessionId);
    if (!session) {
      yield { type: "error", message: `会话不存在：${sessionId}` };
      return;
    }

    const thinking =
      Boolean(this.providerConfig.thinking) && this.provider.supportsThinking;

    let assistantText = "";
    let thinkingSummary: string | undefined;
    let thinkingBuf = "";
    let failed = false;

    try {
      for await (const event of this.provider.streamChat({
        messages: session.messages,
        model: this.providerConfig.model,
        thinking,
      })) {
        if (event.type === "text_delta") {
          assistantText += event.text;
        }
        if (event.type === "thinking_delta") {
          thinkingBuf += event.text;
        }
        if (event.type === "thinking_end") {
          thinkingSummary = event.summary;
        }
        if (event.type === "error") {
          failed = true;
          yield event;
          return;
        }
        if (event.type === "done") {
          if (!failed && assistantText.length > 0) {
            const assistantMessage: ChatMessage = {
              id: randomUUID(),
              role: "assistant",
              content: assistantText,
              ...(thinkingSummary || thinkingBuf
                ? {
                    thinkingSummary:
                      thinkingSummary ||
                      thinkingBuf.replace(/\s+/g, " ").trim().slice(0, 80),
                  }
                : {}),
              createdAt: new Date().toISOString(),
            };
            this.store.appendMessage(sessionId, assistantMessage);
          }
          yield event;
          return;
        }
        yield event;
      }
    } catch (err) {
      yield {
        type: "error",
        message: `对话失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
