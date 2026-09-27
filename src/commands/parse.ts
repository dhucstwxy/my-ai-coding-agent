import type { ParseResult } from "./types.js";

/** 解析用户输入：空 / 非命令 / 命令名+参数 */
export function parseInput(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (!trimmed.startsWith("/")) {
    return { kind: "not_command", text: trimmed };
  }

  const space = trimmed.indexOf(" ");
  if (space === -1) {
    return {
      kind: "command",
      name: trimmed.slice(1).toLowerCase(),
      args: "",
    };
  }
  return {
    kind: "command",
    name: trimmed.slice(1, space).toLowerCase(),
    args: trimmed.slice(space + 1).trim(),
  };
}
