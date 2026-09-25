import type { ChatMessage } from "../session/types.js";
import {
  KEEP_RECENT_MIN_MESSAGES,
  KEEP_RECENT_TOKENS,
} from "./constants.js";
import { estimateMessage } from "./estimate.js";

export interface CompactSplit {
  older: ChatMessage[];
  recent: ChatMessage[];
}

/**
 * 从尾部保留至少 KEEP_RECENT_MIN_MESSAGES 条；
 * 若不足 KEEP_RECENT_TOKENS 则继续向左纳入，直到达标或耗尽。
 * F7：切点左侧的 user 尽量划入 recent，并避免切断 tool 配对。
 */
export function splitForCompact(messages: ChatMessage[]): CompactSplit {
  if (messages.length <= KEEP_RECENT_MIN_MESSAGES) {
    return { older: [], recent: [...messages] };
  }

  let keepStart = messages.length;
  let tokens = 0;
  let kept = 0;

  // 先保证至少 N 条
  while (keepStart > 0 && kept < KEEP_RECENT_MIN_MESSAGES) {
    keepStart -= 1;
    tokens += estimateMessage(messages[keepStart]);
    kept += 1;
  }

  // 若仍不足 10K，继续向左
  while (keepStart > 0 && tokens < KEEP_RECENT_TOKENS) {
    keepStart -= 1;
    tokens += estimateMessage(messages[keepStart]);
  }

  // F7 + tool 配对：向左扩展直到切点合法
  keepStart = expandKeepStart(messages, keepStart);

  if (keepStart <= 0) {
    return { older: [], recent: [...messages] };
  }

  return {
    older: messages.slice(0, keepStart),
    recent: messages.slice(keepStart),
  };
}

function expandKeepStart(messages: ChatMessage[], keepStart: number): number {
  let start = keepStart;
  // F7：切点左侧紧邻的一条 user → 纳入 recent（只扩一条）
  if (start > 0 && messages[start - 1].role === "user") {
    start -= 1;
  }
  // 若切点落在 tool 序列中间，向左扩到该回合的 assistant
  const beforeToolFix = start;
  if (start < messages.length && messages[start]?.role === "tool") {
    let j = start;
    while (j > 0 && messages[j].role === "tool") j -= 1;
    if (messages[j].role === "assistant") {
      start = j;
    } else {
      while (start > 0 && messages[start]?.role === "tool") start -= 1;
    }
  }
  // 仅当因 tool 配对向左扩展后，左侧又露出一条 user 时，再纳入这一条
  if (
    start < beforeToolFix &&
    start > 0 &&
    messages[start - 1].role === "user"
  ) {
    start -= 1;
  }
  return start;
}
