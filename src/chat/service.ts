import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config/types.js";
import type { ChatProvider, StreamEvent } from "../provider/types.js";
import type { SessionStore } from "../session/store.js";
import type { ChatMessage, ToolCallRecord } from "../session/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const SUMMARY_MAX = 200;

export class ChatService {
  constructor(
    private readonly store: SessionStore,
    private readonly provider: ChatProvider,
    private readonly providerConfig: ProviderConfig,
    private readonly registry: ToolRegistry,
    private readonly workspaceRoot: string,
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

    // —— 请求①：带 tools ——
    let assistantText = "";
    let thinkingSummary: string | undefined;
    let thinkingBuf = "";
    const toolEnds: Extract<StreamEvent, { type: "tool_call_end" }>[] = [];
    let failed = false;

    try {
      for await (const event of this.provider.streamChat({
        messages: session.messages,
        model: this.providerConfig.model,
        thinking,
        tools: this.registry.toDefinitions(),
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
        if (event.type === "tool_call_end") {
          toolEnds.push(event);
        }
        if (event.type === "error") {
          failed = true;
          yield event;
          return;
        }
        if (event.type === "done") {
          break;
        }
        // 透传（含 tool_call_start/args_delta 等），done 稍后统一处理
        if (
          event.type !== "tool_execution_start" &&
          event.type !== "tool_execution_end" &&
          event.type !== "tool_calls_ignored"
        ) {
          yield event;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        message: `对话失败：${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    if (failed) return;

    // 无工具调用：与第一章相同
    if (toolEnds.length === 0) {
      if (assistantText.length > 0) {
        this.store.appendMessage(sessionId, {
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
        });
      }
      yield { type: "done" };
      return;
    }

    // 只执行第一个
    const first = toolEnds[0];
    const ignoredNames = toolEnds.slice(1).map((t) => t.name);
    if (ignoredNames.length > 0) {
      yield { type: "tool_calls_ignored", names: ignoredNames };
    }

    const toolCalls: ToolCallRecord[] = toolEnds.map((t, idx) => ({
      id: t.id,
      name: t.name,
      arguments: t.arguments,
      ...(idx > 0 ? { ignored: true } : {}),
    }));

    this.store.appendMessage(sessionId, {
      id: randomUUID(),
      role: "assistant",
      content: assistantText,
      toolCalls,
      ...(thinkingSummary || thinkingBuf
        ? {
            thinkingSummary:
              thinkingSummary ||
              thinkingBuf.replace(/\s+/g, " ").trim().slice(0, 80),
          }
        : {}),
      createdAt: new Date().toISOString(),
    });

    // 执行第一个工具（或参数解析失败）
    const argsSummary = summarizeArgs(first.arguments);
    yield {
      type: "tool_execution_start",
      id: first.id,
      name: first.name,
      argsSummary,
    };

    let toolResult: ToolResult;
    if (first.parseError) {
      toolResult = {
        ok: false,
        content: first.parseError,
        errorCode: "parse_error",
      };
    } else {
      toolResult = await this.registry.execute(first.name, first.arguments, {
        workspaceRoot: this.workspaceRoot,
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      });
    }

    yield {
      type: "tool_execution_end",
      id: first.id,
      name: first.name,
      ok: toolResult.ok,
      resultSummary: summarizeResult(toolResult.content),
    };

    this.store.appendMessage(sessionId, {
      id: randomUUID(),
      role: "tool",
      content: toolResult.content,
      toolCallId: first.id,
      toolName: first.name,
      isError: !toolResult.ok,
      createdAt: new Date().toISOString(),
    });

    // —— 请求②：不带 tools，只收文本 ——
    const sessionAfterTool = this.store.get(sessionId);
    if (!sessionAfterTool) {
      yield { type: "error", message: `会话不存在：${sessionId}` };
      return;
    }

    let finalText = "";
    let sawForbiddenTool = false;

    try {
      for await (const event of this.provider.streamChat({
        messages: sessionAfterTool.messages,
        model: this.providerConfig.model,
        thinking,
        // 不传 tools
      })) {
        if (event.type === "text_delta") {
          finalText += event.text;
          yield event;
        } else if (
          event.type === "tool_call_start" ||
          event.type === "tool_call_args_delta" ||
          event.type === "tool_call_end"
        ) {
          sawForbiddenTool = true;
          // 不执行
        } else if (event.type === "thinking_start") {
          yield event;
        } else if (event.type === "thinking_delta") {
          yield event;
        } else if (event.type === "thinking_end") {
          yield event;
        } else if (event.type === "error") {
          yield event;
          return;
        } else if (event.type === "done") {
          break;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        message: `二次回复失败：${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    if (sawForbiddenTool) {
      const note = "（本轮已执行过工具，二次请求中的工具调用已忽略）";
      if (!finalText) finalText = note;
      else finalText += `\n${note}`;
      yield { type: "text_delta", text: `\n${note}` };
    }

    if (finalText.length > 0) {
      this.store.appendMessage(sessionId, {
        id: randomUUID(),
        role: "assistant",
        content: finalText,
        createdAt: new Date().toISOString(),
      });
    }

    yield { type: "done" };
  }
}

function summarizeArgs(args: Record<string, unknown> | string): string {
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  if (raw.length <= SUMMARY_MAX) return raw;
  return `${raw.slice(0, SUMMARY_MAX)}…`;
}

function summarizeResult(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= SUMMARY_MAX) return compact;
  return `${compact.slice(0, SUMMARY_MAX)}…`;
}
