import { randomUUID } from "node:crypto";
import type { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../session/types.js";
import {
  MESSAGE_TOOL_RESULTS_TOKENS,
  SINGLE_TOOL_RESULT_TOKENS,
  TOOL_RESULT_PREVIEW_CHARS,
  TOOL_RESULT_SPILL_MARKER,
} from "./constants.js";
import { estimateMessage } from "./estimate.js";

export interface MicroCompactResult {
  messages: ChatMessage[];
  spilledCount: number;
  changed: boolean;
}

function isAlreadySpilled(content: string): boolean {
  return content.includes(TOOL_RESULT_SPILL_MARKER);
}

function spillToolMessage(
  msg: ChatMessage,
  sessionId: string,
  store: SessionStore,
): ChatMessage {
  const resultId = msg.id || randomUUID();
  const filePath = store.writeToolResult(sessionId, resultId, msg.content);
  const preview = msg.content.slice(0, TOOL_RESULT_PREVIEW_CHARS);
  const truncated =
    msg.content.length > TOOL_RESULT_PREVIEW_CHARS ? "…" : "";
  const content = [
    `${TOOL_RESULT_SPILL_MARKER} ${filePath} -->`,
    `工具结果过大，全文已存盘。路径：${filePath}`,
    `预览：`,
    `${preview}${truncated}`,
  ].join("\n");
  return { ...msg, content };
}

/** 按助手 toolCalls 回合分组：每组为连续 tool 消息的起止下标 */
function findToolGroups(
  messages: ChatMessage[],
): Array<{ start: number; end: number }> {
  const groups: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (
      m.role === "assistant" &&
      m.toolCalls &&
      m.toolCalls.length > 0
    ) {
      const start = i + 1;
      let end = start;
      while (end < messages.length && messages[end].role === "tool") {
        end += 1;
      }
      if (end > start) {
        groups.push({ start, end: end - 1 });
      }
      i = end;
      continue;
    }
    i += 1;
  }
  return groups;
}

/**
 * 轻量预防：超大工具结果落盘，消息改为预览+路径。
 * 不写 SessionStore；由调用方 replaceMessages。
 */
export function microCompact(
  messages: ChatMessage[],
  opts: { sessionId: string; store: SessionStore },
): MicroCompactResult {
  const next = messages.map((m) => ({ ...m }));
  let spilledCount = 0;

  // F1：单条超阈值
  for (let i = 0; i < next.length; i++) {
    const m = next[i];
    if (m.role !== "tool") continue;
    if (isAlreadySpilled(m.content)) continue;
    if (estimateMessage(m) <= SINGLE_TOOL_RESULT_TOKENS) continue;
    next[i] = spillToolMessage(m, opts.sessionId, opts.store);
    spilledCount += 1;
  }

  // F2：同组合计超阈值，从大到小依次落盘
  for (const group of findToolGroups(next)) {
    for (;;) {
      let total = 0;
      const candidates: Array<{ index: number; tokens: number }> = [];
      for (let i = group.start; i <= group.end; i++) {
        const m = next[i];
        if (m.role !== "tool") continue;
        const tokens = estimateMessage(m);
        total += tokens;
        if (!isAlreadySpilled(m.content)) {
          candidates.push({ index: i, tokens });
        }
      }
      if (total <= MESSAGE_TOOL_RESULTS_TOKENS) break;
      if (candidates.length === 0) break;
      candidates.sort((a, b) => b.tokens - a.tokens);
      const pick = candidates[0];
      next[pick.index] = spillToolMessage(
        next[pick.index],
        opts.sessionId,
        opts.store,
      );
      spilledCount += 1;
    }
  }

  return {
    messages: next,
    spilledCount,
    changed: spilledCount > 0,
  };
}
