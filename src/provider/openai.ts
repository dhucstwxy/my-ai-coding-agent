import type { ProviderConfig } from "../config/types.js";
import type { ChatMessage } from "../session/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { ChatProvider, ChatRequest, StreamEvent } from "./types.js";

/** 将 base_url 规范为可拼接 /chat/completions 的根地址 */
export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, "");
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
      const body: Record<string, unknown> = {
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: mapOpenAIMessages(request.messages, request.system),
      };

      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map(toOpenAITool);
        body.tool_choice = "auto";
      }

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

function toOpenAITool(def: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
    },
  };
}

function mapOpenAIMessages(
  messages: ChatMessage[],
  stableSystem?: string,
): unknown[] {
  const out: unknown[] = [];
  if (stableSystem && stableSystem.length > 0) {
    out.push({ role: "system", content: stableSystem });
  }
  for (const m of messages) {
    if (m.role === "system" || m.role === "user") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const activeCalls = (m.toolCalls ?? []).filter((c) => !c.ignored);
      if (activeCalls.length === 0) {
        out.push({ role: "assistant", content: m.content || null });
        continue;
      }
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: activeCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: {
            name: c.name,
            arguments:
              typeof c.arguments === "string"
                ? c.arguments
                : JSON.stringify(c.arguments),
          },
        })),
      });
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    }
  }
  return out;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending = new Map<number, PendingToolCall>();
  let lastUsage: Extract<StreamEvent, { type: "token_usage" }> | undefined;

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
      if (data === "[DONE]") {
        yield* flushPendingToolCalls(pending);
        yield lastUsage ?? { type: "token_usage", cacheAvailable: false };
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      const parsedUsage = parseOpenAIUsage(json);
      if (parsedUsage) lastUsage = parsedUsage;

      const delta = (
        json as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        }
      ).choices?.[0]?.delta;

      const text = delta?.content;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "text_delta", text };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          let cur = pending.get(index);
          if (!cur) {
            cur = {
              id: tc.id || `call_${index}`,
              name: tc.function?.name || "",
              args: "",
              started: false,
            };
            pending.set(index, cur);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") {
            cur.args += tc.function.arguments;
            if (!cur.started && cur.name) {
              cur.started = true;
              yield {
                type: "tool_call_start",
                id: cur.id,
                name: cur.name,
              };
            }
            if (cur.started) {
              yield {
                type: "tool_call_args_delta",
                id: cur.id,
                delta: tc.function.arguments,
              };
            }
          } else if (!cur.started && cur.name) {
            cur.started = true;
            yield {
              type: "tool_call_start",
              id: cur.id,
              name: cur.name,
            };
          }
        }
      }
    }
  }

  yield* flushPendingToolCalls(pending);
  yield lastUsage ?? { type: "token_usage", cacheAvailable: false };
}

function parseOpenAIUsage(
  json: unknown,
): Extract<StreamEvent, { type: "token_usage" }> | undefined {
  const usage = (
    json as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
    }
  ).usage;
  if (!usage) return undefined;
  const hasCache =
    typeof usage.prompt_cache_hit_tokens === "number" ||
    typeof usage.prompt_cache_miss_tokens === "number";
  return {
    type: "token_usage",
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheHitTokens: usage.prompt_cache_hit_tokens,
    cacheMissTokens: usage.prompt_cache_miss_tokens,
    cacheAvailable: hasCache,
  };
}

function* flushPendingToolCalls(
  pending: Map<number, PendingToolCall>,
): Generator<StreamEvent> {
  const sorted = [...pending.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, cur] of sorted) {
    if (!cur.started && cur.name) {
      yield { type: "tool_call_start", id: cur.id, name: cur.name };
    }
    yield finalizeToolCall(cur.id, cur.name, cur.args);
  }
  pending.clear();
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
