import type { ProviderConfig } from "../config/types.js";
import type { ChatMessage } from "../session/types.js";
import type { ToolDefinition } from "../tools/types.js";
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
      const stable =
        request.system && request.system.length > 0
          ? request.system
          : systemParts.join("\n\n");

      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: 8192,
        stream: true,
        messages: mapAnthropicMessages(request.messages),
      };
      if (stable) {
        body.system = [
          {
            type: "text",
            text: stable,
            cache_control: { type: "ephemeral" },
          },
        ];
      }
      if (request.thinking) {
        body.thinking = { type: "enabled", budget_tokens: 8000 };
      }
      if (request.tools && request.tools.length > 0) {
        const mapped = request.tools.map(toAnthropicTool);
        if (request.cacheTools !== false && mapped.length > 0) {
          mapped[mapped.length - 1] = {
            ...mapped[mapped.length - 1],
            cache_control: { type: "ephemeral" },
          };
        }
        body.tools = mapped;
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
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

function toAnthropicTool(def: ToolDefinition): Record<string, unknown> {
  return {
    name: def.name,
    description: def.description,
    input_schema: def.inputSchema,
  };
}

function mapAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") continue;

    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }

    if (m.role === "assistant") {
      const activeCalls = (m.toolCalls ?? []).filter((c) => !c.ignored);
      const content: unknown[] = [];
      if (m.content && m.content.length > 0) {
        content.push({ type: "text", text: m.content });
      }
      for (const c of activeCalls) {
        const input =
          typeof c.arguments === "string"
            ? safeParseObject(c.arguments)
            : c.arguments;
        content.push({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input,
        });
      }
      out.push({
        role: "assistant",
        content: content.length > 0 ? content : m.content || "",
      });
      continue;
    }

    if (m.role === "tool") {
      // 合并连续的 tool 结果为一条 user 消息
      const results: unknown[] = [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
          ...(m.isError ? { is_error: true } : {}),
        },
      ];
      while (i + 1 < messages.length && messages[i + 1].role === "tool") {
        i += 1;
        const next = messages[i];
        results.push({
          type: "tool_result",
          tool_use_id: next.toolCallId,
          content: next.content,
          ...(next.isError ? { is_error: true } : {}),
        });
      }
      out.push({ role: "user", content: results });
    }
  }

  return out;
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingStarted = false;
  let thinkingBuffer = "";

  let toolId = "";
  let toolName = "";
  let toolArgs = "";
  let inTool = false;
  let lastUsage: Extract<StreamEvent, { type: "token_usage" }> | undefined;

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
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
        };
        content_block?: {
          type?: string;
          id?: string;
          name?: string;
        };
        usage?: AnthropicUsage;
        message?: { usage?: AnthropicUsage };
      };

      const parsedUsage = parseAnthropicUsage(obj.usage ?? obj.message?.usage);
      if (parsedUsage) lastUsage = parsedUsage;

      const type = eventName || obj.type || "";

      if (type === "content_block_start") {
        if (obj.content_block?.type === "thinking") {
          thinkingStarted = true;
          thinkingBuffer = "";
          yield { type: "thinking_start" };
        }
        if (obj.content_block?.type === "tool_use") {
          inTool = true;
          toolId = obj.content_block.id || `toolu_${Date.now()}`;
          toolName = obj.content_block.name || "";
          toolArgs = "";
          yield {
            type: "tool_call_start",
            id: toolId,
            name: toolName,
          };
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
        if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          inTool
        ) {
          toolArgs += delta.partial_json;
          yield {
            type: "tool_call_args_delta",
            id: toolId,
            delta: delta.partial_json,
          };
        }
      }

      if (type === "content_block_stop") {
        if (thinkingStarted) {
          yield {
            type: "thinking_end",
            summary: summarizeThinking(thinkingBuffer),
          };
          thinkingStarted = false;
        }
        if (inTool) {
          yield finalizeToolCall(toolId, toolName, toolArgs);
          inTool = false;
          toolId = "";
          toolName = "";
          toolArgs = "";
        }
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

  yield lastUsage ?? { type: "token_usage", cacheAvailable: false };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function parseAnthropicUsage(
  usage: AnthropicUsage | undefined,
): Extract<StreamEvent, { type: "token_usage" }> | undefined {
  if (!usage) return undefined;
  const hasCache =
    typeof usage.cache_read_input_tokens === "number" ||
    typeof usage.cache_creation_input_tokens === "number";
  return {
    type: "token_usage",
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheHitTokens: usage.cache_read_input_tokens,
    cacheMissTokens: usage.cache_creation_input_tokens,
    cacheAvailable: hasCache,
  };
}

function finalizeToolCall(
  id: string,
  name: string,
  rawArgs: string,
): StreamEvent {
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        type: "tool_call_end",
        id,
        name,
        arguments: rawArgs,
        parseError: "工具参数必须是 JSON 对象",
      };
    }
    return {
      type: "tool_call_end",
      id,
      name,
      arguments: parsed as Record<string, unknown>,
    };
  } catch (err) {
    return {
      type: "tool_call_end",
      id,
      name,
      arguments: rawArgs,
      parseError: `参数 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
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
