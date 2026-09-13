/** 默认结果上限（字符） */
export const DEFAULT_RESULT_MAX_CHARS = 100_000;

/**
 * 截断过长文本，并标明已截断。
 */
export function truncateText(
  text: string,
  maxChars: number = DEFAULT_RESULT_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…（已截断，原文共 ${text.length} 字符）`;
}
