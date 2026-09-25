import type { Session } from "./types.js";
import { truncateUnpairedTools } from "./jsonl.js";

export const TIME_GAP_HOURS = 24;

export interface RestoreResult {
  session: Session;
  truncatedTail: boolean;
  lastMessageAt: string | null;
}

export function normalizeSession(session: Session): RestoreResult {
  const { messages, truncated } = truncateUnpairedTools(session.messages);
  const lastMessageAt =
    messages.length > 0 ? messages[messages.length - 1].createdAt : null;
  return {
    session: { ...session, messages },
    truncatedTail: truncated,
    lastMessageAt,
  };
}

export function needsTimeGapReminder(
  lastMessageAt: string | null | undefined,
  now = new Date(),
): boolean {
  if (!lastMessageAt) return false;
  const t = Date.parse(lastMessageAt);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t > TIME_GAP_HOURS * 60 * 60 * 1000;
}

export function buildTimeGapReminderBody(lastMessageAt: string): string {
  return [
    "距离上一次会话活动已超过 24 小时。",
    `上次消息时间：${lastMessageAt}`,
    "请先简要确认当前任务上下文是否仍然有效，再继续动手；必要时请用户补充近况。",
  ].join("\n");
}
