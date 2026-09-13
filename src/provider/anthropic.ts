import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider, ChatRequest, StreamEvent } from "./types.js";

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, "");
  if (u.endsWith("/v1/messages")) {
    u = u.slice(0, -"/v1/messages".length);
  }
  if (u.endsWith("/v1")) {
    return u;
  }
  return `${u}/v1`;
}

function summarizeThinking(full: string, maxLen = 80): string {
  const compact = full.replace(/\s+/g, " ").trim();
  if (!compact) return "（无摘要）";
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}…`;
}

export function createAnthropicProvider(config: ProviderConfig): ChatProvider {
  const root = normalizeAnthropicBaseUrl(config.baseUrl);
  const endpoint = `${root}/messages`;

  return {
    protocol: "anthropic",
    supportsThinking: true,

    async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
      const systemParts = request.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content);
      const messages = request.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: 8192,
        stream: true,
        messages,
      };
      if (systemParts.length > 0) {
        body.system = systemParts.join("\n\n");
      }
      if (request.thinking) {
        body.thinking = { type: "enabled", budget_tokens: 8000 };
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        yield {
          type: "error",
          message: `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
        };
        return;
      }

      if (!response.ok) {
        const detail = await safeReadText(response);
        yield {
          type: "error",
          message: `模型接口错误（HTTP ${response.status}）：${detail || response.statusText}`,
        };
        return;
      }

      if (!response.body) {
        yield { type: "error", message: "模型接口未返回流式响应体" };
        return;
      }

      try {
        for await (const event of parseAnthropicSSE(response.body)) {
          yield event;
        }
        yield { type: "done" };
      } catch (err) {
        yield {
          type: "error",
          message: `解析流式响应失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingStarted = false;
  let thinkingBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let eventName = "";
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;

      let json: unknown;
      try {
        json = JSON.parse(dataLine);
      } catch {
        continue;
      }

      const obj = json as {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string };
        content_block?: { type?: string };
      };

      const type = eventName || obj.type || "";

      if (type === "content_block_start") {
        if (obj.content_block?.type === "thinking") {
          thinkingStarted = true;
          thinkingBuffer = "";
          yield { type: "thinking_start" };
        }
      }

      if (type === "content_block_delta") {
        const delta = obj.delta;
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          thinkingBuffer += delta.thinking;
          yield { type: "thinking_delta", text: delta.thinking };
        }
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "text_delta", text: delta.text };
        }
      }

      if (type === "content_block_stop" && thinkingStarted) {
        yield {
          type: "thinking_end",
          summary: summarizeThinking(thinkingBuffer),
        };
        thinkingStarted = false;
      }

      if (type === "error") {
        const msg =
          (json as { error?: { message?: string } }).error?.message ||
          "Anthropic 返回错误";
        yield { type: "error", message: msg };
        return;
      }
    }
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}
