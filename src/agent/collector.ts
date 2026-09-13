import type { StreamEvent } from "../provider/types.js";
import type { AgentEvent, CollectedToolCall, CollectedTurn } from "./types.js";

/**
 * 双路收集：边 yield 事件给调用方，结束时 return CollectedTurn。
 */
export async function* collectStream(
  stream: AsyncIterable<StreamEvent>,
): AsyncGenerator<AgentEvent, CollectedTurn> {
  let text = "";
  let thinkingSummary: string | undefined;
  let thinkingBuf = "";
  const toolCalls: CollectedToolCall[] = [];
  let errorMessage: string | undefined;

  for await (const event of stream) {
    if (event.type === "text_delta") {
      text += event.text;
    }
    if (event.type === "thinking_delta") {
      thinkingBuf += event.text;
    }
    if (event.type === "thinking_end") {
      thinkingSummary = event.summary;
    }
    if (event.type === "tool_call_end") {
      toolCalls.push({
        id: event.id,
        name: event.name,
        arguments: event.arguments,
        ...(event.parseError ? { parseError: event.parseError } : {}),
      });
    }
    if (event.type === "error") {
      errorMessage = event.message;
      yield event;
      return buildTurn(text, toolCalls, thinkingSummary, thinkingBuf, errorMessage);
    }
    if (event.type === "done") {
      break;
    }
    yield event;
  }

  return buildTurn(text, toolCalls, thinkingSummary, thinkingBuf, errorMessage);
}

function buildTurn(
  text: string,
  toolCalls: CollectedToolCall[],
  thinkingSummary: string | undefined,
  thinkingBuf: string,
  errorMessage?: string,
): CollectedTurn {
  return {
    text,
    toolCalls,
    thinkingSummary:
      thinkingSummary ||
      (thinkingBuf
        ? thinkingBuf.replace(/\s+/g, " ").trim().slice(0, 80)
        : undefined),
    errorMessage,
  };
}
