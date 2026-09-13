import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider, ChatRequest, StreamEvent } from "./types.js";

/** 将 base_url 规范为可拼接 /chat/completions 的根地址 */
export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, "");
  // DeepSeek 官方既可用 https://api.deepseek.com 也可带 /v1
  if (u.endsWith("/chat/completions")) {
    u = u.slice(0, -"/chat/completions".length);
  }
  return u;
}

export function createOpenAIProvider(config: ProviderConfig): ChatProvider {
  const root = normalizeOpenAIBaseUrl(config.baseUrl);
  const endpoint = `${root}/chat/completions`;

  return {
    protocol: "openai",
    supportsThinking: false,

    async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
      const body = {
        model: request.model,
        stream: true,
        messages: request.messages
          .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
          .map((m) => ({ role: m.role, content: m.content })),
      };

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
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
        for await (const event of parseOpenAISSE(response.body)) {
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

async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;

      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = (json as {
        choices?: Array<{ delta?: { content?: string | null } }>;
      }).choices?.[0]?.delta;

      const text = delta?.content;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "text_delta", text };
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
