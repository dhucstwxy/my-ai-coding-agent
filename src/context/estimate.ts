import type { ChatMessage } from "../session/types.js";
import { CHARS_PER_TOKEN } from "./constants.js";

export interface TokenEstimateState {
  anchorInputTokens: number | null;
  anchorMessageCount: number;
}

export function createEstimateState(): TokenEstimateState {
  return { anchorInputTokens: null, anchorMessageCount: 0 };
}

export function estimateChars(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessage(msg: ChatMessage): number {
  let total = estimateChars(msg.content);
  if (msg.thinkingSummary) {
    total += estimateChars(msg.thinkingSummary);
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    total += estimateChars(JSON.stringify(msg.toolCalls));
  }
  return total;
}

export function estimateMessages(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateMessage(m);
  }
  return total;
}

export function updateAnchor(
  state: TokenEstimateState,
  usageInput: number,
  messageCount: number,
): void {
  state.anchorInputTokens = usageInput;
  state.anchorMessageCount = messageCount;
}

/**
 * 有锚点则锚点 + 增量估算；无锚点或历史变短则全量估算。
 * 返回值附带是否因历史变短而回退（调用方可重置锚点）。
 */
export function estimateWithAnchor(
  messages: ChatMessage[],
  state: TokenEstimateState,
): { tokens: number; resetAnchor: boolean } {
  if (
    state.anchorInputTokens === null ||
    messages.length < state.anchorMessageCount
  ) {
    return {
      tokens: estimateMessages(messages),
      resetAnchor: state.anchorInputTokens !== null,
    };
  }
  const delta = messages.slice(state.anchorMessageCount);
  return {
    tokens: state.anchorInputTokens + estimateMessages(delta),
    resetAnchor: false,
  };
}
