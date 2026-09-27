import type { CommandRegistry } from "./registry.js";
import type { CompleteResult } from "./types.js";

/**
 * Tab 补全：以 / 开头时对命令名（含别名）做前缀匹配。
 * 唯一匹配返回 single；多个返回排序候选。
 */
export function complete(
  input: string,
  registry: CommandRegistry,
): CompleteResult {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return { candidates: [] };
  }

  const afterSlash = trimmed.slice(1);
  const space = afterSlash.indexOf(" ");
  const prefix = (
    space === -1 ? afterSlash : afterSlash.slice(0, space)
  ).toLowerCase();

  const matches = registry
    .allNames()
    .filter((n) => n.startsWith(prefix));

  if (matches.length === 0) return { candidates: [] };
  if (matches.length === 1) {
    return { single: `/${matches[0]}`, candidates: [`/${matches[0]}`] };
  }
  return {
    candidates: matches.map((n) => `/${n}`),
  };
}
